"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Settings, Brain, Moon, Sun, LogOut, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSidebarStore } from "@/state/sidebarStore";
import { useThemeStore } from "@/state/themeStore";
import { useUserPlanTier } from "@/hooks/useUserPlanTier";
import { useCredits } from "@/hooks/useCredits";
import { cn } from "@/lib/cn";
import { Logo } from "@/components/ui/Logo";
import { ConversationList } from "./ConversationList";
import { ProjectsList } from "./ProjectsList";
import { FilesList } from "./FilesList";

interface SidebarProps {
  email: string;
}

const MOBILE_QUERY = "(max-width: 900px)";

export function Sidebar({ email }: SidebarProps) {
  const router = useRouter();
  const open = useSidebarStore((s) => s.open);
  const toggleOpen = useSidebarStore((s) => s.toggleOpen);
  const setOpen = useSidebarStore((s) => s.setOpen);
  const isMobile = useSidebarStore((s) => s.isMobile);
  const setIsMobile = useSidebarStore((s) => s.setIsMobile);
  const planTier = useUserPlanTier();
  const credits = useCredits();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const isDark = theme === "dark";
  const remainingPct = credits.total > 0 ? 100 - credits.pct : 100;

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = (matches: boolean) => {
      setIsMobile(matches);
      if (matches) setOpen(false);
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
    // Runs once on mount only — deliberately not re-subscribing on every
    // setIsMobile/setOpen identity change (those are stable zustand setters).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  if (!open) return null;

  return (
    <>
      {isMobile && (
        <div
          onClick={toggleOpen}
          aria-hidden
          className="fixed inset-0 z-30 animate-fade-in bg-black/[0.34]"
        />
      )}
      <aside
        className={cn(
          "flex h-screen w-[264px] shrink-0 flex-col border-r border-border bg-surface",
          isMobile ? "fixed inset-y-0 left-0 z-40 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.45)]" : "relative",
        )}
      >
        <div className="flex items-center justify-between gap-2.5 px-4 pb-[14px] pt-5">
          <Logo size={26} />
          <button
            type="button"
            onClick={toggleOpen}
            title="Collapse sidebar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <ChevronLeft size={16} strokeWidth={1.5} />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-3.5">
          <button
            type="button"
            onClick={() => {
              // Deliberately a full browser navigation, not router.push.
              // useChatStream updates the URL after a new conversation is
              // created via window.history.replaceState (not a real Next.js
              // navigation, to avoid remounting mid-stream — see its own
              // comment) — which means Next's router never learns we
              // "moved" to /chat/[id]; its internal state still thinks
              // we're on /chat. So a later router.push("/chat") here is a
              // no-op from the router's point of view (already "there"),
              // and the stale ChatThread instance — with its own
              // conversationId state still pointing at the old conversation
              // — just keeps rendering, silently appending the next message
              // to it instead of starting fresh (discovered live: a message
              // sent right after "New chat" landed in the previous
              // conversation). A real navigation always forces a fresh
              // mount regardless of what the router's internal state
              // thinks the current path already is.
              window.location.href = "/chat";
            }}
            className="flex w-full items-center gap-[10px] rounded-lg border border-border-strong bg-surface-raised px-3 py-[10px] text-left text-sm font-medium text-foreground transition-colors hover:border-accent"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M8 3.2V12.8M3.2 8H12.8" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            New chat
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3.5 pb-[10px] pt-5">
          <div className="flex flex-col gap-[22px]">
            <ConversationList />
            <ProjectsList />
            <FilesList />
          </div>
        </div>

        <div className="flex flex-col gap-[2px] border-t border-border px-3.5 pb-3.5 pt-2.5">
          <button
            type="button"
            onClick={() => router.push("/memory")}
            className="flex w-full items-center gap-[10px] rounded-[7px] px-3 py-2 text-left text-[13.5px] text-foreground transition-colors hover:bg-hover"
          >
            <Brain size={15} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
            Memory
          </button>
          <button
            type="button"
            onClick={() => router.push("/settings")}
            className="flex w-full items-center gap-[10px] rounded-[7px] px-3 py-2 text-left text-[13.5px] text-foreground transition-colors hover:bg-hover"
          >
            <Settings size={15} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
            Settings
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-[10px] rounded-[7px] px-3 py-2 text-left text-[13.5px] text-foreground transition-colors hover:bg-hover"
          >
            {isDark ? (
              <Moon size={15} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
            ) : (
              <Sun size={15} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
            )}
            <span className="flex-1">{isDark ? "Dark theme" : "Light theme"}</span>
            <span
              className="flex h-[17px] w-[30px] items-center rounded-full p-[2px] transition-colors"
              style={{ background: isDark ? "var(--accent)" : "var(--border-strong)", justifyContent: isDark ? "flex-end" : "flex-start" }}
            >
              <span className="h-[13px] w-[13px] rounded-full bg-surface-raised shadow-[0_1px_2px_rgba(0,0,0,0.2)]" />
            </span>
          </button>

          <div className="mt-[9px] flex flex-col gap-[11px] rounded-lg border border-border bg-surface-raised px-[13px] py-3">
            <div className="flex items-center gap-[10px]">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold tracking-[0.04em] text-accent">
                {email.slice(0, 1).toUpperCase()}
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                <span className="truncate text-[13px] font-medium text-foreground">{email}</span>
                <span className="text-[11.5px] text-muted-foreground">{planTier === "pro" ? "Pro plan" : "Free plan"}</span>
              </span>
              {planTier === "free" && (
                <button
                  type="button"
                  onClick={() => router.push("/upgrade")}
                  className="flex shrink-0 items-center gap-1 rounded-[5px] border border-border-strong px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
                >
                  <Sparkles size={11} strokeWidth={1.75} />
                  Upgrade
                </button>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
                <span>SPLEX Credits Remaining</span>
                <span className="text-foreground">{credits.loading ? "…" : `${remainingPct}%`}</span>
              </div>
              <span className="block h-1 overflow-hidden rounded-[3px] bg-hover">
                <span
                  className="block h-full rounded-[3px] bg-accent transition-[width]"
                  style={{ width: `${credits.loading ? 0 : remainingPct}%` }}
                />
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="mt-[2px] flex w-full items-center gap-[10px] rounded-[7px] px-3 py-2 text-left text-[13.5px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
          >
            <LogOut size={15} strokeWidth={1.4} className="shrink-0" />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
