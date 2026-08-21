import { create } from "zustand";
import { createClient } from "@/lib/supabase/client";
import { BACKEND_URL } from "@/lib/backendUrl";
import type { EntitlementSnapshot } from "@splex/shared-types";

interface EntitlementsState {
  snapshot: EntitlementSnapshot | null;
  loading: boolean;
  error: boolean;
  load: () => Promise<void>;
}

// Backend-authoritative — deliberately does NOT query plan_limits or
// generated_media from the browser (generated_media is default-deny to the
// client anyway). Everything shown in the usage panel comes from
// GET /entitlements so the frontend can't draw its own wrong conclusions,
// which is exactly how the "100% remaining" bug happened.
//
// A real Zustand store, not a per-component useState — useEntitlements()
// used to own its fetch/interval/focus-listener per hook instance, so
// Sidebar + UsagePanel + ComposerMenu mounted together (every chat page
// load) meant 2-3 independent GET /entitlements requests, 2-3 independent
// 60s timers, and 2-3 independent focus listeners all doing the same
// work. This store fetches once and every consumer reads the same state.
export const useEntitlementsStore = create<EntitlementsState>((set) => ({
  snapshot: null,
  loading: true,
  error: false,
  load: async () => {
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch(`${BACKEND_URL}/entitlements`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        set({ snapshot: null, loading: false, error: true });
        return;
      }
      set({ snapshot: (await res.json()) as EntitlementSnapshot, loading: false, error: false });
    } catch {
      set({ snapshot: null, loading: false, error: true });
    }
  },
}));

const REFRESH_INTERVAL_MS = 60_000;

// Module-scope, not component-scope — runs exactly once no matter how many
// components use the hook below, guarded so hot-reload in dev doesn't
// double-register it.
declare global {
  // eslint-disable-next-line no-var
  var __splexEntitlementsPollerStarted: boolean | undefined;
}

export function ensureEntitlementsPolling(): void {
  if (typeof window === "undefined" || globalThis.__splexEntitlementsPollerStarted) return;
  globalThis.__splexEntitlementsPollerStarted = true;

  const load = useEntitlementsStore.getState().load;
  load();
  setInterval(load, REFRESH_INTERVAL_MS);
  window.addEventListener("focus", load);
}
