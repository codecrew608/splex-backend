"use client";

import { Check } from "lucide-react";
import type { WorkflowStepView } from "@/hooks/useChatStream";
import { cn } from "@/lib/cn";

interface MessageCortexDisclosureProps {
  workflowSteps?: WorkflowStepView[] | null;
}

// Ordinary single-shot answers show no routing disclosure at all — the
// user sees "SPLEX" (MessageBubble's own header) and the answer, nothing
// about which internal category/intent/model handled it. That used to be
// a "{categoryLabel} CORTEX" pill under every message; removed outright
// per spec, not just relabeled — intent/complexity/capability/reason stay
// server-side only (cortex_decisions), available for logs/admin, never
// rendered here.
//
// A completed Agent Workflow still gets a small, permanent summary of
// which steps ran — that's user-relevant ("here's what I did"), not an
// internal-routing exposure, and without it a finished multi-step answer
// would look identical to an ordinary one once the live WorkflowPanel
// unmounts.
export function MessageCortexDisclosure({ workflowSteps }: MessageCortexDisclosureProps) {
  if (!workflowSteps || workflowSteps.length === 0) return null;

  return (
    <div className="flex w-full flex-col gap-[6px] rounded-lg border border-border bg-surface p-[12px_14px]">
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
          <span className="ml-auto shrink-0 font-mono text-[9.5px] uppercase tracking-wide">{s.categoryLabel}</span>
        </div>
      ))}
    </div>
  );
}
