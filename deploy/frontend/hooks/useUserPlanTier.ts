"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { PlanTier } from "@/shared-types";

export function useUserPlanTier(): PlanTier {
  const [planTier, setPlanTier] = useState<PlanTier>("free");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from("users").select("plan_tier").eq("id", user.id).single();
      if (!cancelled && data) setPlanTier(data.plan_tier as PlanTier);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return planTier;
}
