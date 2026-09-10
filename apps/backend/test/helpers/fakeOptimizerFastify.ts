// Purpose-built fake for the Prompt Optimizer's fastify-dependent modules
// (model.ts, semantic.ts, telemetry.ts, index.ts) — separate from
// fakeFastify.ts (helpers/fakeFastify.ts), which is built around credit-
// counter ARITHMETIC the optimizer never touches. Same simplification
// philosophy as that file's own model_registry/generic-table handling:
// filters (.eq/.order/.limit) are accepted but ignored, and a test
// controls the result purely via state.modelRegistryRows — exact enough
// for what this module actually branches on (row present vs. absent),
// without re-implementing a query planner.

export interface FakeOptimizerState {
  config: Record<string, unknown>;
  modelRegistryRows: Array<Record<string, unknown>>;
  optimizerOutcomeInserts: Array<Record<string, unknown>>;
  logs: Array<{ level: string; msg: unknown }>;
}

export function makeOptimizerState(overrides: Partial<FakeOptimizerState> = {}): FakeOptimizerState {
  return {
    config: { PROMPT_OPTIMIZER_MODEL_ID: "test/paid-optimizer-model", SPLEX_PRO_ENABLED: true },
    modelRegistryRows: [],
    optimizerOutcomeInserts: [],
    logs: [],
    ...overrides,
  };
}

export function makeOptimizerFastify(state: FakeOptimizerState) {
  const log = {
    error: (o: unknown, m?: string) => state.logs.push({ level: "error", msg: m ?? o }),
    warn: (o: unknown, m?: string) => state.logs.push({ level: "warn", msg: m ?? o }),
    info: (o: unknown, m?: string) => state.logs.push({ level: "info", msg: m ?? o }),
    debug: () => {},
  };

  const supabaseAdmin = {
    from(table: string) {
      if (table === "model_registry") {
        const api: Record<string, unknown> = {};
        const chain = () => api;
        Object.assign(api, {
          select: chain,
          eq: chain,
          order: chain,
          limit: chain,
          maybeSingle: async () => ({ data: state.modelRegistryRows[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: state.modelRegistryRows, error: null }),
        });
        return api;
      }
      if (table === "prompt_optimizer_outcomes") {
        return {
          insert: (row: Record<string, unknown>) => {
            state.optimizerOutcomeInserts.push(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`fakeOptimizerFastify: unexpected table "${table}"`);
    },
  };

  return { config: state.config, log, supabaseAdmin } as never;
}
