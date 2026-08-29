import { Check } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { UpgradeButton } from "@/components/upgrade/UpgradeButton";

// Every number below is read live from plan_limits rather than hardcoded —
// this list went stale once already (a prior version of this page quoted
// stale credit amounts, "unlimited messages", and a workflow-step count
// that didn't match plan_limits at all). Pulling live means it can only
// ever drift from the truth if plan_limits itself is wrong, not because
// someone forgot to update a second copy of the numbers.
//
// Deliberately excludes 'credits' and 'daily_credits' — SPLEX credits are
// an internal backend metering unit, not a product-facing number (see
// the shared-types EntitlementSnapshot doc comment). Every counter_type
// below is a per-CAPABILITY limit (how many images/searches/workflow
// steps, etc.) — legitimate product UX, distinct from the internal
// currency that prices them.
const COUNTER_TYPES = [
  "web_searches",
  "deep_research",
  "image_generations",
  "audio_generations",
  "video_generations",
  "ppt_generations",
  "workflow_steps",
  "file_uploads",
  "storage_bytes",
  "projects",
] as const;

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(bytes % 1_073_741_824 === 0 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1_048_576)} MB`;
}

function buildFeatures(v: Record<string, number | null>, tier: "free" | "pro"): string[] {
  const features = [
    v.projects === null ? "Unlimited projects" : `${v.projects ?? 0} project${v.projects === 1 ? "" : "s"}`,
    `${(v.file_uploads ?? 0).toLocaleString()} file uploads/month · ${formatBytes(v.storage_bytes ?? 0)} storage`,
    `${(v.web_searches ?? 0).toLocaleString()} web searches/day`,
    `${(v.image_generations ?? 0).toLocaleString()} image generation${v.image_generations === 1 ? "" : "s"}/day`,
    `Agent Workflows (up to ${v.workflow_steps ?? 0} steps)`,
  ];

  if (tier === "pro") {
    features.push(
      `${(v.deep_research ?? 0).toLocaleString()} Deep Research reports/day`,
      `${(v.audio_generations ?? 0).toLocaleString()} audio generations/day`,
      `${(v.video_generations ?? 0).toLocaleString()} video generations/day`,
      `${(v.ppt_generations ?? 0).toLocaleString()} presentations/day`,
      "Priority routing to stronger approved models",
    );
  } else {
    features.push("Deep Research, audio, video, and presentations are Starter-only");
  }

  return features;
}

export default async function UpgradePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("users").select("plan_tier").eq("id", user.id).single();
  const currentTier = profile?.plan_tier ?? "free";

  const { data: limits, error: limitsError } = await supabase
    .from("plan_limits")
    .select("plan_tier, counter_type, limit_amount")
    .in("plan_tier", ["free", "pro"])
    .in("counter_type", COUNTER_TYPES);
  if (limitsError) console.error("upgrade page: plan_limits query failed", limitsError);

  const byTier: Record<"free" | "pro", Record<string, number | null>> = { free: {}, pro: {} };
  for (const row of limits ?? []) {
    const tier = row.plan_tier as "free" | "pro";
    byTier[tier][row.counter_type as string] = row.limit_amount as number | null;
  }

  return (
    <div className="mx-auto h-dvh max-w-3xl overflow-y-auto px-4 pb-10 pt-14 sm:px-6 sm:pt-10">
      <div className="text-center">
        <h1 className="text-4xl font-extrabold tracking-tight text-foreground">Choose your plan</h1>
        <p className="mt-2 text-sm text-muted-foreground">Cortex picks the best model for every request.</p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PlanCard
          name="Free"
          price="₹0"
          features={buildFeatures(byTier.free, "free")}
          isCurrent={currentTier === "free"}
        />
        <PlanCard
          name="Starter"
          price="₹199"
          period="/mo"
          features={buildFeatures(byTier.pro, "pro")}
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
  features,
  isCurrent,
  highlighted,
  cta,
}: {
  name: string;
  price: string;
  period?: string;
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
