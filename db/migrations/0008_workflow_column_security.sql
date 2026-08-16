-- migration 0007 gave workflow_runs/workflow_steps owner-scoped RLS SELECT
-- policies so a mid-workflow page reload can reconstruct state. RLS only
-- restricts ROWS, not COLUMNS — live-tested and confirmed this let any
-- authenticated user query their own workflow_steps.routed_model directly
-- via the REST API, exposing the real openrouter_model_id and breaking
-- the "never reveal the underlying model" invariant enforced everywhere
-- else in this app (cortex_decisions/model_registry are zero-policy,
-- service-role-only specifically to prevent exactly this).
--
-- A plain `revoke select (routed_model) ...` does NOT actually restrict
-- it: Postgres' table-wide SELECT grant (which Supabase applies to every
-- new table by default) already conveys implicit SELECT on every column,
-- and that broader grant isn't narrowed by revoking one column's
-- column-level entry (confirmed live — the first version of this
-- migration ran clean but the column was still readable). The only way to
-- actually restrict one column is to revoke the table-wide SELECT and
-- re-grant column-level SELECT for just the safe columns.
revoke select on workflow_steps from anon, authenticated;
grant select (
  id, workflow_run_id, step_index, title, category, category_label,
  detailed_prompt, status, output, credits_charged,
  real_input_tokens, real_output_tokens, created_at
) on workflow_steps to anon, authenticated;
