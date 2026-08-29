"use client";

import { Check, X, Loader2, CircleDashed, HelpCircle } from "lucide-react";
import type { WorkflowView } from "@/hooks/useChatStream";

interface WorkflowPanelProps {
  workflow: WorkflowView | null;
}

function StepIcon({ status }: { status: "pending" | "running" | "completed" | "failed" }) {
  if (status === "completed") return <Check size={13} strokeWidth={1.7} className="shrink-0 text-accent" />;
  if (status === "failed") return <X size={13} strokeWidth={1.7} className="shrink-0 text-danger" />;
  if (status === "running") return <Loader2 size={13} strokeWidth={1.7} className="shrink-0 animate-spin text-accent" />;
  return <CircleDashed size={13} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />;
}

// Live in-progress workflow indicator, shown while a multi-step run is
// executing — the reference's growing step-reveal pattern, but with real
// step data/statuses rather than a fixed fake sequence. Once the run
// finishes, its steps are snapshotted onto the assistant message itself
// (see useChatStream's onDone) and shown there via MessageCortexDisclosure
// instead — this panel is specifically the live view.
export function WorkflowPanel({ workflow }: WorkflowPanelProps) {
  if (!workflow) return null;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4">
      <div className="flex flex-col gap-[11px]">
        {workflow.cortexVersion && workflow.steps.length > 0 && (
          <div className="flex flex-col gap-[2px]">
            <span className="font-mono text-[10px] uppercase tracking-[0.13em] text-accent">Cortex Engine {workflow.cortexVersion}</span>
            <span className="text-[11px] text-muted-foreground">Workflow · {workflow.steps.length} steps</span>
          </div>
        )}

        {workflow.steps.length > 0 && (
          <div className="flex items-center gap-[9px]">
            <span className="h-[6px] w-[6px] shrink-0 animate-pulse-soft rounded-full bg-accent" />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground">
              {workflow.steps.filter((s) => s.status === "completed").length}/{workflow.steps.length} steps
            </span>
          </div>
        )}

        {workflow.steps.length > 0 && (
          <div className="flex flex-col gap-2 pl-px">
            {workflow.steps.map((step, i) => (
              <div key={i} className="flex animate-fade-in-up items-center gap-[9px] text-[13.5px] text-muted-foreground">
                <StepIcon status={step.status} />
                <span className="truncate">{step.title}</span>
                {step.modelDisplayName && <span className="shrink-0 truncate text-[12px]">— {step.modelDisplayName}</span>}
                <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wide">{step.categoryLabel}</span>
              </div>
            ))}
          </div>
        )}

        {workflow.clarificationQuestion && (
          <div className="flex items-start gap-2 rounded-lg bg-accent-soft px-3 py-[10px] text-[13.5px] text-foreground">
            <HelpCircle size={14} strokeWidth={1.6} className="mt-0.5 shrink-0 text-accent" />
            <span>{workflow.clarificationQuestion}</span>
          </div>
        )}
      </div>
    </div>
  );
}
