"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface ProjectRow {
  id: string;
  title: string;
  count: number;
}

const SIDEBAR_LIMIT = 6;

export function ProjectsList() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      // Same query as app/(app)/projects/page.tsx — this is a preview of
      // that same list, not a separate definition of "project".
      const { data } = await supabase
        .from("projects")
        .select("id, title, conversations(id)")
        .eq("type", "chat")
        .order("created_at", { ascending: false })
        .limit(SIDEBAR_LIMIT);

      if (cancelled) return;
      const rows = (data ?? []) as Array<{ id: string; title: string; conversations: Array<{ id: string }> | null }>;
      setProjects(rows.map((p) => ({ id: p.id, title: p.title, count: p.conversations?.length ?? 0 })));
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loading && projects.length === 0) return null;

  return (
    <div className="flex flex-col gap-[3px]">
      <div className="px-3 pb-[7px] font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground">Projects</div>
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`/projects/${p.id}`}
          className="flex items-center gap-[10px] rounded-[7px] px-3 py-2 text-[13.5px] text-foreground transition-colors hover:bg-hover"
        >
          <FolderKanban size={14} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{p.title}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{p.count}</span>
        </Link>
      ))}
    </div>
  );
}
