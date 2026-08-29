import type { FastifyPluginAsync } from "fastify";
import { PDFParse } from "pdf-parse";
import { processFile, type PdfTextExtractor } from "../handlers/files.js";
import { RATE_LIMITS } from "../handlers/rateLimits.js";
import { sendResult } from "./sendResult.js";

// The Node-side PDF extractor. Kept HERE rather than in handlers/files.ts
// because importing pdf-parse from a shared module would load it in the
// Worker too, and its PDF.js engine crashes a Cloudflare isolate at
// module-evaluation time — see handlers/files.ts's PdfTextExtractor comment.
const extractPdfText: PdfTextExtractor = async (buffer) => {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    // Previously only ran on the success path, leaking the parser's
    // resources whenever getText() threw.
    await parser.destroy();
  }
};

// HTTP adapter only. Behaviour lives in handlers/files.ts, shared with the
// Worker entry point apart from the injected PDF extractor above.
//
// OCR/embedding is real compute cost on the intelligence sidecar (spec:
// media/file processing needs stricter protection than a plain read).
const filesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/files/:fileId/process",
    {
      preHandler: [
        fastify.authenticate,
        fastify.rateLimitByUser("files_process", RATE_LIMITS.files_process.max, RATE_LIMITS.files_process.windowMs),
      ],
    },
    async (request, reply) => {
      const { fileId } = request.params as { fileId: string };
      return sendResult(reply, await processFile(fastify, request.user.id, request.user.planTier, fileId, extractPdfText));
    },
  );
};

export default filesRoutes;
