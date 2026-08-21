import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SecuritySection } from "@/components/settings/SecuritySection";
import { DangerZoneSection } from "@/components/settings/DangerZoneSection";
import { CancelSubscriptionButton } from "@/components/settings/CancelSubscriptionButton";
import { UsagePanel } from "@/components/sidebar/UsagePanel";
import { planDisplayName } from "@/lib/planDisplay";
import type { PlanTier } from "@/shared-types";

// Bare-date (not timestamp) period keys, Asia/Kolkata — matches the
// backend entitlement service's own convention (entitlements/index.ts).
// Filtering by the CURRENT period explicitly, rather than taking whatever
// usage_counters row happens to be most recent, is what this page fixed
// here too — the same live-caught bug (a user's very first page load of a
// new period would otherwise show a prior period's stale count).
function todayDateIST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}
function monthStartDateIST(): string {
  return `${todayDateIST().slice(0, 7)}-01`;
}

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("users").select("plan_tier").eq("id", user.id).single();
  const planTier = (profile?.plan_tier ?? "free") as PlanTier;

  const [{ data: usageRow }, { data: limitRow }, { data: dailyUsageRow }, { data: dailyLimitRow }] = await Promise.all([
    supabase
      .from("usage_counters")
      .select("used")
      .eq("user_id", user.id)
      .eq("counter_type", "credits")
      .eq("period_start", monthStartDateIST())
      .maybeSingle(),
    supabase.from("plan_limits").select("limit_amount").eq("plan_tier", planTier).eq("counter_type", "credits").maybeSingle(),
    supabase
      .from("usage_counters")
      .select("used")
      .eq("user_id", user.id)
      .eq("counter_type", "daily_credits")
      .eq("period_start", todayDateIST())
      .maybeSingle(),
    supabase.from("plan_limits").select("limit_amount").eq("plan_tier", planTier).eq("counter_type", "daily_credits").maybeSingle(),
  ]);

  const creditsUsed = usageRow?.used ?? 0;
  const creditsTotal = limitRow?.limit_amount ?? 0;
  const dailyUsed = dailyUsageRow?.used ?? 0;
  const dailyTotal = dailyLimitRow?.limit_amount ?? null;

  return (
    <div className="mx-auto h-screen max-w-2xl overflow-y-auto px-6 py-10">
      <h1 className="text-xl font-semibold text-foreground">Settings</h1>

      <div className="mt-6 space-y-1 rounded-[22px] border border-border bg-surface p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Email</p>
        <p className="text-sm text-foreground">{user.email}</p>
      </div>

      <div className="mt-4 rounded-[22px] border border-border bg-surface p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Plan &amp; billing</p>
        <div className="mt-1 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">{planDisplayName(planTier)}</p>
            <p className="text-xs text-muted-foreground">
              {creditsTotal > 0 ? `${creditsUsed.toLocaleString()} / ${creditsTotal.toLocaleString()}` : "—"} SPLEX Credits used this
              cycle
            </p>
            {dailyTotal !== null && (
              <p className="text-xs text-muted-foreground">
                {dailyUsed.toLocaleString()} / {dailyTotal.toLocaleString()} SPLEX Credits used today
              </p>
            )}
          </div>
          {planTier === "free" ? (
            <Link
              href="/upgrade"
              className="rounded-full bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              Upgrade
            </Link>
          ) : (
            <CancelSubscriptionButton />
          )}
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${creditsTotal > 0 ? Math.min(100, (creditsUsed / creditsTotal) * 100) : 0}%` }}
          />
        </div>
      </div>

      <div className="mt-4 rounded-[22px] border border-border bg-surface p-5">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Today&apos;s usage</p>
        <UsagePanel bordered={false} showLabel={false} />
      </div>

      <SecuritySection />
      <DangerZoneSection />
    </div>
  );
}
