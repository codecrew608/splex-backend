import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SecuritySection } from "@/components/settings/SecuritySection";
import { DangerZoneSection } from "@/components/settings/DangerZoneSection";

const PLAN_LABEL: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
};

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

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
    supabase
      .from("plan_limits")
      .select("limit_amount")
      .eq("plan_tier", planTier)
      .eq("counter_type", "credits")
      .single(),
  ]);

  const creditsUsed = usageRow?.used ?? 0;
  const creditsTotal = limitRow?.limit_amount ?? 0;

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
            <p className="text-sm text-foreground">{PLAN_LABEL[planTier] ?? planTier}</p>
            <p className="text-xs text-muted-foreground">
              {creditsUsed.toLocaleString()} / {creditsTotal.toLocaleString()} SPLEX Credits used this cycle
            </p>
          </div>
          {planTier === "free" ? (
            <Link
              href="/upgrade"
              className="rounded-full bg-accent px-3 py-2 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              Upgrade
            </Link>
          ) : (
            <span className="rounded-full border border-border px-3 py-2 text-sm text-muted-foreground">
              Current plan
            </span>
          )}
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${creditsTotal > 0 ? Math.min(100, (creditsUsed / creditsTotal) * 100) : 0}%` }}
          />
        </div>
      </div>

      <SecuritySection />
      <DangerZoneSection />
    </div>
  );
}
