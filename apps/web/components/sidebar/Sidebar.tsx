"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Settings, Moon, Sun, LogOut, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { BACKEND_URL } from "@/lib/backendUrl";
import { useSidebarStore } from "@/state/sidebarStore";
import { useThemeStore } from "@/state/themeStore";
import { useUserPlanTier } from "@/hooks/useUserPlanTier";
import { planDisplayName } from "@/lib/planDisplay";
import { cn } from "@/lib/cn";
import { Logo } from "@/components/ui/Logo";
import { ConversationList } from "./ConversationList";
import { ProjectsList } from "./ProjectsList";
import { FilesList } from "./FilesList";
import { UsagePanel } from "./UsagePanel";

interface SidebarProps {
  email: string;
  avatarUrl?: string | null;
}

const MOBILE_QUERY = "(max-width: 900px)";

export function Sidebar({ email, avatarUrl }: SidebarProps) {
  const router = useRouter();
  const open = useSidebarStore((s) => s.open);
  const toggleOpen = useSidebarStore((s) => s.toggleOpen);
  const setOpen = useSidebarStore((s) => s.setOpen);
  const isMobile = useSidebarStore((s) => s.isMobile);
  const setIsMobile = useSidebarStore((s) => s.setIsMobile);
  const planTier = useUserPlanTier();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  // Pre-existing hydration mismatch, live-caught while working in this file
  // for an unrelated reason: themeStore's initial value is "light" during
  // SSR (no `document` server-side) but reads the real DOM/localStorage
  // theme on the client — so for any user actually preferring dark theme,
  // the server-rendered Sun/Moon icon and label here would disagree with
  // the client's first render. components/ui/ThemeToggle.tsx already
  // solves this exact problem with a `mounted` gate; this hand-rolled
  // toggle just never had the same guard applied.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && theme === "dark";

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

  // Region-aware credit/usage reset (migration 0044) needs a real
  // users.timezone value. OnboardingModal.tsx already captures this for
  // brand-new signups; this covers everyone who completed onboarding
  // before that existed (or moved timezones since). Sidebar is mounted
  // exactly once per authenticated app-shell session (app/(app)/layout.tsx
  // doesn't remount it on client-side navigation), so a sessionStorage
  // guard is enough to keep this to one best-effort call per browser tab
  // session rather than one per page. Deliberately fire-and-forget: never
  // blocks rendering, never surfaces an error to the user — see
  // syncTimezone's own comment for why a failure here is silently fine.
  useEffect(() => {
    const FLAG = "splex:tz-synced";
    if (typeof window === "undefined" || sessionStorage.getItem(FLAG)) return;
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (cancelled || !session) return;
        await fetch(`${BACKEND_URL}/account/timezone`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        });
      } catch {
        // Best-effort — next session tries again (flag is per-tab-session,
        // not persisted), nothing here should ever affect the visible UI.
      } finally {
        if (!cancelled) sessionStorage.setItem(FLAG, "1");
      }
    })();
    return () => {
      cancelled = true;
    };
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
          // max-w-[86vw] so the overlay never covers the whole screen on a
          // narrow phone — a sliver of the dimmed chat stays visible, which
          // is what makes it read as a dismissible panel rather than a
          // navigation the user got stuck in.
          "flex h-dvh w-[264px] max-w-[86vw] shrink-0 flex-col border-r border-border bg-surface",
          isMobile ? "fixed inset-y-0 left-0 z-40 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.45)]" : "relative",
        )}
      >
        <div className="flex items-center justify-between gap-2.5 px-4 pb-[14px] pt-5">
          <Logo size={26} />
          <button
            type="button"
            onClick={toggleOpen}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
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
              <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-soft text-[11px] font-semibold tracking-[0.04em] text-accent">
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URL, not a local/optimizable asset
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  email.slice(0, 1).toUpperCase()
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
                <span className="truncate text-[13px] font-medium text-foreground">{email}</span>
                <span className="text-[11.5px] text-muted-foreground">{planDisplayName(planTier)} plan</span>
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
            {/* Plan name + capability usage only — deliberately no SPLEX
                credit balance or progress bar here. SPLEX credits are an
                internal backend metering unit, never a product-facing
                number (see UsagePanel: capability limits like "3/5 images
                today" are legitimate product UX and stay; the underlying
                credit currency that prices them never surfaces). */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
                <span>{planDisplayName(planTier)}</span>
              </div>
              <UsagePanel bordered={false} showLabel={false} />
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
