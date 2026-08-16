import { create } from "zustand";
import type { Conversation } from "@/shared-types";

interface SidebarState {
  // Renamed from the old "collapsed" (narrow icon rail) concept — the
  // reference design has no rail state, the sidebar is either fully shown
  // or fully hidden (with a hamburger button in the main header to reopen
  // it), same on desktop and mobile.
  open: boolean;
  toggleOpen: () => void;
  setOpen: (open: boolean) => void;
  isMobile: boolean;
  setIsMobile: (isMobile: boolean) => void;
  conversations: Conversation[];
  setConversations: (conversations: Conversation[]) => void;
  upsertConversation: (conversation: Conversation) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  open: true,
  toggleOpen: () => set((state) => ({ open: !state.open })),
  setOpen: (open) => set({ open }),
  isMobile: false,
  setIsMobile: (isMobile) => set({ isMobile }),
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
