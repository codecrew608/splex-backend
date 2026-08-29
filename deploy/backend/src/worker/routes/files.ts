import { getDocumentProxy, extractText } from "unpdf";
import { processFile, type PdfTextExtractor } from "../../handlers/files.js";
import type { WorkerCtx } from "../context.js";
import { asFastifyInstance } from "../context.js";
import type { AuthedUser } from "../../types/index.js";
import { respondWithResult } from "../http.js";

// The Workers-side PDF extractor. unpdf is a PDF.js build packaged
// specifically for edge/serverless runtimes (its own keywords list
// Cloudflare Workers explicitly), confirmed live via an isolated
// wrangler dev test: boots cleanly and extracts real text from a real PDF
// buffer with no canvas dependency on this call path (extractImages /
// renderPageAsImage are the only unpdf exports that touch @napi-rs/canvas
// — never imported here).
//
// pdf-parse cannot be used here at all: its PDF.js engine references the
// browser Canvas API `DOMMatrix` unconditionally at module-evaluation
// time, crashing the whole isolate at boot even behind a dynamic import.
// That is why the extractor is injected rather than shared.
const extractPdfText: PdfTextExtractor = async (buffer) => {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
};

// HTTP adapter only — behaviour lives in handlers/files.ts, shared with
// routes/files.ts apart from the injected extractor above.
export async function handleProcessFile(fileIdParam: string, ctx: WorkerCtx, user: AuthedUser): Promise<Response> {
  return respondWithResult(await processFile(asFastifyInstance(ctx), user.id, user.planTier, fileIdParam, extractPdfText));
}
