import { describe, it, expect, vi, afterEach } from "vitest";
import { embedTexts, ocrImage, ocrPdf } from "../src/intelligence/client.js";

// Runtime verification, not source-grep: the intelligence sidecar
// (services/intelligence/main.py) now refuses to start unauthenticated on
// any non-loopback host and requires a bearer token on every endpoint but
// /health. That's only a real fix if the backend client actually sends the
// token — a source-text assertion that the word "authHeaders" appears
// somewhere wouldn't catch a header built but never attached, or attached
// under the wrong key. Capturing the literal fetch() call the client makes
// is the only thing that proves it.

function fakeFastify(config: Record<string, unknown>) {
  return { config } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intelligence client sends the sidecar's required auth header", () => {
  it("embedTexts attaches Authorization: Bearer <token> when configured", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
      }),
    );

    const fastify = fakeFastify({
      INTELLIGENCE_SERVICE_URL: "https://intel.example.com",
      INTELLIGENCE_SERVICE_TOKEN: "s3cret-token",
    });
    await embedTexts(fastify, ["hello"]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://intel.example.com/embed");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer s3cret-token");
  });

  it("ocrImage and ocrPdf attach the same header, with an OCR-scale timeout", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ text: "hi", pages: 1 }), { status: 200 });
      }),
    );

    const fastify = fakeFastify({
      INTELLIGENCE_SERVICE_URL: "https://intel.example.com",
      INTELLIGENCE_SERVICE_TOKEN: "s3cret-token",
    });
    await ocrImage(fastify, Buffer.from("fake-bytes"));
    await ocrPdf(fastify, Buffer.from("fake-bytes"));

    expect(calls).toHaveLength(2);
    for (const [i, path] of ["/ocr/image", "/ocr/pdf"].entries()) {
      expect(calls[i].url).toBe(`https://intel.example.com${path}`);
      const headers = new Headers(calls[i].init.headers);
      expect(headers.get("Authorization")).toBe("Bearer s3cret-token");
      // A signal must be present at all — the earlier bug was having none,
      // which let a wedged sidecar hang the upload path indefinitely.
      expect(calls[i].init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("sends no Authorization header when no token is configured (loopback local dev)", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ init });
        return new Response(JSON.stringify({ embeddings: [[0]] }), { status: 200 });
      }),
    );

    const fastify = fakeFastify({ INTELLIGENCE_SERVICE_URL: "http://127.0.0.1:8100" });
    await embedTexts(fastify, ["hello"]);

    const headers = new Headers(calls[0].init.headers);
    expect(headers.has("Authorization")).toBe(false);
  });
});
