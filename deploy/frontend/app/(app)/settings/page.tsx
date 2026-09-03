import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SecuritySection } from "@/components/settings/SecuritySection";
import { DangerZoneSection } from "@/components/settings/DangerZoneSection";
import { CancelSubscriptionButton } from "@/components/settings/CancelSubscriptionButton";
import { UsagePanel } from "@/components/sidebar/UsagePanel";
import { MemoryEditor } from "@/components/memory/MemoryEditor";
import { planDisplayName } from "@/lib/planDisplay";
import type { PlanTier } from "@/shared-types";

// SPLEX credit balances (monthly/daily usage_counters vs plan_limits)
// were previously queried and rendered directly here, with their own
// progress bar. Removed — SPLEX credits are an internal backend metering
// unit, never a product-facing number, regardless of whether the query
// runs server-side (this page) or client-side. UsagePanel below still
// shows per-capability feature usage (e.g. "3/5 images today"), which is
// legitimate product UX and stays; it goes through the backend's own
// GET /entitlements, never a direct plan_limits/usage_counters read.
export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("users").select("plan_tier").eq("id", user.id).single();
  const planTier = (profile?.plan_tier ?? "free") as PlanTier;

  const [{ data: factRows }, { data: memoryRow }, { data: memorySettings }] = await Promise.all([
    supabase.from("user_memories").select("id, fact").eq("user_id", user.id).order("created_at", { ascending: false }),
    supabase.from("user_memory").select("summary_text").eq("user_id", user.id).maybeSingle(),
    supabase.from("users").select("memory_enabled").eq("id", user.id).maybeSingle(),
  ]);

  return (
    <div className="mx-auto h-dvh max-w-2xl overflow-y-auto px-4 pb-10 pt-14 sm:px-6 sm:pt-10">
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
      </div>

      <div className="mt-4 rounded-[22px] border border-border bg-surface p-5">
        <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">Today&apos;s usage</p>
        <UsagePanel bordered={false} showLabel={false} />
      </div>

      <div className="mt-4 rounded-[22px] border border-border bg-surface p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Memory</p>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          What SPLEX remembers about you across every conversation — preferences, ongoing projects, how you like
          things done. It updates itself as you chat; you can review, delete, or turn it off any time.
        </p>
        <MemoryEditor
          userId={user.id}
          initialFacts={factRows ?? []}
          initialLegacySummary={memoryRow?.summary_text ?? ""}
          initialMemoryEnabled={memorySettings?.memory_enabled !== false}
        />
      </div>

      <SecuritySection />
      <DangerZoneSection />
    </div>
  );
}
