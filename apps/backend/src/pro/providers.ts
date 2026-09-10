// SPLEX Pro provider abstraction (item 4). One common interface every AI
// system implements; nothing outside this file (and providers/*.ts, once
// real adapters exist) ever makes a provider-specific API call. The
// orchestrator selects a provider by CAPABILITY, never by name — role
// defaults below are metadata the orchestrator consults, not a hard-coded
// dispatch table (item 3's own explicit requirement).

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

function supportsFactory(capabilities: ProviderCapabilities) {
  return (operation: ProviderOperation) => capabilities.operations.includes(operation);
}

// ---------------------------------------------------------------------
// Role-default capabilities (item 3) — metadata only. Real adapters below
// are STUBS: this codebase holds no OpenAI/Anthropic/Gemini/Perplexity/xAI
// credential (confirmed by grep, same verification standard this session
// already applied to Groq before building anything against it), and item
// 38 forbids consuming real premium-provider credit for user-facing Pro
// functionality anyway while Pro is unlaunched. Declaring the shape now —
// capabilities the orchestrator can plan against, a call() that fails
// loudly and honestly instead of pretending to work — is what lets a real
// adapter slot in later as a pure swap, with zero change to the
// orchestrator or the interface it depends on.
// ---------------------------------------------------------------------

function unconnectedProvider(name: ProviderName, capabilities: ProviderCapabilities): AIProvider {
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
        `${name} has no connected adapter yet (no API credential configured) — this is expected while SPLEX Pro is unlaunched, not a transient failure. See providers.ts.`,
      );
    },
  };
}

export const OPENAI_PROVIDER: AIProvider = unconnectedProvider("openai", {
  operations: ["plan", "reason", "generate", "analyze"],
  modalities: ["text", "vision"],
  toolSupport: true,
  maxContextTokens: 200000,
  costPerMillionInputUsd: 2.5,
  costPerMillionOutputUsd: 10,
});

export const ANTHROPIC_PROVIDER: AIProvider = unconnectedProvider("anthropic", {
  operations: ["code", "review", "generate", "reason", "tool_call"],
  modalities: ["text", "vision"],
  toolSupport: true,
  maxContextTokens: 200000,
  costPerMillionInputUsd: 3,
  costPerMillionOutputUsd: 15,
});

export const GEMINI_PROVIDER: AIProvider = unconnectedProvider("gemini", {
  operations: ["analyze", "review", "reason", "generate"],
  modalities: ["text", "vision", "audio"],
  toolSupport: true,
  maxContextTokens: 1000000,
  costPerMillionInputUsd: 1.25,
  costPerMillionOutputUsd: 5,
});

export const PERPLEXITY_PROVIDER: AIProvider = unconnectedProvider("perplexity", {
  operations: ["research"],
  modalities: ["text"],
  toolSupport: false,
  maxContextTokens: 128000,
  costPerMillionInputUsd: 1,
  costPerMillionOutputUsd: 1,
});

export const XAI_PROVIDER: AIProvider = unconnectedProvider("xai", {
  operations: ["reason", "review", "analyze", "tool_call"],
  modalities: ["text"],
  toolSupport: true,
  maxContextTokens: 128000,
  costPerMillionInputUsd: 2,
  costPerMillionOutputUsd: 6,
});

// ---------------------------------------------------------------------
// MockProvider — real, working, fully offline (item 38: "For testing
// orchestration logic, use mocks... deterministic fixtures... synthetic
// responses... offline simulation"). Every orchestrator test in this
// phase runs against this, never a real API. Deterministic on its input
// so a test asserting a specific output isn't flaky.
// ---------------------------------------------------------------------
export function createMockProvider(name: ProviderName = "mock"): AIProvider {
  const capabilities: ProviderCapabilities = {
    operations: ["plan", "reason", "generate", "analyze", "review", "research", "code", "tool_call"],
    modalities: ["text"],
    toolSupport: true,
    maxContextTokens: 128000,
    costPerMillionInputUsd: 0,
    costPerMillionOutputUsd: 0,
  };
  return {
    name,
    capabilities,
    supports: supportsFactory(capabilities),
    async call(params: ProviderCallParams): Promise<ProviderCallResult> {
      const inputTokens = Math.ceil(params.input.length / 4);
      const content = `[mock:${params.operation}] synthetic result for: ${params.input.slice(0, 80)}`;
      return {
        content,
        inputTokens,
        outputTokens: Math.ceil(content.length / 4),
        costUsd: 0,
        latencyMs: 1,
      };
    },
  };
}

// The registry the orchestrator actually consults — capability lookup,
// never a hard-coded "this task type -> this provider" table (item 3).
export function defaultProviderRegistry(): AIProvider[] {
  return [OPENAI_PROVIDER, ANTHROPIC_PROVIDER, GEMINI_PROVIDER, PERPLEXITY_PROVIDER, XAI_PROVIDER];
}

// Ranks candidates for one operation by cost (item 24: "the cheapest model
// capable of doing the task well enough" — capability-filtered first, so
// "capable" is never traded away for "cheap"). Real adapters are
// unconnected right now, so this is exercised against a registry built
// from createMockProvider() in tests and in the orchestrator's current
// (offline-only) execution path — the ranking logic itself is real and
// provider-agnostic, ready for real adapters to slot into unchanged.
export function selectProviderFor(operation: ProviderOperation, registry: AIProvider[]): AIProvider | null {
  const capable = registry.filter((p) => p.supports(operation));
  if (capable.length === 0) return null;
  capable.sort((a, b) => a.capabilities.costPerMillionOutputUsd - b.capabilities.costPerMillionOutputUsd);
  return capable[0];
}
