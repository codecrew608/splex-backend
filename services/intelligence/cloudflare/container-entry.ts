import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  SPLEX_INTELLIGENCE: DurableObjectNamespace<SplexIntelligenceContainer>;
  // Worker secret — `wrangler secret put INTELLIGENCE_SERVICE_TOKEN`, run
  // from this directory. NOT declared under wrangler.jsonc's "vars" (that
  // block is committed, non-secret config; see its comment).
  INTELLIGENCE_SERVICE_TOKEN?: string;
}

// Fronts the existing OCR/embedding Dockerfile (Tesseract + torch +
// sentence-transformers, unchanged) behind a Durable Object.
//
// main.py refuses to start on HOST=0.0.0.0 without INTELLIGENCE_SERVICE_TOKEN
// (see its startup guard) — that's the actual auth boundary, enforced
// inside the container regardless of what reaches it. The only job here is
// getting that token into the container's process env, via `envVars`
// (@cloudflare/containers' documented mechanism for injecting runtime env),
// sourced from a Worker secret rather than the committed wrangler.jsonc.
//
// wrangler.jsonc's workers_dev:false / no routes is a second, independent
// layer on top of that — not a substitute for it.
export class SplexIntelligenceContainer extends Container<Env> {
  defaultPort = 8100;
  sleepAfter = "5m";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    if (env.INTELLIGENCE_SERVICE_TOKEN) {
      this.envVars = { ...this.envVars, INTELLIGENCE_SERVICE_TOKEN: env.INTELLIGENCE_SERVICE_TOKEN };
    }
    // Deliberately no else-branch that fabricates a token: if the secret
    // is unset, main.py's own startup guard is what should catch it (the
    // container fails to come up, visible in `wrangler tail`/deploy logs),
    // not a silent fallback here that would mask the misconfiguration.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.SPLEX_INTELLIGENCE);
    return container.fetch(request);
  },
};
