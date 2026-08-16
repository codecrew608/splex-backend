import { ChatThread } from "@/components/chat/ChatThread";

interface PageProps {
  searchParams: Promise<{ projectId?: string }>;
}

export default async function NewChatPage({ searchParams }: PageProps) {
  const { projectId } = await searchParams;
  // key forces a fresh ChatThread/useChatStream instance on every visit to
  // this route — without it, React's reconciliation sees the same
  // component type in the same tree position across a client-side
  // navigation from /chat/[conversationId] (shared (app) layout never
  // unmounts) and reuses the existing instance instead of remounting, so
  // its internal conversationId/messages state silently carries over from
  // whatever conversation was open before "New chat" was clicked
  // (discovered live: a message sent right after "New chat" landed in the
  // previous conversation instead of starting a new one).
  return <ChatThread key={`new-${projectId ?? ""}`} initialMessages={[]} projectId={projectId} />;
}
