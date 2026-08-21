import { Container, getContainer } from "@cloudflare/containers";

// Fronts the Dockerized Fastify server (this folder's Dockerfile, built
// unchanged) behind a Durable Object. Deliberately does nothing else —
// no auth, no routing logic, no request rewriting — Fastify's own CORS,
// auth, and rate-limit plugins run exactly as they do today, inside the
// container. container.fetch() proxies the request/response verbatim,
// including chunked/streamed bodies, which is what SSE (fastify-sse-v2)
// needs to keep working unmodified.
export class SplexBackendContainer extends Container {
  defaultPort = 4000;
  // SSE connections (chat streaming, Deep Research) are long-lived —
  // don't let Cloudflare recycle the instance mid-stream on ordinary
  // idle-timeout defaults.
  sleepAfter = "10m";
}

interface Env {
  SPLEX_BACKEND: DurableObjectNamespace<SplexBackendContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.SPLEX_BACKEND);
    return container.fetch(request);
  },
};
