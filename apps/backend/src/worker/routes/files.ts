import { z } from "zod";
import * as mammoth from "mammoth";
import { getDocumentProxy, extractText } from "unpdf";
import { ocrImage, ocrPdf } from "../../intelligence/client.js";
import { indexFileChunks } from "../../intelligence/indexFile.js";
import type { FileRow } from "../../types/index.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { jsonResponse, errorResponse } from "../http.js";

const fileIdSchema = z.string().uuid();

const TEXT_EXTRACT_CAP = 20_000;
const SCANNED_PDF_TEXT_THRESHOLD = 30;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const CODE_EXTENSIONS = [
  ".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".rb", ".php", ".json", ".yaml", ".yml", ".md", ".sh", ".sql", ".css", ".html",
];

function looksLikePlainText(mimeType: string | null, filename: string): boolean {
  if (mimeType?.startsWith("text/")) return true;
  const lower = filename.toLowerCase();
  return CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function tryIndexChunks(ctx: WorkerCtx, fileId: string, text: string): Promise<void> {
  try {
    await indexFileChunks(asFastifyInstance(ctx), fileId, text);
  } catch (err) {
    ctx.log.warn({ err, fileId }, "file_chunks indexing failed — non-fatal, extracted_text still saved");
  }
}

// Direct port of routes/files.ts's POST /files/:fileId/process. Same
// extraction logic, same OCR-fallback rules, same non-fatal-on-OCR-failure
// posture — see the migration audit's Q12 for what happens when the
// intelligence sidecar (ocrImage/ocrPdf) is unreachable: both calls are
// already wrapped in try/catch here exactly as in the original, so a
// missing sidecar degrades gracefully (searchable PDFs/DOCX still extract
// via pdf-parse/mammoth, which don't call the sidecar at all).
export async function handleProcessFile(fileIdParam: string, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  const parsedId = fileIdSchema.safeParse(fileIdParam);
  if (!parsedId.success) {
    return errorResponse("Invalid file id.", 400);
  }
  const fileId = parsedId.data;

  const { data: fileData, error } = await ctx.supabaseAdmin
    .from("files")
    .select("*")
    .eq("id", fileId)
    .eq("user_id", user.id)
    .single();

  if (error || !fileData) {
    return errorResponse("File not found.", 404);
  }
  const file = fileData as FileRow;

  await ctx.supabaseAdmin.from("files").update({ processing_status: "extracting" }).eq("id", file.id);

  const { data: downloaded, error: downloadError } = await ctx.supabaseAdmin.storage
    .from("uploads")
    .download(file.storage_path);

  if (downloadError || !downloaded) {
    ctx.log.error({ downloadError }, "file download from storage failed");
    await ctx.supabaseAdmin
      .from("files")
      .update({ processing_status: "failed", error_message: "Could not read the uploaded file." })
      .eq("id", file.id);
    return errorResponse("Could not read the uploaded file.", 500);
  }

  const buffer = Buffer.from(await downloaded.arrayBuffer());

  if (file.mime_type?.startsWith("image/")) {
    await ctx.supabaseAdmin.from("files").update({ processing_status: "ocr_processing" }).eq("id", file.id);
    let ocrText = "";
    try {
      ocrText = await ocrImage(asFastifyInstance(ctx), buffer);
    } catch (err) {
      ctx.log.warn({ err, fileId: file.id }, "image OCR failed — non-fatal, vision attachment still works");
    }
    const truncated = ocrText.length > TEXT_EXTRACT_CAP ? ocrText.slice(0, TEXT_EXTRACT_CAP) : ocrText;

    if (ocrText.trim()) {
      await ctx.supabaseAdmin
        .from("files")
        .update({ processing_status: "embedding", extracted_text: truncated })
        .eq("id", file.id);
      await tryIndexChunks(ctx, file.id, ocrText);
    }

    await ctx.supabaseAdmin
      .from("files")
      .update({ processing_status: "ready", extracted_text: truncated || null })
      .eq("id", file.id);
    return jsonResponse({ processingStatus: "ready" });
  }

  let extractedText: string | null = null;
  let failReason: string | null = null;

  try {
    if (file.mime_type === "application/pdf") {
      // pdf-parse cannot run on Workers at all — confirmed live via
      // wrangler dev that its underlying PDF.js engine references the
      // browser Canvas API `DOMMatrix` unconditionally at module-evaluation
      // time, which crashes the entire isolate at boot (not just this
      // route) even behind a dynamic import, since the failure is in
      // module evaluation itself, not in any function call. Replaced with
      // unpdf — a PDF.js build packaged specifically for edge/serverless
      // runtimes (its own keywords list Cloudflare Workers explicitly),
      // confirmed live via an isolated wrangler dev test: boots cleanly
      // and extracts real text from a real PDF buffer with no canvas
      // dependency on this call path (extractImages/renderPageAsImage are
      // the only unpdf exports that touch @napi-rs/canvas — never
      // imported here). Same output contract as before: a single string.
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      extractedText = text;
      if (extractedText.trim().length < SCANNED_PDF_TEXT_THRESHOLD) {
        await ctx.supabaseAdmin.from("files").update({ processing_status: "ocr_processing" }).eq("id", file.id);
        try {
          const ocrText = await ocrPdf(asFastifyInstance(ctx), buffer);
          if (ocrText.trim().length > extractedText.trim().length) extractedText = ocrText;
        } catch (err) {
          ctx.log.warn({ err, fileId: file.id }, "scanned-PDF OCR fallback failed, keeping unpdf output");
        }
      }
    } else if (file.mime_type === DOCX_MIME) {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (looksLikePlainText(file.mime_type, file.filename)) {
      extractedText = buffer.toString("utf-8");
    } else {
      failReason = `Unsupported file type for text extraction: ${file.mime_type ?? file.file_type}`;
    }
  } catch (err) {
    ctx.log.error({ err }, "file text extraction failed");
    failReason = "Could not extract text from this file.";
  }

  if (failReason || extractedText === null) {
    await ctx.supabaseAdmin
      .from("files")
      .update({ processing_status: "failed", error_message: failReason ?? "Extraction failed." })
      .eq("id", file.id);
    return errorResponse(failReason ?? "Extraction failed.", 422);
  }

  const truncated = extractedText.length > TEXT_EXTRACT_CAP ? extractedText.slice(0, TEXT_EXTRACT_CAP) : extractedText;

  if (extractedText.trim()) {
    await ctx.supabaseAdmin
      .from("files")
      .update({ processing_status: "embedding", extracted_text: truncated, error_message: null })
      .eq("id", file.id);
    await tryIndexChunks(ctx, file.id, extractedText);
  }

  await ctx.supabaseAdmin
    .from("files")
    .update({ processing_status: "ready", extracted_text: truncated, error_message: null })
    .eq("id", file.id);

  return jsonResponse({ processingStatus: "ready" });
}
