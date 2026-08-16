"use client";

import { useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import type { CortexDecisionPayload, CortexStatusStage } from "@splex/shared-types";
import { cn } from "@/lib/cn";

interface CortexStatusPanelProps {
  status: CortexStatusStage | "idle";
  statusLabel: string;
  decision: CortexDecisionPayload | null;
  isStreaming: boolean;
}

const COMPLEXITY_LABEL: Record<string, string> = {
  simple: "Simple",
  medium: "Medium",
  complex: "Complex",
};

// Keyed by the exact generic labels categoryToLabel() emits server-side —
// purely a visual accent, never derived from or tied to the real model.
const CATEGORY_COLOR: Record<string, string> = {
  "Software Development": "#8d97ff",
  "Advanced Reasoning": "#e8a33d",
  Mathematics: "#4fd18b",
  "Writing & Content": "#e8709a",
  "Visual Understanding": "#5ec6f5",
  "Document Analysis": "#b48cf2",
  "General Assistance": "#8d7dff",
};

export function CortexStatusPanel({ status, statusLabel, decision, isStreaming }: CortexStatusPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (status === "idle" && !decision) return null;

  const showLiveStatus = isStreaming && status !== "idle" && !decision;
  const dotColor = decision ? CATEGORY_COLOR[decision.categoryLabel] ?? "var(--accent)" : "var(--accent)";

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="rounded-[22px] border border-border bg-surface text-xs">
        <button
          type="button"
          onClick={() => decision && setExpanded((e) => !e)}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-muted-foreground",
            decision && "cursor-pointer hover:text-foreground",
          )}
        >
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
            {showLiveStatus && (
              <span
                className="absolute h-4 w-4 animate-ping rounded-full opacity-40"
                style={{ background: "var(--accent)" }}
              />
            )}
            {decision ? (
              <span className="h-2 w-2 rounded-full" style={{ background: dotColor, boxShadow: `0 0 8px 0 ${dotColor}66` }} />
            ) : (
              <Sparkles size={13} className="shrink-0 text-accent" />
            )}
          </span>
          <span className={cn("truncate", showLiveStatus && "shimmer-text font-medium animate-shimmer")}>
            {showLiveStatus ? statusLabel : decision ? `Routed via ${decision.categoryLabel}` : statusLabel}
          </span>
          {decision && (
            <ChevronDown size={13} className={cn("ml-auto shrink-0 transition-transform duration-200", expanded && "rotate-180")} />
          )}
        </button>

        {decision && (
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-300 ease-out",
              expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="overflow-hidden">
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-border px-3 py-3 sm:grid-cols-4">
                <Field label="Intent" value={decision.intent.replace(/_/g, " ")} />
                <Field label="Complexity" value={COMPLEXITY_LABEL[decision.complexity] ?? decision.complexity} />
                <Field label="Capability" value={decision.categoryLabel} accent={dotColor} />
                <Field label="Signals" value={decision.capabilities.join(", ") || "—"} />
                <div className="col-span-2 sm:col-span-4">
                  <Field label="Reason" value={decision.reason} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-foreground" title={value} style={accent ? { color: accent } : undefined}>
        {value}
      </p>
    </div>
  );
}
