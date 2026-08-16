"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSidebarStore } from "@/state/sidebarStore";
import { SidebarSearch } from "./SidebarSearch";
import { cn } from "@/lib/cn";

export function ConversationList() {
  const pathname = usePathname();
  const collapsed = useSidebarStore((s) => s.collapsed);
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
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <SidebarSearch value={query} onChange={setQuery} />

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {!collapsed && loading && <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading...</p>}
        {!collapsed && !loading && filtered.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No conversations yet.</p>
        )}
        <ul className="space-y-0.5">
          {filtered.map((conversation) => {
            const href = `/chat/${conversation.id}`;
            const active = pathname === href;
            return (
              <li key={conversation.id}>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-accent-soft font-semibold text-accent"
                      : "text-muted-foreground hover:bg-surface-raised hover:text-foreground",
                  )}
                  title={conversation.title}
                >
                  <MessageSquare size={15} strokeWidth={1.75} className="shrink-0" />
                  {!collapsed && <span className="truncate">{conversation.title}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
