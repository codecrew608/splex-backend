import type { FastifyInstance } from "fastify";

// Returns the project a conversation belongs to — but ONLY when it's a real
// project the user deliberately created and named.
//
// Every conversation has a project row because conversations.project_id is
// NOT NULL, and a plain "New chat" gets an auto-created container titled
// from the user's first message (persistence/conversations.ts). Feeding
// THAT title in as project context produced a live hallucination: a user
// whose first message was "hi" got a container named "hi", and the next
// turn the system prompt told the model "The user is working within a
// project called 'hi'" — so it duly announced it was "here to help with
// the hi project". The model was following instructions correctly; the
// instruction was fabricated.
//
// is_implicit (migration 0023) is exactly the flag that distinguishes the
// two, so filtering on it here is the precise fix: real projects still give
// the model genuine situational awareness, and synthetic containers
// contribute nothing rather than inventing a topic out of a greeting.
export interface ProjectContext {
  projectId: string;
  title: string;
}

export async function buildProjectContext(fastify: FastifyInstance, conversationId: string): Promise<ProjectContext | null> {
  const { data, error } = await fastify.supabaseAdmin
    .from("conversations")
    .select("projects!inner(id, title, is_implicit)")
    .eq("id", conversationId)
    .maybeSingle();

  if (error || !data) return null;
  const project = data.projects as unknown as { id: string; title: string; is_implicit: boolean } | null;
  if (!project || project.is_implicit) return null;
  return { projectId: project.id, title: project.title ?? "" };
}
