"use client";

import { Check } from "lucide-react";
import type { WorkflowStepView } from "@/hooks/useChatStream";
import type { CortexVersion, CortexRoutingInfo, ComplexityLevel } from "@/shared-types";
import { cn } from "@/lib/cn";

interface MessageCortexDisclosureProps {
  workflowSteps?: WorkflowStepView[] | null;
  cortexVersion?: CortexVersion | null;
  routing?: CortexRoutingInfo | null;
}

function complexityLabel(c: ComplexityLevel): string {
  if (c === "simple") return "Simple";
  if (c === "complex") return "Complex";
  return "Medium";
}

// Per-message Cortex Routing disclosure — how SPLEX actually routed THIS
// answer. Two independent shapes, matching the reference design exactly:
//
// 1. A completed Agent Workflow gets an engine-version header + step list
//    (title, model, category per step).
// 2. An ordinary single-shot answer gets the compact routing panel below
//    (engine version, model, complexity, why, credits).
//
// (2) is a deliberate reversal of an earlier decision to remove per-
// message disclosure entirely for ordinary answers ("that used to be a
// pill... removed outright per spec"). The current spec calls for it back
// in this exact shape, sourced from real backend routing data — see
// CortexRoutingInfo's own doc comment — so it isn't the old freeform pill
// returning, it's the new typed panel.
//
// Neither branch ever renders a raw model id, provider name, or internal
// routing score — both only ever see what the backend already resolved to
// a display-safe shape (modelDisplayName, categoryLabel, reason).
export function MessageCortexDisclosure({ workflowSteps, cortexVersion, routing }: MessageCortexDisclosureProps) {
  if (workflowSteps && workflowSteps.length > 0) {
    return (
      <div className="flex w-full flex-col gap-[10px] rounded-lg border border-border bg-surface p-[12px_14px]">
        {cortexVersion && (
          <div className="flex flex-col gap-[2px]">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-accent">Cortex Engine {cortexVersion}</span>
            <span className="text-[11px] text-muted-foreground">Workflow · {workflowSteps.length} steps</span>
          </div>
        )}
        <div className="flex flex-col gap-[6px]">
          {workflowSteps.map((s, i) => (
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
              <span className="truncate">{s.title}</span>
              {s.modelDisplayName && <span className="shrink-0 truncate text-[11.5px]">— {s.modelDisplayName}</span>}
              <span className="ml-auto shrink-0 font-mono text-[9.5px] uppercase tracking-wide">{s.categoryLabel}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!routing) return null;

  // Credits deliberately absent — SPLEX credits are an internal backend
  // metering unit, never shown anywhere in the product UI (see
  // DoneEventData/CortexRoutingInfo in shared-types: creditsCharged isn't
  // even sent to the client anymore, not just hidden here). This panel
  // exists to show that a considered model choice was made on the user's
  // behalf, not to invoice them line by line — watching a per-message
  // cost tick up made users anxious about asking the next question, which
  // is the opposite of the point.
  const rows: Array<[string, string]> = [
    ["Model", routing.modelDisplayName],
    ["Complexity", complexityLabel(routing.complexity)],
    ["Why", routing.reason],
  ];

  return (
    <div className="flex w-full flex-col gap-[8px] rounded-lg border border-border bg-surface p-[12px_14px] text-[12.5px]">
      <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-accent">Cortex Engine {routing.cortexVersion}</span>
      <div className="flex flex-col gap-[4px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-2">
            <span className="w-[76px] shrink-0 text-muted-foreground">{label}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
