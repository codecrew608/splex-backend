"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useSidebarStore } from "@/state/sidebarStore";

export interface CreditsInfo {
  used: number;
  total: number;
  pct: number;
  loading: boolean;
}

// Long backstop only — the real trigger is creditsVersion below, bumped
// the instant a message actually finishes (see useChatStream). This
// interval just catches changes this tab wouldn't otherwise know about,
// e.g. the fake checkout (or a cancellation) completing in another tab.
const REFRESH_INTERVAL_MS = 60_000;

// Same query settings/page.tsx already runs server-side — pulled into a
// hook so the sidebar's credits bar reads the same real numbers instead
// of a placeholder.
export function useCredits(): CreditsInfo {
  const [state, setState] = useState<CreditsInfo>({ used: 0, total: 0, pct: 0, loading: true });
  const creditsVersion = useSidebarStore((s) => s.creditsVersion);

  const load = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile } = await supabase.from("users").select("plan_tier").eq("id", user.id).single();
    const planTier = profile?.plan_tier ?? "free";

    const [{ data: usageRow }, { data: limitRow }] = await Promise.all([
      supabase
        .from("usage_counters")
        .select("used")
        .eq("user_id", user.id)
        .eq("counter_type", "credits")
        .order("period_start", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("plan_limits").select("limit_amount").eq("plan_tier", planTier).eq("counter_type", "credits").single(),
    ]);

    const used = usageRow?.used ?? 0;
    const total = limitRow?.limit_amount ?? 0;
    setState({ used, total, pct: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0, loading: false });
  }, []);

  // Fires on mount and again immediately whenever bumpCredits() is called
  // (a message just finished) — this is the real, responsive path.
  useEffect(() => {
    load();
  }, [load, creditsVersion]);

  useEffect(() => {
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  return state;
}
