-- User feedback (thumbs up/down + optional category/comment), associated
-- with the authenticated user and, where available, the conversation/
-- message it's about. Carries no provider names, model ids, or costs --
-- capability_label is a display string ("Web search", "Image generation"),
-- the same kind of value GET /entitlements already exposes, never the
-- underlying openrouter_model_id.
create table feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  feedback_type text not null check (feedback_type in ('thumbs_up', 'thumbs_down')),
  category text check (category is null or category in (
    'incorrect_answer', 'bad_reasoning', 'hallucination', 'poor_response',
    'missing_feature', 'bug', 'file_image_issue', 'other'
  )),
  comment text check (comment is null or char_length(comment) <= 2000),
  capability_label text,
  app_version text,
  created_at timestamptz not null default now()
);

create index idx_feedback_user_id on feedback(user_id);

alter table feedback enable row level security;

-- Read-only for the client, and only their own rows. No INSERT policy: a
-- feedback submission goes through POST /feedback (server, service_role),
-- which is what re-verifies conversation_id/message_id ownership before
-- persisting and triggers the (best-effort, non-blocking) notification
-- email -- a direct client insert would skip both, and would also let a
-- client set user_id to anything, capability_label to anything, etc. No
-- UPDATE/DELETE policy either: feedback is immutable once given --
-- resubmitting is just a new row, not an edit history to maintain.
create policy feedback_select_own on feedback for select using (auth.uid() = user_id);

revoke all on feedback from anon, authenticated;
grant select on feedback to authenticated;
