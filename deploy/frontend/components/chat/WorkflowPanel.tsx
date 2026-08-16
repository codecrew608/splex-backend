"use client";

import { Check, X, Loader2, CircleDashed, HelpCircle } from "lucide-react";
import type { WorkflowView } from "@/hooks/useChatStream";
import { cn } from "@/lib/cn";

interface WorkflowPanelProps {
  workflow: WorkflowView | null;
}

function StepIcon({ status }: { status: "pending" | "running" | "completed" | "failed" }) {
  if (status === "completed") return <Check size={13} className="shrink-0 text-accent" />;
  if (status === "failed") return <X size={13} className="shrink-0 text-danger" />;
  if (status === "running") return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />;
  return <CircleDashed size={13} className="shrink-0 text-muted-foreground" />;
}

// Sibling to CortexStatusPanel, same visual language — a plan checklist
// (title + status per step, categoryLabel only, never raw category or a
// model id) plus a paused banner when a step is waiting on the user.
export function WorkflowPanel({ workflow }: WorkflowPanelProps) {
  if (!workflow) return null;

  const completedCount = workflow.steps.filter((s) => s.status === "completed").length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="rounded-[22px] border border-border bg-surface text-xs">
        {workflow.steps.length > 0 && (
          <div className="flex items-center gap-2.5 px-3 py-2.5 text-muted-foreground">
            <span className="font-medium text-foreground">
              {completedCount}/{workflow.steps.length} steps
            </span>
          </div>
        )}

        {workflow.steps.length > 0 && (
          <div className="space-y-1.5 border-t border-border px-3 py-2.5">
            {workflow.steps.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <StepIcon status={step.status} />
                <span className={cn("truncate", step.status === "completed" && "text-muted-foreground")}>
                  {step.title}
                </span>
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {step.categoryLabel}
                </span>
              </div>
            ))}
          </div>
        )}

        {workflow.clarificationQuestion && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-b-[22px] bg-accent-soft px-3 py-2.5 text-foreground",
              workflow.steps.length === 0 && "rounded-t-[22px]",
            )}
          >
            <HelpCircle size={14} className="mt-0.5 shrink-0 text-accent" />
            <span>{workflow.clarificationQuestion}</span>
          </div>
        )}
      </div>
    </div>
  );
}
