import type { FastifyInstance } from "fastify";
import type { FileRow } from "../types/index.js";

// Never trust client-supplied file ownership — always re-scope to the
// caller. Silently drops any id that doesn't belong to the user or isn't
// ready yet, rather than erroring the whole request over one bad id.
export async function fetchOwnedFiles(fastify: FastifyInstance, userId: string, fileIds: string[]): Promise<FileRow[]> {
  if (fileIds.length === 0) return [];

  const { data, error } = await fastify.supabaseAdmin
    .from("files")
    .select("*")
    .in("id", fileIds)
    .eq("user_id", userId)
    .eq("processing_status", "ready");

  if (error || !data) return [];
  return data as FileRow[];
}

export async function buildImageDataUri(fastify: FastifyInstance, file: FileRow): Promise<string | null> {
  const { data, error } = await fastify.supabaseAdmin.storage.from("uploads").download(file.storage_path);
  if (error || !data) {
    fastify.log.error({ error, fileId: file.id }, "failed to download image attachment for vision call");
    return null;
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  const mime = file.mime_type ?? "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

const ATTACHMENT_TEXT_CAP = 20_000;

// Concatenates extracted text from every non-image attachment into one
// clearly-delimited block, prepended to the user's own message text before
// it's persisted — history stays plain-text/human-readable, and the model
// gets full context on every reference without any special-casing at the
// OpenRouter-usage-accounting layer (it's just more prompt text).
export function buildAttachmentTextBlock(files: FileRow[]): string {
  const textFiles = files.filter((f) => !f.mime_type?.startsWith("image/") && f.extracted_text);
  if (textFiles.length === 0) return "";

  return textFiles
    .map((f) => {
      const text = (f.extracted_text ?? "").slice(0, ATTACHMENT_TEXT_CAP);
      return `\n\n[Attached file: ${f.filename}]\n${text}\n[End of attached file]\n\n`;
    })
    .join("");
}

// Records which message a file was attached to — display metadata only
// (MessageBubble renders a chip per attachment on reload), never how the
// model actually receives the content: that still goes through
// buildAttachmentTextBlock/buildImageDataUri, injected into the CURRENT
// turn's completion call in-memory (see runChat), same as before this
// function existed. Column-level grants (migration 0028) already keep
// authenticated clients from writing message_id themselves — this is the
// only path that sets it, and only after fetchOwnedFiles has already
// re-scoped the ids to the caller's own files.
export async function linkFilesToMessage(fastify: FastifyInstance, fileIds: string[], messageId: string): Promise<void> {
  if (fileIds.length === 0) return;
  const { error } = await fastify.supabaseAdmin.from("files").update({ message_id: messageId }).in("id", fileIds);
  if (error) {
    // Best-effort — never block sending the message over a display-only
    // metadata write. Worst case the attachment chip just doesn't show up
    // on a later reload; the model still received the content this turn.
    fastify.log.error({ error, messageId, fileIds }, "failed to link attachments to message");
  }
}
