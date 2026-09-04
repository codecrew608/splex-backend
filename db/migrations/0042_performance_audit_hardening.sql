-- Performance-audit pass (2026-09-04), findings from Supabase's own advisor.
--
-- 1. Every RLS policy that called auth.uid() directly gets it RE-EVALUATED
--    for every row Postgres considers, not once per query — wrapping it as
--    (select auth.uid()) lets the planner treat it as a stable subquery
--    evaluated once. Zero change in access-control semantics (same
--    function, same result, same rows visible to the same roles) — purely
--    a query-plan optimization, applied here to every policy the advisor
--    flagged, across every table it touched.
drop policy if exists conversations_owner_all on public.conversations;
create policy conversations_owner_all on public.conversations for all
  using (exists (select 1 from projects p where p.id = conversations.project_id and p.user_id = (select auth.uid())));

drop policy if exists credit_usage_logs_owner_select on public.credit_usage_logs;
create policy credit_usage_logs_owner_select on public.credit_usage_logs for select
  using ((select auth.uid()) = user_id);

drop policy if exists feedback_select_own on public.feedback;
create policy feedback_select_own on public.feedback for select
  using ((select auth.uid()) = user_id);

drop policy if exists file_chunks_owner_all on public.file_chunks;
create policy file_chunks_owner_all on public.file_chunks for all
  using (exists (select 1 from files f where f.id = file_chunks.file_id and f.user_id = (select auth.uid())));

drop policy if exists files_owner_all on public.files;
create policy files_owner_all on public.files for all
  using ((select auth.uid()) = user_id);

drop policy if exists generation_jobs_owner_all on public.generation_jobs;
create policy generation_jobs_owner_all on public.generation_jobs for all
  using ((select auth.uid()) = user_id);

drop policy if exists messages_owner_all on public.messages;
create policy messages_owner_all on public.messages for all
  using (exists (
    select 1 from conversations c join projects p on p.id = c.project_id
    where c.id = messages.conversation_id and p.user_id = (select auth.uid())
  ));

drop policy if exists project_items_owner_all on public.project_items;
create policy project_items_owner_all on public.project_items for all
  using (exists (select 1 from projects p where p.id = project_items.project_id and p.user_id = (select auth.uid())));

drop policy if exists project_state_owner_all on public.project_state;
create policy project_state_owner_all on public.project_state for all
  using (exists (select 1 from projects p where p.id = project_state.project_id and p.user_id = (select auth.uid())));

drop policy if exists projects_owner_all on public.projects;
create policy projects_owner_all on public.projects for all
  using ((select auth.uid()) = user_id);

drop policy if exists subscriptions_owner_select on public.subscriptions;
create policy subscriptions_owner_select on public.subscriptions for select
  using ((select auth.uid()) = user_id);

drop policy if exists usage_counters_owner_select on public.usage_counters;
create policy usage_counters_owner_select on public.usage_counters for select
  using ((select auth.uid()) = user_id);

drop policy if exists user_memories_delete_own on public.user_memories;
create policy user_memories_delete_own on public.user_memories for delete
  using ((select auth.uid()) = user_id);

drop policy if exists user_memories_select_own on public.user_memories;
create policy user_memories_select_own on public.user_memories for select
  using ((select auth.uid()) = user_id);

drop policy if exists user_memory_owner_all on public.user_memory;
create policy user_memory_owner_all on public.user_memory for all
  using ((select auth.uid()) = user_id);

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users for select
  using ((select auth.uid()) = id);

drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users for update
  using ((select auth.uid()) = id);

drop policy if exists workflow_runs_owner_read on public.workflow_runs;
create policy workflow_runs_owner_read on public.workflow_runs for select
  using (exists (
    select 1 from conversations c join projects p on p.id = c.project_id
    where c.id = workflow_runs.conversation_id and p.user_id = (select auth.uid())
  ));

drop policy if exists workflow_steps_owner_read on public.workflow_steps;
create policy workflow_steps_owner_read on public.workflow_steps for select
  using (exists (
    select 1 from workflow_runs wr
    join conversations c on c.id = wr.conversation_id
    join projects p on p.id = c.project_id
    where wr.id = workflow_steps.workflow_run_id and p.user_id = (select auth.uid())
  ));

-- 2. Missing covering indexes on foreign keys — matters for JOIN
--    performance and for FK-checked DELETE/UPDATE on the referenced row
--    (Postgres has to scan the referencing table without one).
create index if not exists idx_credit_charge_failures_user_id on public.credit_charge_failures (user_id);
create index if not exists idx_feedback_conversation_id on public.feedback (conversation_id);
create index if not exists idx_feedback_message_id on public.feedback (message_id);
create index if not exists idx_generated_media_message_id_fk on public.generated_media (message_id);
create index if not exists idx_projects_org_id on public.projects (org_id);
create index if not exists idx_user_memories_source_message_id on public.user_memories (source_message_id);
create index if not exists idx_workflow_runs_user_message_id on public.workflow_runs (user_message_id);
