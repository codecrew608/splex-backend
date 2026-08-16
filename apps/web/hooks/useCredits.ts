"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface CreditsInfo {
  used: number;
  total: number;
  pct: number;
  loading: boolean;
}

const REFRESH_INTERVAL_MS = 20_000;

// Same query settings/page.tsx already runs server-side — pulled into a
// hook so the sidebar's credits bar reads the same real numbers instead
// of a placeholder. The sidebar has no direct line to "a message just
// finished streaming" (that state lives in ChatThread/useChatStream, a
// separate component) — rather than wire a cross-component event for it,
// this just refetches periodically and whenever the tab regains focus,
// which is enough to keep a background stat like this reasonably current
// without every consumer needing to know when to invalidate it.
export function useCredits(): CreditsInfo {
  const [state, setState] = useState<CreditsInfo>({ used: 0, total: 0, pct: 0, loading: true });

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

  useEffect(() => {
    load();
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
