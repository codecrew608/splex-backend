-- Separates a REAL, user-created project from the invisible container row
-- that every standalone chat is forced to have.
--
-- Background: conversations.project_id is NOT NULL, so a chat cannot exist
-- without a project. resolveConversation() (persistence/conversations.ts)
-- therefore auto-creates a projects row titled after the user's first
-- message for every plain "New chat". Those containers used the same
-- type='chat' as genuinely user-created projects, with nothing to tell
-- them apart — so two things went wrong, both reported live:
--
--   1. Every chat ever sent appeared in the Projects list (sidebar and
--      /projects). A new chat didn't "go into" a project, it BECAME one.
--   2. The `projects` plan quota counts rows in this table
--      (entitlements/index.ts, kind:"row_count"), so those containers
--      counted against the cap. With 111 of them the owner was far past a
--      3-project free cap and could no longer create a real project at
--      all — the auto-create path skips the quota check itself, so this
--      only ever surfaced on the user-facing "New project" button.
--
-- is_implicit is the discriminator. It is deliberately NOT a new
-- project_type enum value: type describes what a project is FOR
-- (chat/build/study_kit) and stays orthogonal to whether the user made it
-- on purpose — a future implicit container for a build project would need
-- both facts, which one enum column can't carry.
alter table public.projects
  add column if not exists description text,
  add column if not exists is_implicit boolean not null default false;

comment on column public.projects.is_implicit is
  'true = auto-created container holding one standalone chat; never shown in the Projects UI and never counted against the projects quota. false = a real project the user created deliberately (name + description).';

comment on column public.projects.description is
  'User-supplied description, captured on the create-project form. Always null for is_implicit rows.';

-- Backfill. Every pre-existing row is an auto-created container: verified
-- against production before writing this — 111 of 119 match the
-- auto-create signature exactly (exactly one conversation, whose title
-- equals the project title, because both come from the same
-- titleFromMessage(firstMessage) call), and the remaining 8 are that same
-- shape with the conversation since deleted, leaving an empty shell. Not
-- one row was created through the New Project flow with chats placed in
-- it, so there is nothing here a user would recognise as their project.
--
-- Deliberately destroys nothing: no conversation, message, or project row
-- is deleted. Every existing chat keeps its container and opens exactly as
-- before; the rows are only hidden from the Projects list. Reversing any
-- individual one is a single flag flip back to false.
update public.projects set is_implicit = true where is_implicit = false;

-- Partial index: every read that cares about this column filters
-- is_implicit = false (the Projects list, and the quota row_count), and
-- that is the small side of a very lopsided split — 8 real projects per
-- ~111 containers here, and the ratio only grows with chat volume.
create index if not exists projects_user_real_idx
  on public.projects (user_id, created_at desc)
  where is_implicit = false;
