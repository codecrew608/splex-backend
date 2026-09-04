import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as mammoth from "mammoth";
import type { FileRow } from "../types/index.js";
import { ocrImage, ocrPdf, isIntelligenceConfigured, IntelligenceNotConfiguredError } from "../intelligence/client.js";
import { describeError } from "../openrouter/client.js";
import { validateOwnedStoragePath } from "../files/storagePath.js";
import { indexFileChunks } from "../intelligence/indexFile.js";
import { validateDeclaredFileType, scanZipSafety, DOCX_MIME } from "../files/contentSafety.js";
import { type HandlerResult, ok, fail } from "./result.js";

const fileIdSchema = z.string().uuid();

// A giant file shouldn't blow out every subsequent turn's context — this
// gets prepended into the user's message on every reference. file_chunks
// indexing (RAG) uses its own, much larger cap — see intelligence/chunk.ts.
const TEXT_EXTRACT_CAP = 20_000;

// Below this many extracted characters, a "PDF" is almost certainly a scan
// with no embedded text layer — worth the OCR fallback.
const SCANNED_PDF_TEXT_THRESHOLD = 30;

// Server-side per-tier size ceiling, mirroring apps/web/lib/fileLimits.ts.
//
// That cap was enforced ONLY in the browser. Combined with files_owner_all
// (an RLS policy granting the owner full CRUD), a user could insert a files
// row claiming any size_bytes they liked and upload something far larger —
// bypassing both this ceiling and the storage quota trigger, which sums the
// same self-reported column. The real defence has to measure the bytes we
// actually downloaded, which is what this does.
//
// It also bounds memory: this handler buffers the whole file, and on
// Workers an oversized download exhausts the isolate's limit and kills the
// request rather than failing cleanly.
const FILE_SIZE_LIMITS: Record<string, number> = {
  free: 5 * 1024 * 1024,
  starter: 20 * 1024 * 1024,
  pro: 50 * 1024 * 1024,
};

function sizeLimitFor(planTier: string): number {
  return FILE_SIZE_LIMITS[planTier] ?? FILE_SIZE_LIMITS.free;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
const CODE_EXTENSIONS = [
  ".js", ".ts", ".tsx", ".jsx", ".py", ".json", ".yaml", ".yml", ".sql",
  ".html", ".css", ".sh", ".go", ".rs", ".java", ".c", ".cpp", ".rb", ".php",
];

function looksLikePlainText(mimeType: string | null, filename: string): boolean {
  if (mimeType?.startsWith("text/")) return true;
  const lower = filename.toLowerCase();
  return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext)) || lower.endsWith(".md") || lower.endsWith(".csv") || lower.endsWith(".txt");
}

// THE reason this file takes the PDF extractor as a parameter instead of
// importing one.
//
// The two runtimes genuinely cannot share a PDF library. pdf-parse's
// underlying PDF.js engine references the browser Canvas API `DOMMatrix`
// unconditionally at MODULE-EVALUATION time, which crashes the entire
// Cloudflare isolate at boot — not just this route, and not avoidable with
// a dynamic import, because the failure happens while the module is being
// evaluated rather than when a function is called. The Worker therefore
// uses unpdf (a PDF.js build packaged for edge/serverless), while the
// Node/Fastify side keeps pdf-parse.
//
// So this module must NEVER import either one: a static import of
// pdf-parse here would be loaded by the Worker too and take production
// down at startup. Injecting the extractor keeps every other step —
// download, image OCR, DOCX, plain text, truncation, chunk indexing,
// status transitions — genuinely shared, while the one legitimately
// runtime-specific step stays with its runtime.
export type PdfTextExtractor = (buffer: Buffer) => Promise<string>;

// Best-effort: chunk + embed the file's extracted text into file_chunks so
// it becomes searchable via RAG in later conversations. Never fails the
// upload — a file that fails to index is still usable as a direct chat
// attachment via files.extracted_text.
async function tryIndexChunks(fastify: FastifyInstance, fileId: string, text: string): Promise<void> {
  // Skip before attempting: indexing needs embeddings, and without the
  // sidecar every call would throw on a path that cannot succeed in this
  // environment — noise that masked the real cause.
  if (!isIntelligenceConfigured(fastify)) {
    fastify.log.warn({ fileId, capability: "rag_indexing" }, "chunk indexing skipped — intelligence service not configured");
    return;
  }
  try {
    await indexFileChunks(fastify, fileId, text);
  } catch (err) {
    fastify.log.error({ ...describeError(err), fileId }, "file chunk indexing failed against a configured service");
  }
}

// Re-checks the plan's total storage allowance against REAL sizes, after the
// object exists. enforce_file_limits() (migration 0011) does the same sum at
// INSERT time, but at that point size_bytes is only what the client declared.
// Returns ok:true when the plan has no storage cap configured, matching the
// trigger's own "null limit means unlimited" semantics for this counter.
async function checkStorageQuota(
  fastify: FastifyInstance,
  userId: string,
  planTier: string,
  fileId: string,
): Promise<{ ok: boolean; usedBytes?: number; limitBytes?: number }> {
  const { data: limitRow } = await fastify.supabaseAdmin
    .from("plan_limits")
    .select("limit_amount")
    .eq("plan_tier", planTier)
    .eq("counter_type", "storage_bytes")
    .maybeSingle();

  const limitBytes = limitRow?.limit_amount as number | null | undefined;
  if (limitBytes === null || limitBytes === undefined) return { ok: true };

  const { data: rows, error } = await fastify.supabaseAdmin
    .from("files")
    .select("size_bytes")
    .eq("user_id", userId);

  if (error || !rows) {
    // Fail OPEN on a lookup failure: the file is already uploaded and the
    // INSERT trigger already applied its own check, so refusing here would
    // punish the user for a transient database problem.
    fastify.log.warn({ error, userId, fileId }, "storage quota re-check failed — allowing (insert-time trigger already applied)");
    return { ok: true };
  }

  const usedBytes = rows.reduce((sum, r) => sum + Number((r as { size_bytes: number }).size_bytes ?? 0), 0);
  return { ok: usedBytes <= limitBytes, usedBytes, limitBytes };
}

export async function processFile(
  fastify: FastifyInstance,
  userId: string,
  planTier: string,
  rawFileId: string,
  extractPdfText: PdfTextExtractor,
): Promise<HandlerResult<{ processingStatus: string }>> {
  const parsed = fileIdSchema.safeParse(rawFileId);
  if (!parsed.success) return fail("Invalid file id.", 400);

  const { data: fileData, error } = await fastify.supabaseAdmin
    .from("files")
    .select("*")
    .eq("id", parsed.data)
    .eq("user_id", userId)
    .single();

  if (error || !fileData) return fail("File not found.", 404);
  const file = fileData as FileRow;

  // AUTHORIZATION GATE — must run before ANY service-role Storage call.
  //
  // The row's user_id was already checked above, but that only proves the
  // ROW is the caller's; storage_path is a separate value that was
  // client-writable, and the download below uses the service-role client,
  // which bypasses Storage RLS entirely. Without this, a user could point
  // their own row at another user's object and have the backend fetch it.
  //
  // Deliberately placed before the "extracting" status write too, so a
  // rejected request leaves no trace of progress and does no work at all.
  const pathCheck = validateOwnedStoragePath(userId, file.id, file.storage_path);
  if (!pathCheck.ok) {
    fastify.log.error(
      { fileId: file.id, userId, reason: pathCheck.reason },
      "refused privileged storage read: storage_path is not inside the caller's namespace",
    );
    // Same 404 the not-found branch returns — a mismatched path must not
    // reveal whether the referenced object exists.
    return fail("File not found.", 404);
  }

  await fastify.supabaseAdmin.from("files").update({ processing_status: "extracting" }).eq("id", file.id);

  const { data: downloaded, error: downloadError } = await fastify.supabaseAdmin.storage
    .from("uploads")
    .download(file.storage_path);

  if (downloadError || !downloaded) {
    fastify.log.error({ downloadError }, "file download from storage failed");
    await fastify.supabaseAdmin
      .from("files")
      .update({ processing_status: "failed", error_message: "Could not read the uploaded file." })
      .eq("id", file.id);
    return fail("Could not read the uploaded file.", 500);
  }

  const buffer = Buffer.from(await downloaded.arrayBuffer());

  // Measured from what was really downloaded, never from the client-supplied
  // files.size_bytes column — that column is writable by the owner and is
  // exactly what a bypass would falsify.
  const sizeLimit = sizeLimitFor(planTier);
  if (buffer.byteLength > sizeLimit) {
    fastify.log.warn(
      { fileId: file.id, actualBytes: buffer.byteLength, claimedBytes: file.size_bytes, sizeLimit, planTier },
      "file exceeds the plan size limit on the server side — rejecting",
    );
    await fastify.supabaseAdmin
      .from("files")
      .update({ processing_status: "failed", error_message: `File exceeds your plan's ${formatBytes(sizeLimit)} limit.` })
      .eq("id", file.id);
    return fail(`File exceeds your plan's ${formatBytes(sizeLimit)} limit.`, 413);
  }

  // FIX (file-type hardening — production completion pass): mime_type is
  // 100% client-declared and, until now, was never checked against the
  // bytes actually downloaded above. Every extraction branch below keys
  // off file.mime_type, so a mismatch is caught once, here, before any of
  // them run — rather than letting a relabeled upload pick which parser
  // handles it (see contentSafety.ts's own doc comment for the full
  // reasoning).
  const typeCheck = validateDeclaredFileType({
    buffer,
    mimeType: file.mime_type,
    looksLikeTextClaim: looksLikePlainText(file.mime_type, file.filename),
  });
  if (!typeCheck.ok) {
    fastify.log.warn(
      { fileId: file.id, claimedMimeType: file.mime_type, reason: typeCheck.reason },
      "uploaded file content did not match its declared type — rejecting",
    );
    await fastify.supabaseAdmin
      .from("files")
      .update({ processing_status: "failed", error_message: "This file's content doesn't match its type and can't be processed." })
      .eq("id", file.id);
    // Deliberately not the sniffed/expected type detail — see
    // validateOwnedStoragePath's own doc comment above for why this file
    // is careful about what a rejection reveals; here the reason is
    // internal diagnostic detail, not an existence leak, but there's still
    // no product reason to teach a client what a server-side sniffer
    // checks for.
    return fail("This file's content doesn't match its type and can't be processed.", 422);
  }

  // Record the TRUE size, measured from the downloaded object.
  //
  // size_bytes is what enforce_file_limits() sums for the storage quota, and
  // it was client-supplied — so a false value understated the user's usage
  // permanently. Migration 0028 stops the client writing it (default 0), and
  // this is where the real figure lands. Writing it before the quota check
  // below means the check sees truth for this file and every prior one.
  if (file.size_bytes !== buffer.byteLength) {
    await fastify.supabaseAdmin.from("files").update({ size_bytes: buffer.byteLength }).eq("id", file.id);
  }

  // Storage quota, enforced here rather than only in the INSERT trigger.
  // The trigger runs before the object exists, when the only size available
  // is whatever the client claimed; this runs once the real bytes are known.
  const quota = await checkStorageQuota(fastify, userId, planTier, file.id);
  if (!quota.ok) {
    fastify.log.warn({ fileId: file.id, userId, planTier, ...quota }, "storage quota exceeded on measured bytes");
    await fastify.supabaseAdmin
      .from("files")
      .update({ processing_status: "failed", error_message: "You've hit your plan's storage limit." })
      .eq("id", file.id);
    return fail("You've hit your plan's storage limit.", 413);
  }

  if (file.mime_type?.startsWith("image/")) {
    // Vision handling happens at chat-time (base64 data URI straight into
    // the OpenRouter message) — the image itself is never text-extracted for
    // that path. OCR here is purely to make the image's text content
    // searchable via RAG in *other* conversations later on. Best-effort: an
    // OCR failure must never block the image from being usable as a vision
    // attachment, so it still lands on "ready" either way.
    await fastify.supabaseAdmin.from("files").update({ processing_status: "ocr_processing" }).eq("id", file.id);
    let ocrText = "";
    try {
      ocrText = await ocrImage(fastify, buffer);
    } catch (err) {
      if (err instanceof IntelligenceNotConfiguredError) {
        // A deployment gap, not a fault. Logged distinctly so it can never
        // again be mistaken for a provider error — which is exactly how it
        // read in production, where OCR is simply not deployed.
        fastify.log.warn(
          { fileId: file.id, capability: "image_ocr" },
          "image OCR skipped — intelligence service not configured in this environment",
        );
      } else {
        fastify.log.error({ ...describeError(err), fileId: file.id }, "image OCR failed against a configured service");
      }
    }
    const truncated = ocrText.length > TEXT_EXTRACT_CAP ? ocrText.slice(0, TEXT_EXTRACT_CAP) : ocrText;

    if (ocrText.trim()) {
      await fastify.supabaseAdmin
        .from("files")
        .update({ processing_status: "embedding", extracted_text: truncated })
        .eq("id", file.id);
      await tryIndexChunks(fastify, file.id, ocrText);
    }

    await fastify.supabaseAdmin
      .from("files")
      .update({ processing_status: "ready", extracted_text: truncated || null })
      .eq("id", file.id);
    return ok({ processingStatus: "ready" });
  }

  let extractedText: string | null = null;
  let failReason: string | null = null;

  try {
    if (file.mime_type === "application/pdf") {
      extractedText = await extractPdfText(buffer);
      // A near-empty text layer means this is a scanned PDF (images of
      // pages, no embedded text) — fall back to rendering pages and OCR'ing.
      if (extractedText.trim().length < SCANNED_PDF_TEXT_THRESHOLD) {
        await fastify.supabaseAdmin.from("files").update({ processing_status: "ocr_processing" }).eq("id", file.id);
        try {
          const ocrText = await ocrPdf(fastify, buffer);
          if (ocrText.trim().length > extractedText.trim().length) extractedText = ocrText;
        } catch (err) {
          if (err instanceof IntelligenceNotConfiguredError) {
            fastify.log.warn(
              { fileId: file.id, capability: "pdf_ocr" },
              "scanned-PDF OCR skipped — intelligence service not configured in this environment",
            );
          } else {
            fastify.log.error(
              { ...describeError(err), fileId: file.id },
              "scanned-PDF OCR failed against a configured service",
            );
          }
        }
      }
    } else if (file.mime_type === DOCX_MIME) {
      // FIX (ZIP decompression-bomb hardening — production completion
      // pass): DOCX is a zip container, and mammoth decompresses it via a
      // real zip library — a crafted archive with an extreme compression
      // ratio could exhaust memory/CPU before mammoth ever returns. This
      // reads only the archive's central directory (entry names + declared
      // sizes, no decompression) and runs BEFORE the real, expensive parse
      // — see contentSafety.ts's own doc comment for the exact limits.
      const zipSafety = scanZipSafety(buffer);
      if (!zipSafety.ok) {
        fastify.log.warn({ fileId: file.id, reason: zipSafety.reason }, "docx failed pre-extraction zip safety scan — rejecting");
        failReason = "This document couldn't be safely processed.";
      } else {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value;
      }
    } else if (looksLikePlainText(file.mime_type, file.filename)) {
      extractedText = buffer.toString("utf-8");
    } else {
      failReason = `Unsupported file type for text extraction: ${file.mime_type ?? file.file_type}`;
    }
  } catch (err) {
    fastify.log.error({ err }, "file text extraction failed");
    failReason = "Could not extract text from this file.";
  }

  if (failReason || extractedText === null) {
    await fastify.supabaseAdmin
      .from("files")
      .update({ processing_status: "failed", error_message: failReason ?? "Extraction failed." })
      .eq("id", file.id);
    return fail(failReason ?? "Extraction failed.", 422);
  }

  const truncated = extractedText.length > TEXT_EXTRACT_CAP ? extractedText.slice(0, TEXT_EXTRACT_CAP) : extractedText;

  if (extractedText.trim()) {
    await fastify.supabaseAdmin
      .from("files")
      .update({ processing_status: "embedding", extracted_text: truncated, error_message: null })
      .eq("id", file.id);
    await tryIndexChunks(fastify, file.id, extractedText);
  }

  await fastify.supabaseAdmin
    .from("files")
    .update({ processing_status: "ready", extracted_text: truncated, error_message: null })
    .eq("id", file.id);

  return ok({ processingStatus: "ready" });
}
