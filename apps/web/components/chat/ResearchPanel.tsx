"use client";

import { Check, Loader2, CircleDashed } from "lucide-react";
import type { ResearchStage } from "@splex/shared-types";

const STAGES: Array<{ id: ResearchStage; label: string }> = [
  { id: "planning", label: "Planning" },
  { id: "searching", label: "Searching" },
  { id: "reading_sources", label: "Reading sources" },
  { id: "cross_checking", label: "Cross-checking" },
  { id: "writing_report", label: "Writing report" },
];

interface ResearchPanelProps {
  currentStage: ResearchStage | null;
}

// High-level stage progress only, matching the spec's explicit instruction
// not to expose chain-of-thought or internal reasoning — this shows which
// of the five real backend stages (research/deepResearch.ts) is running,
// nothing about what any of them actually contain.
export function ResearchPanel({ currentStage }: ResearchPanelProps) {
  if (!currentStage) return null;
  const currentIndex = STAGES.findIndex((s) => s.id === currentStage);

  return (
    <div className="mx-auto w-full max-w-[720px] px-4">
      <div className="flex flex-col gap-[11px]">
        <div className="flex items-center gap-[9px]">
          <span className="h-[6px] w-[6px] shrink-0 animate-pulse-soft rounded-full bg-accent" />
          <span className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground">Deep research</span>
        </div>
        <div className="flex flex-col gap-2 pl-px">
          {STAGES.map((stage, i) => {
            const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "pending";
            return (
              <div key={stage.id} className="flex animate-fade-in-up items-center gap-[9px] text-[13.5px] text-muted-foreground">
                {state === "done" && <Check size={13} strokeWidth={1.7} className="shrink-0 text-accent" />}
                {state === "active" && <Loader2 size={13} strokeWidth={1.7} className="shrink-0 animate-spin text-accent" />}
                {state === "pending" && <CircleDashed size={13} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />}
                <span className={state === "active" ? "text-foreground" : undefined}>{stage.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
