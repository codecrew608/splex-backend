-- "Disable memory" (Memory settings UI requirement) -- a simple per-user
-- flag, checked by the backend before fetching/injecting memory context
-- into a chat turn and before running extraction. Client-updatable, same
-- column-specific-grant pattern already used for full_name/date_of_birth
-- on this table (never a blanket table-level UPDATE grant).
alter table users add column memory_enabled boolean not null default true;

grant update (memory_enabled) on users to authenticated;
