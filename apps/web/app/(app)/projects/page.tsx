import Link from "next/link";
import { FolderKanban, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/Button";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: projects } = await supabase
    .from("projects")
    .select("id, title, description, created_at, conversations(id)")
    .eq("type", "chat")
    // Real projects only — the auto-created container behind every
    // standalone chat is filtered out here. Without this, the list was
    // every chat the user had ever sent. See migration 0023.
    .eq("is_implicit", false)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto h-dvh max-w-3xl overflow-y-auto px-4 pb-10 pt-14 sm:px-6 sm:pt-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-foreground">Projects</h1>
        <Link href="/projects/new">
          <Button variant="secondary" className="gap-2">
            <Plus size={15} />
            New project
          </Button>
        </Link>
      </div>

      <ul className="mt-6 divide-y divide-border overflow-hidden rounded-[22px] border border-border bg-surface">
        {(projects ?? []).map((project) => {
          const conversationCount = (project.conversations as Array<{ id: string }> | null)?.length ?? 0;
          return (
            <li key={project.id}>
              <Link
                href={`/projects/${project.id}`}
                className="flex items-start gap-3 px-4 py-3 text-sm text-foreground transition-colors hover:bg-surface-raised"
              >
                <FolderKanban size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{project.title}</span>
                  {project.description && (
                    <span className="truncate text-xs text-muted-foreground">{project.description}</span>
                  )}
                </span>
                <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
                  {conversationCount} chat{conversationCount === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          );
        })}
        {(!projects || projects.length === 0) && (
          <li className="px-4 py-8 text-center text-sm text-muted-foreground">
            No projects yet.{" "}
            <Link href="/projects/new" className="text-accent hover:underline">
              Create your first one
            </Link>
            .
          </li>
        )}
      </ul>
    </div>
  );
}
