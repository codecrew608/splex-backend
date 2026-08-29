import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storeGeneratedMedia } from "../src/media/storage.js";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// Generated media (image/audio/PPT) is handed to the browser as a
// long-lived signed URL embedded directly in the assistant message, because
// an <img src> cannot carry an Authorization header. That's a deliberate
// tradeoff (see media/storage.ts's own comment) — these tests pin the
// properties that make it a bounded one rather than an open door.

function fakeStorage() {
  const uploads: Array<{ path: string; contentType: string }> = [];
  const signed: Array<{ path: string; ttl: number }> = [];
  const fastify = {
    supabaseAdmin: {
      storage: {
        from: (_bucket: string) => ({
          upload: vi.fn(async (path: string, _bytes: Buffer, opts: { contentType: string }) => {
            uploads.push({ path, contentType: opts.contentType });
            return { error: null };
          }),
          createSignedUrl: vi.fn(async (path: string, ttl: number) => {
            signed.push({ path, ttl });
            return { data: { signedUrl: `https://storage.example.com/${path}?token=sig` }, error: null };
          }),
        }),
      },
    },
  } as never;
  return { fastify, uploads, signed };
}

beforeEach(() => vi.clearAllMocks());

describe("generated media is namespaced per user and unguessable", () => {
  it("writes under generated/<userId>/<uuid> — never a shared or user-controlled path", async () => {
    const { fastify, uploads } = fakeStorage();
    await storeGeneratedMedia(fastify, "user-aaa", Buffer.from("x"), "image/png", "png");

    expect(uploads).toHaveLength(1);
    // A v4 UUID filename: an attacker holding one user's URL learns nothing
    // that helps them construct another's.
    expect(uploads[0].path).toMatch(
      /^generated\/user-aaa\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/,
    );
  });

  it("two users' media never share a prefix", async () => {
    const { fastify, uploads } = fakeStorage();
    await storeGeneratedMedia(fastify, "user-aaa", Buffer.from("x"), "image/png", "png");
    await storeGeneratedMedia(fastify, "user-bbb", Buffer.from("x"), "image/png", "png");

    expect(uploads[0].path.startsWith("generated/user-aaa/")).toBe(true);
    expect(uploads[1].path.startsWith("generated/user-bbb/")).toBe(true);
    expect(uploads[0].path.split("/")[1]).not.toBe(uploads[1].path.split("/")[1]);
  });

  it("the signature is scoped to the single object just written, never a prefix or bucket", async () => {
    const { fastify, uploads, signed } = fakeStorage();
    await storeGeneratedMedia(fastify, "user-aaa", Buffer.from("x"), "image/png", "png");

    expect(signed).toHaveLength(1);
    // Signing exactly the uploaded key is what stops a URL from being
    // widened into a directory listing of that user's — or anyone's — media.
    expect(signed[0].path).toBe(uploads[0].path);
    expect(signed[0].path).not.toMatch(/\*|\/$/);
  });
});

describe("signed-URL lifetimes are the intended ones, per capability", () => {
  it("video is short-lived BECAUSE it is re-signed on every status poll", () => {
    const src = read("handlers/media.ts");
    expect(src).toContain("const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;");
    // The property that makes 7 days safe: a fresh URL is minted from the
    // stored path on each poll, so expiry costs a re-poll, not access.
    expect(src).toContain("createSignedUrl(media.storage_path, SIGNED_URL_TTL_SECONDS)");
    expect(src).toContain("getOwnedGeneratedMedia(fastify, userId, parsed.data)");
  });

  it("image/audio/PPT stay long-lived, and the reason is recorded rather than assumed", () => {
    const src = read("media/storage.ts");
    expect(src).toContain("const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365;");
    // Guards against someone "hardening" this to match video without
    // realising it would break images in existing conversations.
    expect(src).toMatch(/cannot carry an\s*\/\/ Authorization header/);
    expect(src).toContain("splex-media:<id>"); // the documented forward path
  });

  it("only the privileged client can mint a URL — no anon/user-scoped signing path exists", () => {
    const src = read("media/storage.ts");
    expect(src).toContain("fastify.supabaseAdmin.storage");
    expect(src).not.toMatch(/createClient\(|anonKey|SUPABASE_ANON_KEY/);
  });
});
