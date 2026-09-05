"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Plus, Pencil } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/cn";

interface ProjectRow {
  id: string;
  title: string;
  count: number;
}

const SIDEBAR_LIMIT = 6;

export function ProjectsList() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
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

  // Direct client write — projects_owner_all (RLS) already scopes this to
  // the caller's own row, matching ConversationList's identical rename
  // pattern (see that file's own comment).
  function startEditing(project: ProjectRow) {
    setEditingId(project.id);
    setEditValue(project.title);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditValue("");
  }

  async function commitEditing() {
    const id = editingId;
    const project = projects.find((p) => p.id === id);
    const trimmed = editValue.trim();
    setEditingId(null);
    if (!id || !project || !trimmed || trimmed === project.title) return;

    const supabase = createClient();
    const { error } = await supabase.from("projects").update({ title: trimmed }).eq("id", id);
    if (error) {
      console.error("[ProjectsList] failed to rename project:", error);
      return;
    }
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, title: trimmed } : p)));
  }

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

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
      {projects.map((p) => {
        if (editingId === p.id) {
          return (
            <div key={p.id} className="flex items-center gap-[10px] rounded-[7px] px-3 py-[7px]">
              <FolderKanban size={14} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
              <input
                ref={editInputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEditing();
                  if (e.key === "Escape") cancelEditing();
                }}
                onBlur={commitEditing}
                autoFocus
                className="min-w-0 flex-1 rounded-[5px] border border-accent bg-surface px-1.5 py-0.5 text-[13.5px] text-foreground outline-none"
              />
            </div>
          );
        }

        return (
          <div key={p.id} className="group/row relative">
            <Link
              href={`/projects/${p.id}`}
              className="flex items-center gap-[10px] rounded-[7px] px-3 py-2 text-[13.5px] text-foreground transition-colors hover:bg-hover"
            >
              <FolderKanban size={14} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
              <span className={cn("min-w-0 flex-1 truncate", "group-hover/row:pr-5")}>{p.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground transition-opacity group-hover/row:opacity-0">
                {p.count}
              </span>
            </Link>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                startEditing(p);
              }}
              aria-label={`Rename project: ${p.title}`}
              title="Rename project"
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 transition-opacity hover:bg-surface-raised hover:text-accent focus-within:opacity-100 group-hover/row:opacity-100"
            >
              <Pencil size={12} strokeWidth={1.6} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
