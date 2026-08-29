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
  // Drops a conversation from the list without a refetch, so the row
  // disappears the moment the delete succeeds rather than after the
  // sidebar's next load.
  removeConversation: (id: string) => void;
  // Bumped by useChatStream whenever a message finishes (a real credit
  // charge just landed server-side) — useEntitlements watches this and
  // refetches immediately, instead of the sidebar's credits bar only
  // catching up on its next timer tick or tab focus. ChatThread and
  // Sidebar are siblings with no direct prop path between them, so this
  // goes through the store both already depend on rather than adding a
  // new one just for this.
  creditsVersion: number;
  bumpCredits: () => void;
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
  removeConversation: (id) =>
    set((state) => ({ conversations: state.conversations.filter((c) => c.id !== id) })),
  creditsVersion: 0,
  bumpCredits: () => set((state) => ({ creditsVersion: state.creditsVersion + 1 })),
}));
