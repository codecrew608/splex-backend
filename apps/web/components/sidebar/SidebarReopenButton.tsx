"use client";

import { Menu } from "lucide-react";
import { useSidebarStore } from "@/state/sidebarStore";

// Sidebar.tsx renders nothing at all when closed (the reference's
// "sidebarOpen" pattern — no icon rail) — this is the only way back in,
// rendered by (app)/layout.tsx alongside it. Fixed-position so it works
// the same regardless of whether a given page has its own header.
export function SidebarReopenButton() {
  const open = useSidebarStore((s) => s.open);
  const toggleOpen = useSidebarStore((s) => s.toggleOpen);

  if (open) return null;

  return (
    <button
      type="button"
      onClick={toggleOpen}
      title="Open sidebar"
      className="fixed left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
    >
      <Menu size={17} strokeWidth={1.5} />
    </button>
  );
}
