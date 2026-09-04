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

// Deliberately no digits anywhere in this row — not "used", not "limit",
// not a percentage. Only a fill bar, whose WIDTH is what animates against
// real usage (a CSS transition on `width`, driven straight by the
// authoritative used/limit ratio from the server — no separate flash
// timer needed the way the old numeric version had, since the bar moving
// already IS the animation). This is intentionally coarser information
// than the old "12 / 25" text: enough to see a capability filling up at a
// glance, never enough to reverse-engineer exact request counts or
// anything cost-shaped from it.
function UsageRow({ quota }: { quota: QuotaState }) {
  const limit = quota.limit as number;
  const atLimit = quota.used >= limit;
  const percent = Math.min(100, Math.max(0, (quota.used / limit) * 100));

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{quota.label}</span>
        {atLimit && <span className="font-medium text-danger">Limit reached</span>}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-border">
        <div
          className={cn("h-full rounded-full transition-[width] duration-700 ease-out", atLimit ? "bg-danger" : "bg-accent")}
          style={{ width: `${percent}%` }}
        />
      </div>
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
