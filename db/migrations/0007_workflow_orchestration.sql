-- Phase 4: Agent Workflows. New state for Cortex's planner->executor
-- multi-step orchestration. Unlike cortex_decisions/model_registry
-- (zero-policy, service-role only -- transient reasoning detail already
-- lost on refresh today), workflow state must survive a page reload
-- mid-workflow, so these get real owner-scoped read policies.

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_message_id uuid not null references messages(id) on delete cascade,
  status text not null default 'planning',
    -- planning | awaiting_clarification | running | completed | failed | cancelled
  plan jsonb,
  clarification_question text,
  clarification_step_index int,
  current_step_index int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_workflow_runs_conversation on workflow_runs(conversation_id);

create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  step_index int not null,
  title text not null,
  category text not null,
  category_label text not null,
  detailed_prompt text not null,
  status text not null default 'pending', -- pending | running | completed | failed
  output text,
  routed_model text,
  credits_charged int,
  real_input_tokens int,
  real_output_tokens int,
  created_at timestamptz not null default now(),
  unique (workflow_run_id, step_index)
);

create trigger trg_workflow_runs_updated_at
  before update on public.workflow_runs
  for each row execute function bump_updated_at();

alter table workflow_runs enable row level security;
alter table workflow_steps enable row level security;

-- Ownership scoped exactly like the existing messages read on the chat
-- page: conversations -> projects -> user_id. Safety is enforced by row
-- access here AND by a hand-picked column allowlist in the client query
-- itself (never select detailed_prompt/routed_model from the client).
create policy "workflow_runs_owner_read" on workflow_runs for select
  using (exists (
    select 1 from conversations c join projects p on p.id = c.project_id
    where c.id = workflow_runs.conversation_id and p.user_id = auth.uid()
  ));
create policy "workflow_steps_owner_read" on workflow_steps for select
  using (exists (
    select 1 from workflow_runs wr
    join conversations c on c.id = wr.conversation_id
    join projects p on p.id = c.project_id
    where wr.id = workflow_steps.workflow_run_id and p.user_id = auth.uid()
  ));
-- No insert/update/delete policies -- all writes go through supabaseAdmin.
