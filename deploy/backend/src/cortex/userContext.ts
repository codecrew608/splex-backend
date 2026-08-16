import type { FastifyInstance } from "fastify";

// A conversation always belongs to a project (even the default
// auto-created 1:1 one), but the model never learned that until now — see
// systemPrompt.ts's projectContextBlock. One query, reused across an
// entire request (including every step of a workflow), never re-fetched.
export async function buildProjectContext(fastify: FastifyInstance, conversationId: string): Promise<string | null> {
  const { data, error } = await fastify.supabaseAdmin
    .from("conversations")
    .select("projects!inner(title)")
    .eq("id", conversationId)
    .maybeSingle();

  if (error || !data) return null;
  const project = data.projects as unknown as { title: string } | null;
  return project?.title ?? null;
}
