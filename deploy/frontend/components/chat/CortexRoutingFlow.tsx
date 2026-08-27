"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Brain, Cpu, MessageSquare, Sparkles } from "lucide-react";
import type { CortexStatusStage } from "@/shared-types";
import { cn } from "@/lib/cn";

// The live routing visualization: the user's request travelling into
// Cortex, through the routing brain, out to the model that was chosen, and
// back again as the answer.
//
// Driven by the REAL stage events the backend already emits over SSE
// (CortexStatusStage — see cortex/status emission in routes/chat.ts), not a
// timed fake. That distinction matters: the whole premise of the product is
// that routing genuinely happens, so an animation that just plays for a
// fixed duration regardless of what the server is doing would be a lie
// dressed as a feature — and it would desync the moment a real route is
// slower or faster than the canned timing.
//
// This replaces the per-message credit readout as the thing shown during a
// response. Users found watching credits tick up stressful; what they
// actually want to know is that something considered their request and
// which model ended up answering it.

const NODES = [
  { key: "request", icon: MessageSquare, label: "Your request" },
  { key: "cortex", icon: Brain, label: "Cortex" },
  { key: "model", icon: Cpu, label: "Model" },
  { key: "answer", icon: Sparkles, label: "Answer" },
] as const;

// Which node is "lit" at each real backend stage. understanding and
// detecting_requirements both sit at Cortex because that IS one place doing
// two things — splitting them across nodes would imply a hop that doesn't
// happen.
const STAGE_TO_NODE: Record<CortexStatusStage, number> = {
  understanding: 1,
  detecting_requirements: 1,
  selecting_capability: 2,
  executing: 3,
};

interface CortexRoutingFlowProps {
  status: CortexStatusStage | "idle";
  statusLabel: string;
  isStreaming: boolean;
  // Set once the route is decided — the whole point of the panel, and the
  // only model-identifying value the backend will hand the client (already
  // resolved to a display name; never a raw openrouter id).
  modelDisplayName?: string | null;
}

export function CortexRoutingFlow({ status, statusLabel, isStreaming, modelDisplayName }: CortexRoutingFlowProps) {
  const reduceMotion = useReducedMotion();

  if (!isStreaming || status === "idle") return null;

  const activeIndex = STAGE_TO_NODE[status as CortexStatusStage] ?? 0;

  return (
    <div className="mx-auto w-full max-w-[720px] px-1 sm:px-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface/60 p-3 sm:p-4">
        {/* The flow itself */}
        <div className="flex items-center gap-1 sm:gap-2">
          {NODES.map((node, i) => {
            const Icon = node.icon;
            const reached = i <= activeIndex;
            const isActive = i === activeIndex;

            return (
              <div key={node.key} className="flex min-w-0 flex-1 items-center gap-1 last:flex-none sm:gap-2">
                {/* Node */}
                <div className="flex shrink-0 flex-col items-center gap-1.5">
                  <motion.span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg border transition-colors sm:h-9 sm:w-9",
                      reached ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground",
                    )}
                    animate={
                      isActive && !reduceMotion
                        ? { scale: [1, 1.08, 1] }
                        : { scale: 1 }
                    }
                    transition={
                      isActive && !reduceMotion
                        ? { duration: 1.4, repeat: Infinity, ease: "easeInOut" }
                        : { duration: 0.2 }
                    }
                  >
                    <Icon size={15} strokeWidth={1.7} />
                  </motion.span>
                  <span
                    className={cn(
                      "hidden text-center font-mono text-[9px] uppercase tracking-[0.1em] sm:block",
                      reached ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {node.label}
                  </span>
                </div>

                {/* Connector — fills as the request advances past this node.
                    The last node has none (nothing to travel to). */}
                {i < NODES.length - 1 && (
                  <span className="relative mb-4 h-[2px] min-w-0 flex-1 overflow-hidden rounded-full bg-border-strong sm:mb-5">
                    <motion.span
                      className="absolute inset-y-0 left-0 rounded-full bg-accent"
                      initial={false}
                      animate={{ width: i < activeIndex ? "100%" : "0%" }}
                      transition={{ duration: reduceMotion ? 0 : 0.45, ease: "easeOut" }}
                    />
                    {/* A pulse travelling along the edge currently being
                        crossed — this is the "going to Cortex / going to the
                        model" motion, and it only runs on the one live hop. */}
                    {i === activeIndex && !reduceMotion && (
                      <motion.span
                        className="absolute inset-y-0 w-6 rounded-full bg-accent/70"
                        initial={{ left: "-25%" }}
                        animate={{ left: "100%" }}
                        transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                      />
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* What's happening, in words — the backend's own stage label. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AnimatePresence mode="wait">
            <motion.span
              key={statusLabel || status}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.22 }}
              className="shimmer-text animate-shimmer font-mono text-[10.5px] uppercase tracking-[0.13em]"
            >
              {statusLabel || "Analyzing request..."}
            </motion.span>
          </AnimatePresence>

          {/* Appears the moment a model is actually chosen. Deliberately the
              only routing fact surfaced live — no cost, no credit count. */}
          {modelDisplayName && (
            <motion.span
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="rounded-md bg-accent-soft px-2 py-0.5 font-mono text-[10px] text-accent"
            >
              {modelDisplayName}
            </motion.span>
          )}
        </div>
      </div>
    </div>
  );
}
