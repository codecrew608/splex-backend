"use client";

import { useRouter } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, SquarePen, FolderKanban, Brain, Settings, Sparkles, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSidebarStore } from "@/state/sidebarStore";
import { cn } from "@/lib/cn";
import { LogoMark } from "@/components/ui/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { SidebarNavItem } from "./SidebarNavItem";
import { ConversationList } from "./ConversationList";

interface SidebarProps {
  email: string;
}

export function Sidebar({ email }: SidebarProps) {
  const router = useRouter();
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside
      className={cn(
        "flex h-screen shrink-0 flex-col border-r border-border-hairline bg-sidebar backdrop-blur-xl backdrop-saturate-150 transition-[width] duration-150",
        collapsed ? "w-16" : "w-64",
      )}
      style={{ boxShadow: "var(--shadow-chrome)" }}
    >
      <div className="flex items-center justify-between px-3 py-4">
        {!collapsed && (
          <span className="flex items-center gap-2 px-1">
            <LogoMark size={22} />
            <span className="text-sm font-semibold tracking-tight text-foreground">SPLEX</span>
          </span>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground",
            collapsed && "mx-auto",
          )}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <div className="px-2">
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
          className="mb-3 flex w-full items-center gap-3 rounded-full bg-accent px-3.5 py-2 text-sm font-semibold text-accent-foreground shadow-[0_4px_12px_-4px_var(--accent-glow)] transition-all hover:bg-accent-hover hover:shadow-[0_6px_16px_-4px_var(--accent-glow)] active:scale-[0.98]"
        >
          <SquarePen size={17} strokeWidth={1.75} />
          {!collapsed && <span>New chat</span>}
        </button>
      </div>

      <div className="min-h-0 flex-1 px-2">
        <ConversationList />
      </div>

      <nav className="space-y-0.5 border-t border-border px-2 py-2">
        <SidebarNavItem icon={FolderKanban} label="Projects" href="/projects" />
        <SidebarNavItem icon={Brain} label="Memory" href="/memory" />
        <SidebarNavItem icon={Settings} label="Settings" href="/settings" />
      </nav>

      <div className="border-t border-border px-2 py-2">
        <button
          type="button"
          onClick={() => router.push("/upgrade")}
          className={cn(
            "mb-1 flex w-full items-center gap-3 rounded-full border border-accent/25 bg-accent-soft px-3.5 py-2 text-sm font-semibold text-accent transition-colors hover:border-accent/40 hover:bg-accent/15",
            collapsed && "justify-center px-0",
          )}
          title="Upgrade"
        >
          <Sparkles size={16} strokeWidth={1.75} className="shrink-0" />
          {!collapsed && <span>Upgrade plan</span>}
        </button>

        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-2",
            collapsed && "flex-col gap-2",
          )}
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
            {email.slice(0, 1).toUpperCase()}
          </div>
          {!collapsed && <span className="truncate text-xs text-muted-foreground">{email}</span>}
          <ThemeToggle className={collapsed ? undefined : "ml-auto"} />
          {!collapsed && (
            <button
              type="button"
              onClick={handleSignOut}
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-raised hover:text-foreground"
              title="Sign out"
            >
              <LogOut size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
