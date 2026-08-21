import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default config is deliberately unmodified — apps/web has no ISR/queue/KV
// dependency (server components either read env vars or call the Fastify
// backend over plain fetch; no Next.js data cache backed by the
// filesystem to redirect to R2/KV). Revisit only if a future feature adds
// one of those.
export default defineCloudflareConfig();
