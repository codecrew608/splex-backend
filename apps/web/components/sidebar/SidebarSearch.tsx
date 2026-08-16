"use client";

import { Search } from "lucide-react";

interface SidebarSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function SidebarSearch({ value, onChange }: SidebarSearchProps) {
  return (
    <div className="flex items-center gap-[9px] rounded-lg bg-hover px-3 py-[9px]">
      <Search size={15} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search conversations"
        className="w-full bg-transparent text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none"
      />
    </div>
  );
}
