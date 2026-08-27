"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
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
  // Creating a project ends in router.push("/projects/[id]") — a
  // client-side navigation, so this component never remounts and a
  // mount-only fetch would leave the newly created project missing from
  // the sidebar until a hard reload. Re-fetching per pathname is enough:
  // the create flow always navigates, as does deleting or opening one.
  const pathname = usePathname();

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
        // Real projects only. Without this every standalone chat appeared
        // here as its own "project" — see migration 0023.
        .eq("is_implicit", false)
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
  }, [pathname]);

  // Renders even with zero projects, unlike before — the section header is
  // now the entry point to the create flow, so hiding it when empty left a
  // brand-new user with no way to reach Projects at all.
  return (
    <div className="flex flex-col gap-[3px]">
      <div className="flex items-center gap-1 px-3 pb-[7px]">
        <Link
          href="/projects"
          className="font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground transition-colors hover:text-foreground"
        >
          Projects
        </Link>
        <span className="flex-1" />
        <Link
          href="/projects/new"
          title="New project"
          className="flex h-[18px] w-[18px] items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover hover:text-accent"
        >
          <Plus size={13} strokeWidth={1.8} />
        </Link>
      </div>
      {!loading && projects.length === 0 && (
        <Link
          href="/projects/new"
          className="rounded-[7px] px-3 py-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          No projects yet — create one
        </Link>
      )}
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
