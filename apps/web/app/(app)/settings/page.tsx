import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SecuritySection } from "@/components/settings/SecuritySection";
import { DangerZoneSection } from "@/components/settings/DangerZoneSection";
import { CancelSubscriptionButton } from "@/components/settings/CancelSubscriptionButton";
import { MemoryEditor } from "@/components/memory/MemoryEditor";
import { FeedbackSection } from "@/components/settings/FeedbackSection";
import { planDisplayName } from "@/lib/planDisplay";
import type { PlanTier } from "@splex/shared-types";

// No usage/quota numbers of any kind on this page (explicit product
// decision) — not SPLEX's internal credit economics, and not even the
// simple per-capability counts (e.g. "3/5 images today") that used to
// render here via UsagePanel. That still exists, and still gets its data
// from the backend-authoritative GET /entitlements, but only as a
// numberless animated fill bar in the sidebar (components/sidebar/
// UsagePanel.tsx) — Settings shows none of it.
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

      <div className="mt-4 rounded-[22px] border border-border bg-surface p-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Feedback</p>
        <p className="mb-3 mt-1 text-sm text-muted-foreground">
          Tell us what&apos;s working or not — this goes straight to the team, not just a suggestion box.
        </p>
        <FeedbackSection />
      </div>

      <SecuritySection />
      <DangerZoneSection />
    </div>
  );
}
