import { Check } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { UpgradeButton } from "@/components/upgrade/UpgradeButton";

const FEATURES: Record<"free" | "pro", string[]> = {
  free: [
    "50,000 SPLEX Credits/month",
    "25 messages/day",
    "3 projects",
    "5 file uploads/month · 100 MB storage",
    "Agent Workflows (up to 3 steps)",
  ],
  pro: [
    "1,000,000 SPLEX Credits/month",
    "Unlimited messages (fair use)",
    "Unlimited projects",
    "100 file uploads/month · 5 GB storage",
    "Agent Workflows (up to 10 steps)",
    "Priority model access",
  ],
};

export default async function UpgradePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("users").select("plan_tier").eq("id", user.id).single();
  const currentTier = profile?.plan_tier ?? "free";

  // Credit amounts pulled live from plan_limits (publicly readable) rather
  // than hardcoded here — one source of truth.
  const { data: limits } = await supabase
    .from("plan_limits")
    .select("plan_tier, limit_amount")
    .in("plan_tier", ["free", "pro"])
    .eq("counter_type", "credits");

  const creditsByTier: Record<string, number> = Object.fromEntries(
    (limits ?? []).map((row) => [row.plan_tier, row.limit_amount ?? 0]),
  );

  return (
    <div className="mx-auto h-screen max-w-3xl overflow-y-auto px-6 py-10">
      <div className="text-center">
        <h1 className="text-4xl font-extrabold tracking-tight text-foreground">Choose your plan</h1>
        <p className="mt-2 text-sm text-muted-foreground">SPLEX Credits, not tokens — Cortex handles the rest.</p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PlanCard
          name="Free"
          price="₹0"
          credits={creditsByTier.free ?? 50000}
          features={FEATURES.free}
          isCurrent={currentTier === "free"}
        />
        <PlanCard
          name="Pro"
          price="₹299"
          period="/mo"
          credits={creditsByTier.pro ?? 1000000}
          features={FEATURES.pro}
          isCurrent={currentTier === "pro"}
          highlighted
          cta={currentTier === "free" ? <UpgradeButton /> : undefined}
        />
      </div>
    </div>
  );
}

function PlanCard({
  name,
  price,
  period,
  credits,
  features,
  isCurrent,
  highlighted,
  cta,
}: {
  name: string;
  price: string;
  period?: string;
  credits: number;
  features: string[];
  isCurrent: boolean;
  highlighted?: boolean;
  cta?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-[22px] border p-6 ${
        highlighted ? "border-accent bg-accent-soft" : "border-border bg-surface"
      }`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">{name}</h2>
        {isCurrent && (
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            Current plan
          </span>
        )}
      </div>
      <p className="mt-2">
        <span className="text-3xl font-semibold text-foreground">{price}</span>
        {period && <span className="text-sm text-muted-foreground">{period}</span>}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{credits.toLocaleString()} SPLEX Credits/month</p>

      <ul className="mt-5 space-y-2">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-foreground">
            <Check size={15} className="mt-0.5 shrink-0 text-accent" />
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        {cta ?? (
          <button
            disabled
            className="w-full rounded-full border border-border px-4 py-2 text-sm text-muted-foreground opacity-60"
          >
            {isCurrent ? "Current plan" : "—"}
          </button>
        )}
      </div>
    </div>
  );
}
