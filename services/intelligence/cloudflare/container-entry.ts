import { Container, getContainer } from "@cloudflare/containers";

// Fronts the existing OCR/embedding Dockerfile (Tesseract + torch +
// sentence-transformers, unchanged) behind a Durable Object. Proxies
// verbatim, same reasoning as the backend's container-entry.ts — this
// file adds no auth of its own. Staying unreachable is enforced by
// wrangler.jsonc (workers_dev: false, no routes), not by anything here;
// that config is the actual privacy boundary.
export class SplexIntelligenceContainer extends Container {
  defaultPort = 8100;
  sleepAfter = "5m";
}

interface Env {
  SPLEX_INTELLIGENCE: DurableObjectNamespace<SplexIntelligenceContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.SPLEX_INTELLIGENCE);
    return container.fetch(request);
  },
};
