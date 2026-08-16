"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  const conversations = useSidebarStore((s) => s.conversations);
  const setConversations = useSidebarStore((s) => s.setConversations);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

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
          return (
            <Link
              key={conversation.id}
              href={href}
              title={conversation.title}
              className={cn(
                "flex items-center gap-[9px] rounded-[7px] px-3 py-2 text-[13.5px] text-foreground transition-colors",
                active ? "bg-hover" : "hover:bg-hover",
              )}
            >
              <span
                className="h-[5px] w-[5px] shrink-0 rounded-full"
                style={{ background: active ? "var(--accent)" : "transparent" }}
              />
              <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {relativeTime(conversation.createdAt)}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
