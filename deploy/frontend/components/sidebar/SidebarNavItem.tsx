"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface SidebarNavItemProps {
  icon: LucideIcon;
  label: string;
  href?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export function SidebarNavItem({ icon: Icon, label, href, disabled, onClick }: SidebarNavItemProps) {
  const pathname = usePathname();
  const active = href ? pathname === href || pathname.startsWith(`${href}/`) : false;

  const content = (
    <span
      className={cn(
        "flex w-full items-center gap-[10px] rounded-[7px] px-3 py-2 text-left text-[13.5px] text-foreground transition-colors",
        !active && "hover:bg-hover",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Icon size={15} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
      {disabled && (
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
