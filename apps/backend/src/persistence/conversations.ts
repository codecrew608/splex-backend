import type { FastifyInstance } from "fastify";

export interface ResolvedConversation {
  conversationId: string;
  isNew: boolean;
}

function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || "New chat";
}

// Verifies ownership of an existing conversation, attaches a new
// conversation to an existing project the caller owns, or (default) creates
// a new projects{type:'chat'} + conversations pair for a brand-new
// standalone chat. Ownership checks go through the conversations/projects
// join, matching the RLS policy shape (though this runs on the service-role
// client, so RLS doesn't apply — the check here is the actual authorization
// gate).
export async function resolveConversation(
  fastify: FastifyInstance,
  userId: string,
  conversationId: string | undefined,
  firstMessage: string,
  projectId?: string,
): Promise<ResolvedConversation> {
  if (conversationId) {
    const { data, error } = await fastify.supabaseAdmin
      .from("conversations")
      .select("id, projects!inner(user_id)")
      .eq("id", conversationId)
      .single();

    if (error || !data || (data as unknown as { projects: { user_id: string } }).projects.user_id !== userId) {
      throw new Error("Conversation not found or not owned by this user.");
    }

    return { conversationId, isNew: false };
  }

  let resolvedProjectId: string;

  if (projectId) {
    // Starting a new chat inside an existing, user-created project — verify
    // ownership before attaching anything to it.
    const { data: project, error: projectError } = await fastify.supabaseAdmin
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .eq("user_id", userId)
      .single();

    if (projectError || !project) {
      throw new Error("Project not found or not owned by this user.");
    }

    resolvedProjectId = project.id as string;
  } else {
    // Default, unchanged behavior: every plain "New chat" gets its own
    // dedicated 1:1 project.
    const { data: project, error: projectError } = await fastify.supabaseAdmin
      .from("projects")
      .insert({ user_id: userId, title: titleFromMessage(firstMessage), type: "chat" })
      .select("id")
      .single();

    if (projectError || !project) {
      throw new Error("Failed to create a new project for this conversation.");
    }

    resolvedProjectId = project.id as string;
  }

  const { data: conversation, error: conversationError } = await fastify.supabaseAdmin
    .from("conversations")
    .insert({ project_id: resolvedProjectId, title: titleFromMessage(firstMessage) })
    .select("id")
    .single();

  if (conversationError || !conversation) {
    throw new Error("Failed to create a new conversation.");
  }

  return { conversationId: conversation.id as string, isNew: true };
}
