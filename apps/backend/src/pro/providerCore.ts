// Shared provider primitives — split out from providers.ts specifically
// to avoid a circular import: providers.ts needs to import the 5 real
// adapter factories (providers/openai.ts and siblings) to build the
// registry, and those adapter files need the types/helpers below. Neither
// side imports the other; both import this file. providers.ts re-exports
// everything here unchanged, so no existing import path (orchestrator.ts,
// every pro-providers test) needed to change.

export type ProviderName = "openai" | "anthropic" | "gemini" | "perplexity" | "xai" | "mock";

// The eight operations item 4 names. A provider declares which of these it
// actually supports (`capabilities.operations`) — calling one it doesn't
// support is a caller bug, not a runtime surprise, and `supports()` exists
// so the orchestrator can check before ever constructing a call.
export type ProviderOperation = "plan" | "reason" | "generate" | "analyze" | "review" | "research" | "code" | "tool_call";

export interface ProviderCapabilities {
  operations: ProviderOperation[];
  modalities: ("text" | "vision" | "audio")[];
  toolSupport: boolean;
  maxContextTokens: number;
  // Rough per-million-token USD, for cost-aware selection (item 24) before
  // any real call happens — not billing-accurate, a planning estimate only.
  costPerMillionInputUsd: number;
  costPerMillionOutputUsd: number;
}

export interface ProviderCallParams {
  operation: ProviderOperation;
  // Task-specific, already-minimized context (item 11) — never the whole
  // workspace. Building that minimized context is the ORCHESTRATOR's job
  // (see orchestrator.ts); a provider only ever sees what it's handed.
  input: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderCallResult {
  content: string;
  // The real model id that served this call (e.g. "gpt-4o") — required so
  // pro_provider_runs.model (not-null, migration 0061) records what
  // actually ran, not a placeholder. Each real adapter returns its own
  // configured *_MODEL_ID; MockProvider returns a fixed synthetic value.
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

// Mirrors pro_provider_runs.failure_classification exactly (migration
// 0061) — the failover decision (item 25) reads THIS, never a raw HTTP
// status, so "should this trigger a fallback" is answered the same way
// regardless of which real provider eventually throws it.
export type ProviderFailureClass =
  | "temporary" | "rate_limit" | "capacity_exhausted" | "auth_failure"
  | "invalid_request" | "unsupported_capability" | "application_bug" | "security_rejection";

export class ProviderCallError extends Error {
  readonly provider: ProviderName;
  readonly classification: ProviderFailureClass;
  constructor(provider: ProviderName, classification: ProviderFailureClass, message: string) {
    super(message);
    this.name = "ProviderCallError";
    this.provider = provider;
    this.classification = classification;
  }
}

export interface AIProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;
  supports(operation: ProviderOperation): boolean;
  call(params: ProviderCallParams): Promise<ProviderCallResult>;
}

export function supportsFactory(capabilities: ProviderCapabilities) {
  return (operation: ProviderOperation) => capabilities.operations.includes(operation);
}

// Shared cost math for every real adapter — providers/*.ts each supply
// only what actually differs (base URL, auth shape, request/response
// parsing); the $ conversion from raw tokens is identical everywhere and
// belongs in one place.
export function computeCostUsd(capabilities: ProviderCapabilities, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * capabilities.costPerMillionInputUsd +
    (outputTokens / 1_000_000) * capabilities.costPerMillionOutputUsd
  );
}

// The fallback every real adapter (providers/*.ts) uses when its specific
// API key isn't configured — same honest, loud failure as before any real
// adapter existed: capabilities are real and declared (so the orchestrator
// can still plan against this provider), but call() fails immediately
// rather than pretending to work. This is what makes a real adapter a
// pure activation-by-setting-one-env-var, not a code change: each
// providers/*.ts factory checks its key and returns THIS when absent.
export function unconnectedProvider(name: ProviderName, capabilities: ProviderCapabilities): AIProvider {
  return {
    name,
    capabilities,
    supports: supportsFactory(capabilities),
    // async, not a plain function that throws: call() is typed to return
    // Promise<ProviderCallResult>, and a synchronous throw would violate
    // that contract for any caller using .call(x).catch(...) instead of
    // try/await — exactly the shape item 25's failover logic would use.
    async call() {
      throw new ProviderCallError(
        name,
        "application_bug",
        `${name} has no connected adapter yet (no API credential configured) — this is expected until the matching API key is set, not a transient failure. See providers.ts.`,
      );
    },
  };
}
