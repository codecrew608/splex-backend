-- 0061 — SPLEX Pro foundation: schema, plan definition, budget primitives.
--
-- PRO IS NOT LAUNCHING. This migration creates structure only — no code
-- path reachable by a real user writes to these tables yet (see the
-- SPLEX_PRO_ENABLED gate added alongside this migration, enforced in
-- application code, independent of anything here). A migration cannot
-- itself "activate" a product; it can only make activation possible later
-- without a schema rewrite, which is the actual goal of this file.
--
-- ARCHITECTURAL FINDING, surfaced per this task's own decision rule rather
-- than silently resolved: the existing workflow_runs/workflow_steps
-- (migration 0007, "Agent Workflow") is NOT reusable for Pro, and this is a
-- structural mismatch, not a naming one:
--   - workflow_runs is hard-scoped to ONE conversation_id. Pro workflows
--     are cross-conversation / project-level by requirement (item 18).
--   - workflow_steps is a linear sequence (step_index, one predecessor).
--     Pro needs a real DAG: independent branches that run in parallel and
--     tasks with multiple prerequisites (item 6's own example has
--     "Implementation" depend on BOTH "Research" and "Architecture" at
--     once) — not representable by a single ordinal column.
--   - workflow_steps has one `routed_model` column, because Agent Workflow
--     always dispatches through the SAME OpenRouter/Groq routing Chat
--     uses. Pro is explicitly multi-PROVIDER (OpenAI/Anthropic/Gemini/
--     Perplexity/xAI as independent systems), a dimension the existing
--     schema has no column for.
-- Forcing Pro's shape onto these tables would mean either breaking their
-- existing linear contract (used today by real Free/Paid/Starter traffic
-- — exactly what item 40 forbids risking) or bolting graph semantics onto
-- a table that structurally isn't one. New, separate tables are therefore
-- the correct application of "don't duplicate a subsystem": the reusable
-- SUBSYSTEMS (OpenRouter/Groq dispatch, credit reserve/settle, the
-- classifier, memory retrieval) are reused by the orchestrator in
-- application code; only the STORAGE SHAPE is new, because the shape
-- itself is the thing that's different.
--
-- WHAT WAS DELIBERATELY NOT BUILT AS A SEPARATE TABLE, to avoid a 10th
-- table for information one column already covers at this stage:
--   - pro_memory_links -> pro_tasks.memory_context_used (jsonb). Full
--     provenance of which memory entries fed which task without a join
--     table; promote to a real table if Pro ever needs to query "which
--     tasks used memory X" rather than "which memory did task X use".
--   - pro_usage -> intentionally does NOT exist. Item 23 is explicit:
--     reuse the existing credit infrastructure, never a parallel
--     incompatible one. pro_budget_reservations (below) is the workflow-
--     level aggregation step; the actual charge still lands in the
--     EXISTING usage_counters/credit_usage_logs via the existing
--     consumeCredits() path — see this file's own comment on that table.
--   - pro_workflow_events folds into pro_provider_runs + task/workflow
--     status timestamps for now, rather than a separate append-only log;
--     promote if observability needs richer event granularity than status
--     transitions provide.

begin;

-- Two new budget dimensions, mirroring workflow_steps/workflow_cost's own
-- established shape exactly (see cortex/workflow/limits.ts:
-- maxSteps/maxCostCredits) but for Pro's heavier, multi-provider
-- workflows, which need their own ceiling separate from ordinary Agent
-- Workflow's — a Pro user still gets ordinary workflow_cost/workflow_runs
-- too, for ordinary single-provider Agent Workflow.
alter type counter_type add value if not exists 'pro_workflow_cost';
alter type counter_type add value if not exists 'pro_workflow_runs';
alter type counter_type add value if not exists 'pro_workflow_runs_monthly';

commit;

begin;

-- ---------------------------------------------------------------------
-- Plan definition: SPLEX Pro, ₹799/month, 150,000 SPLEX credits/month.
--
-- Every numeric value below is a PROVISIONAL, explicitly policy-choice
-- default, not a validated business number — Pro has zero users, so
-- getting a number wrong here costs nothing until launch, unlike the
-- Starter numbers this session already had to move live customers
-- through carefully. Derived by scaling Starter's own real, live values
-- (100,000 monthly credits) by the credits ratio (150,000/100,000 = 1.5x),
-- rounded to clean numbers, EXCEPT the two new pro_workflow_* rows, which
-- have no Starter analog to scale from and are sized directly: a single
-- multi-provider collaboration run may cost meaningfully more than a
-- single-provider Agent Workflow run (multiple providers, not one), but
-- must still be bounded well under the whole monthly pool so one runaway
-- workflow cannot consume a user's entire month (item 41's explicit
-- concern). All of this needs real review before Pro launches — flagged
-- again in the final report, not just here.
-- ---------------------------------------------------------------------
insert into public.plan_limits (plan_tier, counter_type, limit_amount) values
  ('pro', 'credits', 150000),
  ('pro', 'daily_credits', 5000),
  ('pro', 'daily_requests', 100),
  ('pro', 'projects', null),                    -- unlimited, matching starter
  ('pro', 'file_uploads', 150),
  ('pro', 'storage_bytes', 10737418240),         -- 10 GB
  ('pro', 'workflow_steps', 15),
  ('pro', 'workflow_cost', 60000),
  ('pro', 'workflow_runs', 5),
  ('pro', 'workflow_runs_monthly', 45),
  ('pro', 'image_generations', 8),
  ('pro', 'image_generations_monthly', 90),
  ('pro', 'audio_generations', 8),
  ('pro', 'audio_minutes', 15),
  ('pro', 'audio_minutes_monthly', 150),
  ('pro', 'video_generations', 3),
  ('pro', 'video_generations_monthly', 23),
  ('pro', 'ppt_generations', 3),
  ('pro', 'ppt_generations_monthly', 23),
  ('pro', 'web_searches', 150),
  ('pro', 'web_searches_monthly', 450),
  ('pro', 'deep_research', 5),
  ('pro', 'deep_research_monthly', 45),
  ('pro', 'research_max_searches', 9),
  ('pro', 'research_max_pages', 12),
  ('pro', 'research_cost', 18000),
  ('pro', 'vision_inputs', 30),
  ('pro', 'vision_inputs_monthly', 450),
  -- New: SPLEX Pro's OWN multi-AI collaboration budget, separate from
  -- ordinary Agent Workflow above. pro_workflow_cost is a PER-RUN ceiling
  -- (mirrors workflow_cost's semantics exactly — see limits.ts), not a
  -- daily aggregate: no single collaboration run may charge more than
  -- this many credits against the shared pool, regardless of how many
  -- provider calls it took internally.
  ('pro', 'pro_workflow_cost', 25000),
  ('pro', 'pro_workflow_runs', 3),
  ('pro', 'pro_workflow_runs_monthly', 20)
on conflict (plan_tier, counter_type) do update set limit_amount = excluded.limit_amount;

-- ---------------------------------------------------------------------
-- pro_workflows — the DAG-level record. Cross-conversation and optionally
-- project-scoped (item 18/19), unlike workflow_runs' hard conversation_id
-- scope. conversation_id is still recorded (nullable) so a workflow
-- started from a chat turn keeps its origin without being STRUCTURALLY
-- bound to it the way workflow_runs is.
-- ---------------------------------------------------------------------
create table public.pro_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,

  objective text not null,
  -- State machine (item 34). CHECK, not a free enum, so an impossible
  -- state is a constraint violation at write time, not a later bug hunt.
  status text not null default 'CREATED' check (status in (
    'CREATED', 'PLANNING', 'DECOMPOSING', 'WAITING_FOR_TASKS', 'RUNNING',
    'REVIEWING', 'VERIFYING', 'WAITING_FOR_USER', 'COMPLETED', 'FAILED', 'CANCELLED'
  )),
  -- Filled once PLANNING completes: the orchestrator's own structured
  -- record of what it decided and why (objective breakdown, chosen
  -- collaboration pattern, provider assignments) — distinct from the task
  -- graph itself (pro_tasks/pro_task_dependencies), which is the
  -- EXECUTABLE form of this plan.
  plan jsonb,
  clarification_question text,
  clarification_task_id uuid,

  -- Collaboration budget (item 22) — enforced BEFORE each provider call,
  -- not just observed after. Every max_* has a real, finite default so a
  -- workflow can never be created with an implicit "unlimited" ceiling.
  max_provider_calls int not null default 20,
  max_token_budget int not null default 200000,
  max_estimated_cost_credits int not null default 25000,
  max_execution_ms int not null default 600000,       -- 10 minutes
  max_retry_count int not null default 3,
  max_collaboration_depth int not null default 4,      -- longest dependency chain
  max_parallel_branches int not null default 5,

  -- Aggregation point for item 23's "one coherent SPLEX usage record":
  -- every pro_provider_runs cost rolls up here, and THIS total (not any
  -- individual provider call) is what settles against the shared credit
  -- pool via pro_budget_reservations.
  reserved_credits int not null default 0,
  actual_cost_credits int,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index idx_pro_workflows_user on public.pro_workflows(user_id);
create index idx_pro_workflows_project on public.pro_workflows(project_id) where project_id is not null;
create index idx_pro_workflows_status on public.pro_workflows(status) where status not in ('COMPLETED', 'FAILED', 'CANCELLED');

create trigger trg_pro_workflows_updated_at
  before update on public.pro_workflows
  for each row execute function bump_updated_at();

-- ---------------------------------------------------------------------
-- pro_tasks — Task Execution Graph nodes (item 6).
-- ---------------------------------------------------------------------
create table public.pro_tasks (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.pro_workflows(id) on delete cascade,

  objective text not null,
  description text,
  required_capabilities text[] not null default '{}',
  assigned_provider text,
  assigned_model text,

  status text not null default 'PENDING' check (status in (
    'PENDING', 'READY', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'
  )),
  priority int not null default 0,

  -- Context minimization (item 11): the task-specific slice actually sent
  -- to the provider, never the whole workspace. memory_context_used
  -- records WHICH memory entries were selected for provenance (item 13 /
  -- 17), without a separate join table — see this file's header.
  input_context jsonb,
  memory_context_used jsonb,

  verification_status text check (verification_status in ('unreviewed', 'passed', 'failed', 'not_required')),
  estimated_cost_credits int,
  actual_cost_credits int,
  retry_count int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index idx_pro_tasks_workflow on public.pro_tasks(workflow_id);
create index idx_pro_tasks_status on public.pro_tasks(workflow_id, status);

create trigger trg_pro_tasks_updated_at
  before update on public.pro_tasks
  for each row execute function bump_updated_at();

-- ---------------------------------------------------------------------
-- pro_task_dependencies — Task Execution Graph edges (items 7/8). An
-- explicit edge table, not a single parent_task_id column, because a task
-- can have MULTIPLE prerequisites (item 6's own example: Implementation
-- depends on both Research and Architecture at once) — a DAG, not a tree.
--
-- Acyclicity is NOT enforced by this constraint set (Postgres cannot
-- express "no cycles" declaratively without a recursive trigger this
-- foundation phase doesn't need yet) — it is the orchestrator's
-- responsibility when constructing the graph. Documented, not silently
-- assumed.
-- ---------------------------------------------------------------------
create table public.pro_task_dependencies (
  workflow_id uuid not null references public.pro_workflows(id) on delete cascade,
  task_id uuid not null references public.pro_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.pro_tasks(id) on delete cascade,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);
create index idx_pro_task_deps_workflow on public.pro_task_dependencies(workflow_id);
create index idx_pro_task_deps_depends_on on public.pro_task_dependencies(depends_on_task_id);

-- ---------------------------------------------------------------------
-- pro_artifacts — artifact-based communication (item 12) with provenance
-- (item 13).
-- ---------------------------------------------------------------------
create table public.pro_artifacts (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.pro_workflows(id) on delete cascade,
  task_id uuid not null references public.pro_tasks(id) on delete cascade,

  artifact_type text not null,   -- 'research_report' | 'architecture' | 'code' | 'spec' | 'test_report' | 'review' | 'deployment_result' | ...
  content jsonb not null,
  provider text,
  model text,
  input_context_hash text,       -- item 13: what input version produced this
  parent_artifact_ids uuid[] not null default '{}',  -- provenance lineage; not FK-enforced (array), see note below

  status text not null default 'draft' check (status in ('draft', 'final', 'superseded')),
  verification_state text not null default 'unreviewed' check (verification_state in ('unreviewed', 'passed', 'failed', 'not_required')),

  created_at timestamptz not null default now()
);
create index idx_pro_artifacts_workflow on public.pro_artifacts(workflow_id);
create index idx_pro_artifacts_task on public.pro_artifacts(task_id);
-- parent_artifact_ids is a plain uuid[], not FK-enforced by Postgres (no
-- native array-FK) — an app-layer invariant (fallback.ts-style comments
-- elsewhere in this codebase already accept this trade-off for similar
-- cases). If lineage integrity ever needs a hard guarantee, promote to a
-- pro_artifact_lineage(parent_id, child_id) join table.

-- ---------------------------------------------------------------------
-- pro_collaboration_messages — the CONTROLLED protocol (item 9/10). Every
-- row has the orchestrator on at least one side: this is the structural
-- guarantee against uncontrolled AI-to-AI conversation the spec requires
-- ("Do not allow AI A <-> AI B <-> AI C... without orchestration").
-- ---------------------------------------------------------------------
create table public.pro_collaboration_messages (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.pro_workflows(id) on delete cascade,
  task_id uuid references public.pro_tasks(id) on delete cascade,

  from_role text not null,   -- 'orchestrator' | 'provider:<name>'
  to_role text not null,
  message_type text not null check (message_type in (
    'task_assignment', 'artifact_reference', 'critique', 'verification_request',
    'verification_result', 'clarification_request', 'status_update'
  )),
  content jsonb not null,

  created_at timestamptz not null default now(),
  check (from_role = 'orchestrator' or to_role = 'orchestrator')
);
create index idx_pro_collab_messages_workflow on public.pro_collaboration_messages(workflow_id);
create index idx_pro_collab_messages_task on public.pro_collaboration_messages(task_id) where task_id is not null;

-- ---------------------------------------------------------------------
-- pro_provider_runs — one row per actual provider call (item 4's
-- operations, item 25's failure classification).
-- ---------------------------------------------------------------------
create table public.pro_provider_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.pro_workflows(id) on delete cascade,
  task_id uuid not null references public.pro_tasks(id) on delete cascade,

  provider text not null,
  model text not null,
  operation text not null check (operation in (
    'plan', 'reason', 'generate', 'analyze', 'review', 'research', 'code', 'tool_call'
  )),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),

  input_tokens int,
  output_tokens int,
  cost_usd numeric(12, 6),
  cost_credits int,
  latency_ms int,

  -- item 25 — only SOME of these should ever trigger a fallback; the
  -- classification is recorded here so the orchestrator's fallback
  -- decision is auditable, not just its outcome.
  failure_classification text check (failure_classification in (
    'temporary', 'rate_limit', 'capacity_exhausted', 'auth_failure',
    'invalid_request', 'unsupported_capability', 'application_bug', 'security_rejection'
  )),
  failure_detail text,

  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_pro_provider_runs_workflow on public.pro_provider_runs(workflow_id);
create index idx_pro_provider_runs_task on public.pro_provider_runs(task_id);
create index idx_pro_provider_runs_provider on public.pro_provider_runs(provider, status);

-- ---------------------------------------------------------------------
-- pro_budget_reservations — the atomic reserve/settle primitive (item 22,
-- 23) for a WHOLE workflow's aggregate cost, mirroring the exact proven
-- shape checkAndReserveCredits/settleDailyReservation already use for
-- ordinary chat (credits/checkCredits.ts) and Agent Workflow — never a
-- second, incompatible accounting system. The actual charge against the
-- shared SPLEX credit pool still happens through the EXISTING
-- consume_credits()/usage_counters path; this table is Pro's own record
-- of what it reserved and what it actually settled for, so "one logical
-- workflow -> one coherent usage record" (item 23) is auditable
-- independent of how many pro_provider_runs rows contributed to it.
-- ---------------------------------------------------------------------
create table public.pro_budget_reservations (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.pro_workflows(id) on delete cascade,

  reserved_credits int not null,
  settled_credits int,
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released')),

  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index idx_pro_budget_reservations_workflow on public.pro_budget_reservations(workflow_id);

-- ---------------------------------------------------------------------
-- pro_verification_results — review/verification pattern (item 14, 28).
-- task_id nullable: a verification can target one task's output OR the
-- workflow's final synthesized result.
-- ---------------------------------------------------------------------
create table public.pro_verification_results (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.pro_workflows(id) on delete cascade,
  task_id uuid references public.pro_tasks(id) on delete cascade,

  verifier_provider text,
  verifier_model text,
  verification_type text not null,  -- 'quality' | 'correctness' | 'security' | 'completeness' | ...
  passed boolean not null,
  findings jsonb,

  created_at timestamptz not null default now()
);
create index idx_pro_verification_results_workflow on public.pro_verification_results(workflow_id);

-- ---------------------------------------------------------------------
-- Row-level security — same posture as workflow_runs/workflow_steps
-- (migration 0007): owner-scoped READ only, no insert/update/delete
-- policy. Every write goes through supabaseAdmin (service role), which
-- bypasses RLS by design — these policies exist purely to let an owning
-- user's own client query their own workflow state directly, matching
-- what the chat page already does for Agent Workflow.
-- ---------------------------------------------------------------------
alter table public.pro_workflows enable row level security;
alter table public.pro_tasks enable row level security;
alter table public.pro_task_dependencies enable row level security;
alter table public.pro_artifacts enable row level security;
alter table public.pro_collaboration_messages enable row level security;
alter table public.pro_provider_runs enable row level security;
alter table public.pro_budget_reservations enable row level security;
alter table public.pro_verification_results enable row level security;

create policy "pro_workflows_owner_read" on public.pro_workflows for select
  using (user_id = auth.uid());

create policy "pro_tasks_owner_read" on public.pro_tasks for select
  using (exists (select 1 from public.pro_workflows w where w.id = pro_tasks.workflow_id and w.user_id = auth.uid()));

create policy "pro_task_dependencies_owner_read" on public.pro_task_dependencies for select
  using (exists (select 1 from public.pro_workflows w where w.id = pro_task_dependencies.workflow_id and w.user_id = auth.uid()));

create policy "pro_artifacts_owner_read" on public.pro_artifacts for select
  using (exists (select 1 from public.pro_workflows w where w.id = pro_artifacts.workflow_id and w.user_id = auth.uid()));

create policy "pro_collaboration_messages_owner_read" on public.pro_collaboration_messages for select
  using (exists (select 1 from public.pro_workflows w where w.id = pro_collaboration_messages.workflow_id and w.user_id = auth.uid()));

create policy "pro_provider_runs_owner_read" on public.pro_provider_runs for select
  using (exists (select 1 from public.pro_workflows w where w.id = pro_provider_runs.workflow_id and w.user_id = auth.uid()));

create policy "pro_budget_reservations_owner_read" on public.pro_budget_reservations for select
  using (exists (select 1 from public.pro_workflows w where w.id = pro_budget_reservations.workflow_id and w.user_id = auth.uid()));

create policy "pro_verification_results_owner_read" on public.pro_verification_results for select
  using (exists (select 1 from public.pro_workflows w where w.id = pro_verification_results.workflow_id and w.user_id = auth.uid()));

commit;
