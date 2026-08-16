"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useSidebarStore } from "@/state/sidebarStore";

interface SidebarNavItemProps {
  icon: LucideIcon;
  label: string;
  href?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export function SidebarNavItem({ icon: Icon, label, href, disabled, onClick }: SidebarNavItemProps) {
  const pathname = usePathname();
  const collapsed = useSidebarStore((s) => s.collapsed);
  const active = href ? pathname === href || pathname.startsWith(`${href}/`) : false;

  const content = (
    <span
      className={cn(
        "group relative flex items-center gap-3 rounded-full px-3 py-2 text-sm transition-colors",
        active ? "bg-accent-soft font-semibold text-accent" : "text-muted-foreground hover:bg-surface-raised hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      <Icon size={17} strokeWidth={1.75} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      {!collapsed && disabled && (
        <span className="ml-auto rounded-full border border-border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          Soon
        </span>
      )}
    </span>
  );

  if (disabled) {
    return <div title="Coming soon">{content}</div>;
  }

  if (href) {
    return (
      <Link href={href} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      {content}
    </button>
  );
}
