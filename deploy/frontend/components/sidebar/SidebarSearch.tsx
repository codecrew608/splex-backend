"use client";

import { Search } from "lucide-react";
import { useSidebarStore } from "@/state/sidebarStore";

interface SidebarSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function SidebarSearch({ value, onChange }: SidebarSearchProps) {
  const collapsed = useSidebarStore((s) => s.collapsed);

  if (collapsed) return null;

  return (
    <div className="relative px-1">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search conversations"
        className="w-full rounded-full border border-border bg-surface py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />
    </div>
  );
}
