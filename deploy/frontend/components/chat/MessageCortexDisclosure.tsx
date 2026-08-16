"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type { CortexDecisionPayload } from "@/shared-types";
import type { WorkflowStepView } from "@/hooks/useChatStream";
import { cn } from "@/lib/cn";

interface MessageCortexDisclosureProps {
  decision?: CortexDecisionPayload | null;
  workflowSteps?: WorkflowStepView[] | null;
}

const COMPLEXITY_LABEL: Record<string, string> = { simple: "Simple", medium: "Medium", complex: "Complex" };

// Small accent triangle reused from the SPLEX Chat reference — the same
// mark used for the logo's arrowhead and each assistant message's brand
// label, here doubling as the disclosure pill's bullet.
function Triangle({ size = 9 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M2 1L9.5 6L2 11Z" fill="var(--accent)" />
    </svg>
  );
}

export function MessageCortexDisclosure({ decision, workflowSteps }: MessageCortexDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  if (!decision && !workflowSteps) return null;

  const categoryLabel = decision?.categoryLabel ?? "Multi-step workflow";

  return (
    <div className="flex w-full flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="inline-flex items-center gap-[9px] rounded-lg border border-border bg-surface px-[11px] py-[6px] text-xs text-foreground transition-colors hover:border-border-strong"
      >
        <Triangle />
        <span className="font-medium">{categoryLabel}</span>
        <span className="font-mono text-[9.5px] tracking-[0.08em] text-muted-foreground">CORTEX</span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          className="text-muted-foreground transition-transform duration-150"
          style={{ transform: `rotate(${expanded ? 180 : 0}deg)` }}
        >
          <path d="M3 4.8L6 7.8L9 4.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded && (
        <div className="flex w-full animate-fade-in-up flex-col gap-[10px] rounded-lg border border-border bg-surface p-[14px_16px]">
          {decision ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-3 text-[13px] sm:grid-cols-4">
              <Field label="Intent" value={decision.intent.replace(/_/g, " ")} />
              <Field label="Complexity" value={COMPLEXITY_LABEL[decision.complexity] ?? decision.complexity} />
              <Field label="Capability" value={decision.categoryLabel} />
              <Field label="Signals" value={decision.capabilities.join(", ") || "—"} />
              <div className="col-span-2 sm:col-span-4">
                <Field label="Reason" value={decision.reason} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-[6px]">
              {(workflowSteps ?? []).map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  <span
                    className={cn(
                      "flex h-3 w-3 shrink-0 items-center justify-center rounded-full",
                      s.status === "completed" && "text-accent",
                      s.status === "failed" && "text-danger",
                    )}
                  >
                    {s.status === "completed" && <Check size={12} strokeWidth={2} />}
                  </span>
                  <span>{s.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[9.5px] uppercase tracking-wide">{s.categoryLabel}</span>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-border pt-[9px] font-mono text-[9.5px] leading-[1.7] tracking-[0.07em] text-muted-foreground">
            CAPABILITY CATEGORY ONLY — SPLEX DOES NOT SURFACE ROUTING INTERNALS.
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}
