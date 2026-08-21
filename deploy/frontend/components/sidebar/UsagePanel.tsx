"use client";

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

export function UsagePanel({ bordered = true, showLabel = true }: UsagePanelProps) {
  const { snapshot, loading, error } = useEntitlements();

  if (loading || error || !snapshot) return null;

  const rows = snapshot.quotas.filter(isDisplayable);
  if (rows.length === 0) return null;

  return (
    <div className={cn("flex flex-col gap-1.5", bordered && "border-t border-border pt-2.5")}>
      {showLabel && <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">Today&apos;s usage</span>}
      <div className="flex flex-col gap-1">
        {rows.map((q) => {
          const limit = q.limit as number;
          const atLimit = q.used >= limit;
          return (
            <div key={q.capability} className="flex items-baseline justify-between text-[11px]">
              <span className="text-muted-foreground">{q.label}</span>
              <span className={atLimit ? "font-medium text-danger" : "text-foreground"}>
                {atLimit ? "Limit reached" : `${q.used} / ${limit}`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
