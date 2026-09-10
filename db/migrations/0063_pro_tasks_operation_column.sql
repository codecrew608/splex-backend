-- 0063 — pro_tasks.operation: a real gap found while designing the
-- execution engine, not a hypothetical one. buildTaskExecutionGraph
-- (orchestrator.ts) computes a ProviderOperation per phase and uses it to
-- pick assigned_provider at PLANNING time (createProWorkflow), but never
-- persisted the operation itself — only assigned_provider (a name) and
-- required_capabilities (a separate, looser descriptive string array).
-- Execution needs the operation directly: to construct the actual
-- provider.call({operation, ...}), and to re-select a fallback provider
-- by CAPABILITY (selectProviderFor) if the originally-assigned one fails,
-- rather than being stuck re-deriving it from required_capabilities.
alter table public.pro_tasks
  add column operation text check (operation in (
    'plan', 'reason', 'generate', 'analyze', 'review', 'research', 'code', 'tool_call'
  ));
