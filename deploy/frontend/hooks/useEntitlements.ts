"use client";

import { useEffect } from "react";
import { useSidebarStore } from "@/state/sidebarStore";
import { useEntitlementsStore, ensureEntitlementsPolling } from "@/state/entitlementsStore";
import type { EntitlementSnapshot } from "@/shared-types";

export interface EntitlementsInfo {
  snapshot: EntitlementSnapshot | null;
  loading: boolean;
  error: boolean;
}

// Thin wrapper over the shared entitlementsStore (state fetched once,
// shared by every consumer — see that file's own comment for why this
// used to be a per-component fetch). Still per-hook-instance: reacting to
// creditsVersion (bumped the moment a generation finishes) so the credits
// bar updates immediately rather than waiting for the next 60s tick.
export function useEntitlements(): EntitlementsInfo {
  const snapshot = useEntitlementsStore((s) => s.snapshot);
  const loading = useEntitlementsStore((s) => s.loading);
  const error = useEntitlementsStore((s) => s.error);
  const load = useEntitlementsStore((s) => s.load);
  const creditsVersion = useSidebarStore((s) => s.creditsVersion);

  useEffect(() => {
    ensureEntitlementsPolling();
  }, []);

  // Skip the very first mount (creditsVersion === 0, ensureEntitlementsPolling
  // above already triggers the initial load) — only reload on a real bump.
  useEffect(() => {
    if (creditsVersion > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditsVersion]);

  return { snapshot, loading, error };
}
