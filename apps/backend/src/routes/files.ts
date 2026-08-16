import type { FastifyPluginAsync, FastifyInstance } from "fastify";
import { z } from "zod";
import { PDFParse } from "pdf-parse";
import * as mammoth from "mammoth";
import type { FileRow } from "../types/index.js";
import { ocrImage, ocrPdf } from "../intelligence/client.js";
import { indexFileChunks } from "../intelligence/indexFile.js";

const paramsSchema = z.object({ fileId: z.string().uuid() });

// A giant file shouldn't blow out every subsequent turn's context — this
// gets prepended into the user's message on every reference. file_chunks
// indexing (RAG) uses its own, much larger cap — see intelligence/chunk.ts.
const TEXT_EXTRACT_CAP = 20_000;

// Below this many extracted characters, a "PDF" is almost certainly a scan
// with no embedded text layer — worth the OCR fallback.
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

// Best-effort: chunk + embed the file's extracted text into file_chunks so
// it becomes searchable via RAG in later conversations. Never fails the
// upload — a file that fails to index is still usable as a direct chat
// attachment via files.extracted_text.
async function tryIndexChunks(fastify: FastifyInstance, fileId: string, text: string): Promise<void> {
  try {
    await indexFileChunks(fastify, fileId, text);
  } catch (err) {
    fastify.log.warn({ err, fileId }, "file_chunks indexing failed — non-fatal, extracted_text still saved");
  }
}

const filesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/files/:fileId/process", { preHandler: fastify.authenticate }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ message: "Invalid file id." });
    }

    const { data: fileData, error } = await fastify.supabaseAdmin
      .from("files")
      .select("*")
      .eq("id", params.data.fileId)
      .eq("user_id", request.user.id)
      .single();

    if (error || !fileData) {
      return reply.code(404).send({ message: "File not found." });
    }
    const file = fileData as FileRow;

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
      return reply.code(500).send({ message: "Could not read the uploaded file." });
    }

    const buffer = Buffer.from(await downloaded.arrayBuffer());

    if (file.mime_type?.startsWith("image/")) {
      // Vision handling happens at chat-time (base64 data URI straight into
      // the OpenRouter message) — the image itself is never text-extracted
      // for that path. OCR here is purely to make the image's text content
      // searchable via RAG in *other* conversations later on. Best-effort:
      // an OCR failure must never block the image from being usable as a
      // vision attachment, so it still lands on "ready" either way.
      await fastify.supabaseAdmin.from("files").update({ processing_status: "ocr_processing" }).eq("id", file.id);
      let ocrText = "";
      try {
        ocrText = await ocrImage(fastify, buffer);
      } catch (err) {
        fastify.log.warn({ err, fileId: file.id }, "image OCR failed — non-fatal, vision attachment still works");
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
      return reply.send({ processingStatus: "ready" });
    }

    let extractedText: string | null = null;
    let failReason: string | null = null;

    try {
      if (file.mime_type === "application/pdf") {
        const parser = new PDFParse({ data: buffer });
        const result = await parser.getText();
        await parser.destroy();
        extractedText = result.text;
        // A near-empty text layer means this is a scanned PDF (images of
        // pages, no embedded text) — fall back to rendering pages and OCR'ing.
        if (extractedText.trim().length < SCANNED_PDF_TEXT_THRESHOLD) {
          await fastify.supabaseAdmin.from("files").update({ processing_status: "ocr_processing" }).eq("id", file.id);
          try {
            const ocrText = await ocrPdf(fastify, buffer);
            if (ocrText.trim().length > extractedText.trim().length) extractedText = ocrText;
          } catch (err) {
            fastify.log.warn({ err, fileId: file.id }, "scanned-PDF OCR fallback failed, keeping pdf-parse output");
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
      fastify.log.error({ err }, "file text extraction failed");
      failReason = "Could not extract text from this file.";
    }

    if (failReason || extractedText === null) {
      await fastify.supabaseAdmin
        .from("files")
        .update({ processing_status: "failed", error_message: failReason ?? "Extraction failed." })
        .eq("id", file.id);
      return reply.code(422).send({ message: failReason ?? "Extraction failed." });
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

    return reply.send({ processingStatus: "ready" });
  });
};

export default filesRoutes;
