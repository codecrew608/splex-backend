import { create } from "zustand";
import type { Conversation } from "@splex/shared-types";

interface SidebarState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  conversations: Conversation[];
  setConversations: (conversations: Conversation[]) => void;
  upsertConversation: (conversation: Conversation) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  collapsed: false,
  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
  conversations: [],
  setConversations: (conversations) => set({ conversations }),
  upsertConversation: (conversation) =>
    set((state) => {
      const exists = state.conversations.some((c) => c.id === conversation.id);
      return {
        conversations: exists
          ? state.conversations.map((c) => (c.id === conversation.id ? conversation : c))
          : [conversation, ...state.conversations],
      };
    }),
}));
