"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MessageSquare, Pencil } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
}

interface ProjectConversationListProps {
  initialConversations: ConversationRow[];
}

// Same direct-client rename pattern as the sidebar's ConversationList (see
// that file's own comment) — conversations_owner_all (RLS) already scopes
// the update to the caller's own row, so a backend route would only
// duplicate that check. Kept as its own self-contained copy rather than a
// shared hook: this is the second real instance of this logic, but the
// two components manage genuinely different local state shapes, and
// touching ConversationList's already-working version for this wasn't
// asked for.
export function ProjectConversationList({ initialConversations }: ProjectConversationListProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId) editInputRef.current?.select();
  }, [editingId]);

  function startEditing(conversation: ConversationRow) {
    setEditingId(conversation.id);
    setEditValue(conversation.title);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditValue("");
  }

  async function commitEditing() {
    const id = editingId;
    const conversation = conversations.find((c) => c.id === id);
    const trimmed = editValue.trim();
    setEditingId(null);
    if (!id || !conversation || !trimmed || trimmed === conversation.title) return;

    const supabase = createClient();
    const { error } = await supabase.from("conversations").update({ title: trimmed }).eq("id", id);
    if (error) {
      console.error("[ProjectConversationList] failed to rename conversation:", error);
      return;
    }
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
  }

  if (conversations.length === 0) {
    return (
      <ul className="mt-6 overflow-hidden rounded-[22px] border border-border bg-surface">
        <li className="px-4 py-6 text-center text-sm text-muted-foreground">No chats in this project yet — start one above.</li>
      </ul>
    );
  }

  return (
    <ul className="mt-6 divide-y divide-border overflow-hidden rounded-[22px] border border-border bg-surface">
      {conversations.map((conversation) => {
        if (editingId === conversation.id) {
          return (
            <li key={conversation.id} className="flex items-center gap-3 px-4 py-2.5">
              <MessageSquare size={16} className="shrink-0 text-muted-foreground" />
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
                className="min-w-0 flex-1 rounded-md border border-accent bg-surface-raised px-2 py-1 text-sm text-foreground outline-none"
              />
            </li>
          );
        }

        return (
          <li key={conversation.id} className="group/row relative">
            <Link
              href={`/chat/${conversation.id}`}
              className="flex items-center gap-3 px-4 py-3 text-sm text-foreground transition-colors hover:bg-surface-raised"
            >
              <MessageSquare size={16} className="shrink-0 text-muted-foreground" />
              <span className="truncate pr-6 group-hover/row:pr-12">{conversation.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground transition-opacity group-hover/row:opacity-0">
                {new Date(conversation.created_at).toLocaleDateString()}
              </span>
            </Link>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                startEditing(conversation);
              }}
              aria-label={`Rename chat: ${conversation.title}`}
              title="Rename chat"
              className="absolute right-3 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-hover hover:text-accent focus-within:opacity-100 group-hover/row:opacity-100"
            >
              <Pencil size={13} strokeWidth={1.6} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
