import type { ReactNode } from "react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    // No bg-background here, deliberately — the gradient canvas wash lives
    // on <body> (see globals.css) and this page is exactly where it should
    // show through uncovered, matching the reference's own hero context
    // most closely of any page in the app. The old dot-grid texture is
    // gone too: "no texture, no grain, no repeating pattern" is one of the
    // system's explicit rules, and this was the one place violating it.
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
      <ThemeToggle className="absolute right-4 top-4 z-10" />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-12%] h-[560px] w-[560px] -translate-x-1/2 rounded-full opacity-60 blur-[120px]"
        style={{ background: "radial-gradient(circle, var(--accent-glow), transparent 70%)" }}
      />
      <div
        className="relative w-full max-w-sm animate-fade-in-up rounded-[22px] border border-border-hairline bg-surface-glass p-8 backdrop-blur-md backdrop-saturate-150"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        {children}
      </div>
    </div>
  );
}
