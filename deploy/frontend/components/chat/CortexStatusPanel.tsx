"use client";

// SUPERSEDED — replaced by components/chat/CortexRoutingFlow.tsx, which
// renders the same live routing stages as an animated request->Cortex->
// model->answer flow. No remaining references. Kept deliberately (not
// deleted) pending a call on whether to remove it; do not wire it back in.

import type { CortexDecisionPayload, CortexStatusStage } from "@/shared-types";

interface CortexStatusPanelProps {
  status: CortexStatusStage | "idle";
  statusLabel: string;
  decision: CortexDecisionPayload | null;
  isStreaming: boolean;
}

// Purely the LIVE "figuring out how to route this" indicator, shown while
// isStreaming and no decision has landed yet — once it arrives, the
// message itself carries its own disclosure (MessageCortexDisclosure),
// so this unmounts rather than staying around as a second, stale copy.
export function CortexStatusPanel({ status, statusLabel, decision, isStreaming }: CortexStatusPanelProps) {
  const show = isStreaming && status !== "idle" && !decision;
  if (!show) return null;

  return (
    <div className="mx-auto w-full max-w-[720px] px-4">
      <div className="flex items-center gap-[9px]">
        <span className="h-[6px] w-[6px] shrink-0 animate-pulse-soft rounded-full bg-accent" />
        <span className="shimmer-text animate-shimmer font-mono text-[10.5px] uppercase tracking-[0.13em]">
          {statusLabel || "Analyzing request..."}
        </span>
      </div>
    </div>
  );
}
