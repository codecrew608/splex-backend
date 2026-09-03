-- Links an uploaded file to the specific chat message it was attached to,
-- so a conversation reload can show attachment chips instead of either
-- nothing (images, previously) or the file's full extracted text dumped
-- into the message bubble as if the user had typed it (documents,
-- previously -- see buildAttachmentTextBlock's persisted-content role
-- before this fix).
alter table files add column message_id uuid references messages(id) on delete set null;

-- Partial index: only attached files ever get looked up by message_id
-- (the vast majority of rows -- unattached uploads, RAG-only files -- never
-- will), and NULL is the overwhelmingly common value pre-migration.
create index idx_files_message_id on files(message_id) where message_id is not null;
