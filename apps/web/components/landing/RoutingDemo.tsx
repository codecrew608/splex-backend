"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";

// The one thing worth animating on this page: Cortex picking a model.
// It's the product's entire premise ("you choose the outcome, Cortex
// chooses the intelligence"), and it's a process — a static screenshot
// can't show a decision being made, which is exactly what a prospective
// user is trying to understand here.
//
// Every example below is a real routing shape the backend actually
// produces (see cortex/routing.ts's profile weighting): a code-repair
// prompt goes to a coder model, a cheap factual question to a small fast
// one, a long analysis to a reasoning model. Deliberately NOT real model
// ids or real latencies — those change with the registry, and quoting
// stale specifics on a marketing page is how this kind of section starts
// lying. These are illustrative and the caption says so.
const EXAMPLES = [
  { prompt: "Fix the race condition in this worker", label: "Coding", model: "a coder model", complexity: "Complex" },
  { prompt: "What's the capital of Karnataka?", label: "Quick fact", model: "a small, fast model", complexity: "Simple" },
  { prompt: "Compare these three vendor contracts", label: "Analysis", model: "a reasoning model", complexity: "Complex" },
  { prompt: "Rewrite this paragraph, warmer tone", label: "Writing", model: "a writing model", complexity: "Simple" },
];

const ROTATE_MS = 3400;

export function RoutingDemo() {
  const [index, setIndex] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    // Respect the OS setting rather than spinning forever: a user who has
    // asked for reduced motion gets the first example, held still.
    if (reduceMotion) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % EXAMPLES.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [reduceMotion]);

  const current = EXAMPLES[index];

  return (
    <div className="w-full rounded-2xl border border-border bg-surface p-4 sm:p-6" style={{ boxShadow: "var(--shadow-card)" }}>
      <div className="flex items-center gap-2 pb-4">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Cortex · Auto</span>
      </div>

      <div className="flex flex-col gap-3">
        <AnimatePresence mode="wait">
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col gap-3"
          >
            {/* The prompt */}
            <div className="self-end rounded-2xl rounded-br-md bg-surface-raised px-3.5 py-2.5 text-[13px] text-foreground sm:text-sm">
              {current.prompt}
            </div>

            {/* The decision */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground sm:text-[11px]">
              <span className="text-accent">{current.label}</span>
              <ArrowRight size={11} className="shrink-0" />
              <span>{current.complexity}</span>
              <ArrowRight size={11} className="shrink-0" />
              <span className="normal-case tracking-normal text-foreground">routed to {current.model}</span>
            </div>

            {/* The receipt — the design system's signature element */}
            <div className="inline-flex w-fit items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-1.5 font-mono text-[10px] text-accent sm:text-[11px]">
              <Sparkles size={11} className="shrink-0" />
              <span>routed automatically</span>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Progress ticks — which of the four examples is showing */}
      <div className="mt-5 flex gap-1.5">
        {EXAMPLES.map((ex, i) => (
          <span
            key={ex.prompt}
            className="h-[3px] flex-1 overflow-hidden rounded-full bg-border-strong"
            aria-hidden
          >
            <motion.span
              className="block h-full rounded-full bg-accent"
              initial={false}
              animate={{ width: i === index ? "100%" : "0%" }}
              transition={{ duration: i === index && !reduceMotion ? ROTATE_MS / 1000 : 0.2, ease: "linear" }}
            />
          </span>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">Illustrative. Actual routing depends on the live model registry.</p>
    </div>
  );
}
