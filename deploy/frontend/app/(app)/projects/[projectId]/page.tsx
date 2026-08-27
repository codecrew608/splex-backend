import Link from "next/link";
import { notFound } from "next/navigation";
import { MessageSquare, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

interface PageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectDetailPage({ params }: PageProps) {
  const { projectId } = await params;
  const supabase = await createClient();

  // RLS (projects_owner_all) is the actual authorization gate — this simply
  // returns nothing if the project isn't this user's.
  const { data: project } = await supabase
    .from("projects")
    .select("id, title, description")
    .eq("id", projectId)
    .single();
  if (!project) notFound();

  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, title, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto h-dvh max-w-3xl overflow-y-auto px-4 pb-10 pt-14 sm:px-6 sm:pt-10">
      <p className="text-xs text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>
        {" / "}
        {project.title}
      </p>
      <div className="mt-1 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-foreground">{project.title}</h1>
        <Link
          href={`/chat?projectId=${project.id}`}
          className="flex items-center gap-2 rounded-full bg-accent px-3.5 py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
        >
          <Plus size={15} />
          New chat in this project
        </Link>
      </div>
      {project.description && <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>}

      <ul className="mt-6 divide-y divide-border overflow-hidden rounded-[22px] border border-border bg-surface">
        {(conversations ?? []).map((conversation) => (
          <li key={conversation.id}>
            <Link
              href={`/chat/${conversation.id}`}
              className="flex items-center gap-3 px-4 py-3 text-sm text-foreground transition-colors hover:bg-surface-raised"
            >
              <MessageSquare size={16} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{conversation.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {new Date(conversation.created_at as string).toLocaleDateString()}
              </span>
            </Link>
          </li>
        ))}
        {(!conversations || conversations.length === 0) && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">
            No chats in this project yet — start one above.
          </li>
        )}
      </ul>
    </div>
  );
}
