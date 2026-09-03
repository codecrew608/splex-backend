"use client";

import { useEffect, useRef, useState } from "react";
import { useEntitlements } from "@/hooks/useEntitlements";
import { cn } from "@/lib/cn";
import type { QuotaState } from "@/shared-types";

// Only capabilities with a real numeric cap are worth a row here — an
// unlimited quota (limit === null, e.g. Starter's messages) would just
// render as noise, and a capability the plan doesn't include at all
// (limit === 0, e.g. video on Free) is better communicated by the upgrade
// prompt than by a permanently-full "0 / 0" bar.
function isDisplayable(q: QuotaState): boolean {
  return q.limit !== null && q.limit > 0;
}

interface UsagePanelProps {
  // Sidebar shows this appended under the credits bar (needs its own
  // top divider + label). Settings shows it inside its own card (the card
  // already provides both) — see app/(app)/settings/page.tsx.
  bordered?: boolean;
  showLabel?: boolean;
}

// Flashes briefly whenever a capability's `used` count actually changes —
// this panel previously had no visual feedback at all beyond the number
// itself swapping instantly, which reads as "nothing happened" even when
// a fresh, correct count just landed from the server. Purely cosmetic:
// the number itself is always the current authoritative value regardless
// of whether the flash fires (a missed animation is never a stale read).
function UsageRow({ quota }: { quota: QuotaState }) {
  const limit = quota.limit as number;
  const atLimit = quota.used >= limit;
  const prevUsed = useRef(quota.used);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prevUsed.current !== quota.used) {
      setFlash(true);
      prevUsed.current = quota.used;
      const t = setTimeout(() => setFlash(false), 600);
      return () => clearTimeout(t);
    }
  }, [quota.used]);

  return (
    <div className="flex items-baseline justify-between text-[11px]">
      <span className="text-muted-foreground">{quota.label}</span>
      <span
        className={cn(
          "transition-colors duration-500",
          atLimit ? "font-medium text-danger" : flash ? "font-medium text-accent" : "text-foreground",
        )}
      >
        {atLimit ? "Limit reached" : `${quota.used} / ${limit}`}
      </span>
    </div>
  );
}

export function UsagePanel({ bordered = true, showLabel = true }: UsagePanelProps) {
  const { snapshot, loading, error } = useEntitlements();

  if (loading || error || !snapshot) return null;

  const rows = snapshot.quotas.filter(isDisplayable);
  if (rows.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-1.5", bordered && "border-t border-border pt-2.5")}>
      {showLabel && <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Today&apos;s usage</span>}
      <div className="flex flex-col gap-1">
        {rows.map((q) => (
          <UsageRow key={q.capability} quota={q} />
        ))}
      </div>
    </div>
  );
}
