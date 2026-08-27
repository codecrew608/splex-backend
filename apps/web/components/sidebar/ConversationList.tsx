"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSidebarStore } from "@/state/sidebarStore";
import { SidebarSearch } from "./SidebarSearch";
import { cn } from "@/lib/cn";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ConversationList() {
  const pathname = usePathname();
  const router = useRouter();
  const conversations = useSidebarStore((s) => s.conversations);
  const setConversations = useSidebarStore((s) => s.setConversations);
  const removeConversation = useSidebarStore((s) => s.removeConversation);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const supabase = createClient();
      // conversations now carry their own title — no longer borrowed from
      // the parent project, which only worked while every conversation had
      // a dedicated 1:1 project (that broke the moment a project could hold
      // more than one chat).
      const { data } = await supabase
        .from("conversations")
        .select("id, title, created_at, project_id, projects!inner(type)")
        .eq("projects.type", "chat")
        .order("created_at", { ascending: false })
        .limit(100);

      if (cancelled) return;

      const rows = (data ?? []) as Array<{ id: string; title: string; created_at: string; project_id: string }>;

      setConversations(
        rows.map((r) => ({ id: r.id, projectId: r.project_id, title: r.title, createdAt: r.created_at })),
      );
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [setConversations]);

  const filtered = useMemo(() => {
    if (!query.trim()) return conversations;
    const q = query.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  // Deleted straight from the browser client rather than through a backend
  // route, matching the precedent set by projects (see routes/projects.ts's
  // comment): the owner-scoped RLS policy already enforces exactly this,
  // and a backend route would only duplicate it. Verified against the live
  // database that RLS hides other users' conversations, so a tampered id
  // deletes nothing. `messages` and `cortex_decisions` disappear via the
  // schema's existing ON DELETE CASCADE chain.
  //
  // Two-step confirm (click trash -> click again) instead of window.confirm:
  // a native dialog in the sidebar steals focus from the chat and reads as
  // heavier than this action warrants.
  const handleDelete = useCallback(
    async (id: string) => {
      setDeletingId(id);
      const supabase = createClient();
      const { error } = await supabase.from("conversations").delete().eq("id", id);
      setDeletingId(null);
      setConfirmingId(null);

      if (error) {
        console.error("[ConversationList] failed to delete conversation:", error);
        return;
      }

      removeConversation(id);
      // Only navigate away if the user just deleted the chat they're
      // looking at — deleting a different row from the sidebar shouldn't
      // yank them out of the conversation they're reading.
      if (pathname === `/chat/${id}`) {
        router.push("/chat");
        router.refresh();
      }
    },
    [pathname, removeConversation, router],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1">
        <SidebarSearch value={query} onChange={setQuery} />
      </div>

      <div className="flex flex-col gap-[3px]">
        <div className="px-3 pb-[7px] font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground">
          Conversations
        </div>
        {loading && <p className="px-3 py-1.5 text-[13.5px] text-muted-foreground">Loading…</p>}
        {!loading && filtered.length === 0 && (
          <p className="px-3 py-1.5 text-[13.5px] text-muted-foreground">No conversations yet.</p>
        )}
        {filtered.map((conversation) => {
          const href = `/chat/${conversation.id}`;
          const active = pathname === href;
          const confirming = confirmingId === conversation.id;
          const deleting = deletingId === conversation.id;
          return (
            <div key={conversation.id} className="group/row relative">
              <Link
                href={href}
                title={conversation.title}
                className={cn(
                  "flex items-center gap-[9px] rounded-[7px] py-2 pl-3 pr-2 text-[13.5px] text-foreground transition-colors",
                  active ? "bg-hover" : "hover:bg-hover",
                )}
              >
                <span
                  className="h-[5px] w-[5px] shrink-0 rounded-full"
                  style={{ background: active ? "var(--accent)" : "transparent" }}
                />
                {/* Reserves room on the right for whichever control is
                    showing, so the title truncates instead of being
                    overlaid by it. Confirm mode needs noticeably more
                    space than the single trash icon — caught live, where
                    "Delete / Cancel" sat on top of the title text. */}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate transition-[padding]",
                    confirming ? "pr-[92px]" : "group-hover/row:pr-6",
                  )}
                >
                  {conversation.title}
                </span>

                {/* The timestamp yields to the delete control on hover so
                    the row never grows or reflows. */}
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] text-muted-foreground transition-opacity",
                    confirming ? "opacity-0" : "group-hover/row:opacity-0",
                  )}
                >
                  {relativeTime(conversation.createdAt)}
                </span>
              </Link>

              <span
                className={cn(
                  "absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center transition-opacity",
                  confirming ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover/row:opacity-100",
                )}
              >
                {confirming ? (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleDelete(conversation.id)}
                      disabled={deleting}
                      className="rounded-[5px] bg-danger px-1.5 py-0.5 text-[10px] font-medium text-danger-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      {deleting ? "…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      disabled={deleting}
                      className="rounded-[5px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(conversation.id)}
                    aria-label={`Delete chat: ${conversation.title}`}
                    title="Delete chat"
                    className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-surface-raised hover:text-danger"
                  >
                    <Trash2 size={13} strokeWidth={1.6} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
