import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { SupabaseConfigWarning } from "./SupabaseConfigWarning";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4">
      <ThemeToggle className="absolute right-4 top-4 z-10" />
      <div
        className="relative w-full max-w-sm animate-fade-in-up rounded-xl border border-border-strong bg-surface-raised p-8"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <SupabaseConfigWarning />
        {children}
      </div>
    </div>
  );
}
