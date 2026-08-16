import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { CreateProjectForm } from "@/components/projects/CreateProjectForm";

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: projects } = await supabase
    .from("projects")
    .select("id, title, created_at, conversations(id)")
    .eq("type", "chat")
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto h-screen max-w-3xl overflow-y-auto px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-foreground">Projects</h1>
        <CreateProjectForm />
      </div>

      <ul className="mt-6 divide-y divide-border overflow-hidden rounded-[22px] border border-border bg-surface">
        {(projects ?? []).map((project) => {
          const conversationCount = (project.conversations as Array<{ id: string }> | null)?.length ?? 0;
          return (
            <li key={project.id}>
              <Link
                href={`/projects/${project.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm text-foreground transition-colors hover:bg-surface-raised"
              >
                <FolderKanban size={16} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{project.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {conversationCount} chat{conversationCount === 1 ? "" : "s"}
                </span>
              </Link>
            </li>
          );
        })}
        {(!projects || projects.length === 0) && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">No projects yet.</li>
        )}
      </ul>
    </div>
  );
}
