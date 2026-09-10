import { BACKEND_URL } from "@/lib/backendUrl";

export interface ProStatus {
  enabled: boolean;
  priceInrPerMonth: number;
  monthlyCredits: number;
  engineName: string;
}

const FALLBACK: ProStatus = { enabled: false, priceInrPerMonth: 799, monthlyCredits: 150000, engineName: "Cortex 2" };

// GET /pro/status is the one Pro endpoint that stays reachable while the
// feature is gated (see backend handlers/pro.ts) — price, credits, and the
// engine name below come from it live, not hardcoded, for the same reason
// the Free/Starter plan numbers on /upgrade come from plan_limits: this
// app already shipped stale marketing numbers once. Used by both the
// landing page (app/page.tsx, logged-out visitors) and /upgrade (signed-in
// visitors). If the backend is unreachable, fall back to a known-safe
// "still coming soon" shape rather than breaking either page.
export async function fetchProStatus(): Promise<ProStatus> {
  try {
    const res = await fetch(`${BACKEND_URL}/pro/status`, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    return {
      enabled: body.enabled === true,
      priceInrPerMonth: body.priceInrPerMonth ?? FALLBACK.priceInrPerMonth,
      monthlyCredits: body.monthlyCredits ?? FALLBACK.monthlyCredits,
      engineName: typeof body.engineName === "string" ? body.engineName : FALLBACK.engineName,
    };
  } catch (err) {
    console.error("fetchProStatus: /pro/status fetch failed", err);
    return FALLBACK;
  }
}
