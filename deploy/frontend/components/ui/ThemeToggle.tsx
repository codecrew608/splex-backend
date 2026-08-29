"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useThemeStore } from "@/state/themeStore";
import { cn } from "@/lib/cn";

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  // getInitialTheme() reads the real DOM/localStorage state synchronously,
  // so the client's first render (during hydration) already knows the true
  // theme — but the server always rendered as if it were "light" (it has
  // no DOM to read). Gating on `mounted` forces that first client render
  // to match the server's "light" assumption exactly, then corrects on
  // the very next tick once mounted flips true — avoiding the hydration
  // mismatch instead of just silencing its warning.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground sm:h-8 sm:w-8 transition-colors hover:bg-surface-raised hover:text-foreground",
        className,
      )}
    >
      {isDark ? <Sun size={16} strokeWidth={1.75} /> : <Moon size={16} strokeWidth={1.75} />}
    </button>
  );
}
