"use client";

import { useRef } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useScroll, useSpring, useTransform, type Variants } from "framer-motion";
import { ArrowRight, Check, Cpu, GitBranch, Receipt, Wallet } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { RoutingDemo } from "./RoutingDemo";

// Motion vocabulary for the whole page, defined once. Everything rises a
// short distance and fades — no sliding in from screen edges, no scale
// pops. On a page whose subject is "we pick the right tool quietly," the
// motion should read as composed rather than attention-seeking.
const EASE = [0.16, 1, 0.3, 1] as const;

const container: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08, delayChildren: 0.04 } },
};

const rise: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE } },
};

// Card-only variant: settles in from a slight backward 3D tilt rather than
// just rising — needs `perspective` set on the parent grid (see its own
// className below) for rotateX to actually read as depth instead of a flat
// vertical squash. Deliberately NOT used for headline/body text or CTAs —
// tilting something meant to be read is a readability/motion-sickness
// problem (the same reason the hero's own parallax stays confined to its
// decorative glow layer); this is reserved for card-shaped objects only.
const riseCard: Variants = {
  hidden: { opacity: 0, y: 28, rotateX: -14, scale: 0.96 },
  visible: { opacity: 1, y: 0, rotateX: 0, scale: 1, transition: { duration: 0.7, ease: EASE } },
};

// Scroll-triggered sections share these props. `once` matters: re-playing
// the animation every time a section re-enters the viewport turns ordinary
// scrolling-back into a strobe. `amount: 0.2` fires when a fifth of the
// section is visible, which on a phone is early enough that the content is
// never still invisible by the time it's centered.
const inView = { initial: "hidden", whileInView: "visible", viewport: { once: true, amount: 0.2 } } as const;

const PILLARS = [
  {
    icon: GitBranch,
    title: "One prompt, the right model",
    body: "Cortex reads intent and complexity on every message, then routes to the model built for that job — a coder model for a bug, a small fast one for a quick fact. You never pick from a dropdown.",
  },
  {
    icon: Receipt,
    title: "It shows its work",
    body: "Watch the request travel into Cortex and out to the model that answered it, live. Every reply says which model was picked and why. No black box, no silent downgrade to something cheaper.",
  },
  {
    icon: Wallet,
    title: "One plan, no line-item pricing",
    body: "Chat, images, web search, files and Agent Workflows are all part of your plan — nothing to convert in your head, no per-message price tag interrupting you mid-conversation.",
  },
  {
    icon: Cpu,
    title: "Multi-step Agent Workflows",
    body: "Ask for something that needs several stages and Cortex plans the steps, routes each one independently, and reports each stage as it lands.",
  },
];

// Feature/capability numbers from plan_limits, checked against production
// when this page was written. Kept as plain copy rather than a live query
// on purpose: this route renders for logged-out visitors, and a marketing
// page must not open a database round-trip (or fail) for someone with no
// account. The signed-in /upgrade page remains the live, authoritative
// one. Deliberately no SPLEX credit numbers here — SPLEX credits are an
// internal backend metering unit, never a product-facing number; every
// line below is a per-CAPABILITY limit instead (how many images/searches/
// workflow steps a plan includes).
const PLANS = [
  {
    name: "Free",
    price: "₹0",
    period: "",
    features: [
      "General chat, coding, math, reasoning & writing",
      "Document and image understanding",
      "Up to 3 projects",
      "5 file uploads/month",
    ],
    highlighted: false,
  },
  {
    name: "Starter",
    price: "₹299",
    period: "/mo",
    features: [
      "Everything in Free, plus:",
      "Unlimited projects",
      "100 file uploads/month",
      "100 web searches/day",
      "Deep Research, image, audio, video & presentation generation",
      "Agent Workflows up to 10 steps",
    ],
    highlighted: true,
  },
];

export function LandingPage() {
  const reduceMotion = useReducedMotion();
  const heroRef = useRef<HTMLElement>(null);

  // Page-level scroll progress, used for the thin accent bar under the nav.
  // Spring-smoothed so the bar eases rather than tracking raw wheel deltas,
  // which on a trackpad reads as jitter.
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 28, restDelta: 0.001 });

  // Hero parallax, applied ONLY to the decorative glow layer — never to
  // the headline, body copy, or CTAs. Parallaxing text is a documented
  // readability and motion-sickness problem, and the CTA is the one thing
  // on this page that must never drift away from where someone aimed.
  const { scrollYProgress: heroProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const glowY = useTransform(heroProgress, [0, 1], [0, 60]);
  // The routing demo card's own 3D presence — a genuine perspective tilt
  // (rotateY/rotateX), not a flat 2D transform, that eases toward facing
  // the viewer straight-on as they scroll down through the hero. Small
  // angles on purpose: enough to read as a physical, tilted object with
  // real depth, not enough to feel like a gimmick or strain reading the
  // card's own text mid-transition.
  const demoRotateY = useTransform(heroProgress, [0, 1], [-6, 2]);
  const demoRotateX = useTransform(heroProgress, [0, 1], [3, -1]);

  return (
    <div className="min-h-screen bg-background">
      {/* ---------------------------------------------------------------- Nav */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
        <nav className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:h-16 sm:px-6">
          <Logo size={24} />
          <span className="flex-1" />
          <ThemeToggle />
          {/* min-h-11 (44px) is the touch-target floor on phones; desktop
              relaxes back to the tighter padded height since pointer
              precision doesn't need the extra area. */}
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-lg px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-hover sm:min-h-0 sm:py-2 sm:text-sm"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-[13px] font-semibold text-accent-foreground transition-colors hover:bg-accent-hover sm:min-h-0 sm:px-4 sm:py-2 sm:text-sm"
          >
            Get started
          </Link>
        </nav>
        {/* Reading-progress bar. scaleX on a transform-only element so it
            never triggers layout, and transform-origin left so it grows
            from the start of the line rather than the centre. */}
        <motion.div
          className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-accent"
          style={{ scaleX: reduceMotion ? 1 : progress }}
          aria-hidden
        />
      </header>

      {/* --------------------------------------------------------------- Hero */}
      <section
        ref={heroRef}
        className="relative mx-auto max-w-6xl overflow-hidden px-4 pb-16 pt-14 sm:px-6 sm:pb-24 sm:pt-20"
      >
        {/* Ambient accent glow behind the hero. Pointer-events-none and
            aria-hidden — it's atmosphere, never a target or a described
            element. Blurred radial rather than an image so it recolors
            automatically with the theme token.

            The parallax lives HERE, on the decorative layer, and nowhere
            else. It used to be applied to the copy block below, which is a
            documented anti-pattern: parallaxing body text hurts reading
            comfort and is a motion-sickness trigger. Decorative layers can
            drift; things people read must hold still. yPercent delta is
            kept small for the same reason foreground/background shouldn't
            visibly desync. */}
        <motion.div
          aria-hidden
          style={reduceMotion ? undefined : { y: glowY }}
          className="pointer-events-none absolute -top-24 left-1/2 h-[420px] w-[820px] max-w-[140vw] -translate-x-1/2 rounded-full opacity-[0.13] blur-[90px]"
        >
          <div className="h-full w-full rounded-full" style={{ background: "var(--accent-gradient)" }} />
        </motion.div>
        <motion.div
          variants={container}
          initial="hidden"
          animate="visible"
          className="relative grid items-center gap-10 lg:grid-cols-2 lg:gap-14"
        >
          <div className="flex flex-col items-start">
            <motion.span
              variants={rise}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              Cortex routing engine
            </motion.span>

            {/* Bounded measure + text-wrap:balance instead of a hardcoded
                <br />. A forced break only ever looks right at the one
                width it was eyeballed at — it stranded "chooses the
                intelligence." on its own line at some sizes and broke
                mid-clause at others. Balance lets the browser even out the
                lines at every width, font fallback, and locale, and the
                ch-based max keeps the measure readable instead of letting
                the headline run edge-to-edge on a wide screen. */}
            <motion.h1
              variants={rise}
              // italic is the one deliberate flourish reserved for this
              // single hero moment — every other heading on the page (and
              // in the app) stays upright. Instrument Serif ships one
              // weight only, so size/tracking/leading carry the emphasis
              // instead of a bold cut that doesn't exist for this face.
              className="mt-5 max-w-[17ch] text-balance font-display text-[34px] italic leading-[1.15] tracking-[-0.01em] text-foreground sm:text-5xl lg:max-w-[16ch] lg:text-[58px]"
            >
              You choose the outcome. <span className="text-accent">Cortex</span> chooses the intelligence.
            </motion.h1>

            <motion.p variants={rise} className="mt-5 max-w-lg text-[15px] leading-relaxed text-muted-foreground sm:text-base">
              SPLEX reads what you actually asked for and routes it to the model best suited to answer — then
              shows you exactly which one it picked. One chat, one balance, no model-picking.
            </motion.p>

            <motion.div variants={rise} className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
              <Link
                href="/login"
                className="group inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-[15px] font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
              >
                Start using SPLEX
                <ArrowRight
                  size={17}
                  className={reduceMotion ? "" : "transition-transform group-hover:translate-x-0.5"}
                />
              </Link>
              <Link
                href="#how"
                className="inline-flex items-center justify-center rounded-xl border border-border-strong px-5 py-3 text-[15px] font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
              >
                See how it routes
              </Link>
            </motion.div>

            <motion.p variants={rise} className="mt-4 font-mono text-[11px] text-muted-foreground">
              Free to start · No card required
            </motion.p>
          </div>

          <motion.div
            variants={rise}
            style={
              reduceMotion
                ? undefined
                : { rotateY: demoRotateY, rotateX: demoRotateX, transformPerspective: 1200 }
            }
          >
            <RoutingDemo />
          </motion.div>
        </motion.div>
      </section>

      {/* ---------------------------------------------------------- The pillars */}
      <section id="how" className="border-t border-border bg-surface/40 scroll-mt-16">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <motion.div variants={container} {...inView}>
            <motion.h2
              variants={rise}
              className="max-w-[22ch] text-balance font-display text-[27px] leading-tight tracking-[-0.015em] text-foreground sm:text-4xl"
            >
              Routing is the product.
            </motion.h2>
            <motion.p variants={rise} className="mt-3 max-w-xl text-[15px] text-muted-foreground">
              Not a model marketplace and not a wrapper. The decision of what should answer you is the thing
              SPLEX is actually built to get right.
            </motion.p>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 sm:gap-5" style={{ perspective: 1000 }}>
              {PILLARS.map(({ icon: Icon, title, body }) => (
                <motion.div
                  key={title}
                  variants={riseCard}
                  // Lifts toward the pointer. -3px is enough to register as
                  // a response without the card appearing to detach from
                  // the grid; skipped entirely under reduced motion.
                  whileHover={reduceMotion ? undefined : { y: -3 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className="group rounded-2xl border border-border bg-surface-raised p-5 transition-colors hover:border-accent sm:p-6"
                >
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent transition-transform duration-200 group-hover:scale-105">
                    <Icon size={17} strokeWidth={1.6} />
                  </span>
                  <h3 className="mt-4 font-display text-[19px] tracking-[-0.01em] text-foreground">
                    {title}
                  </h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">{body}</p>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* -------------------------------------------------------------- Pricing */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6 sm:py-24">
          <motion.div variants={container} {...inView}>
            <motion.h2
              variants={rise}
              className="mx-auto max-w-[20ch] text-balance text-center font-display text-[27px] tracking-[-0.015em] text-foreground sm:text-4xl"
            >
              Simple pricing
            </motion.h2>
            <motion.p variants={rise} className="mt-3 text-center text-[15px] text-muted-foreground">
              No per-message pricing. One plan covers everything.
            </motion.p>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 sm:gap-5" style={{ perspective: 1000 }}>
              {PLANS.map((plan) => (
                <motion.div
                  key={plan.name}
                  variants={riseCard}
                  whileHover={reduceMotion ? undefined : { y: -3 }}
                  transition={{ duration: 0.2, ease: EASE }}
                  className={
                    plan.highlighted
                      ? "rounded-2xl border border-accent bg-accent-soft p-6"
                      : "rounded-2xl border border-border bg-surface p-6 transition-colors hover:border-border-strong"
                  }
                >
                  <h3 className="font-display text-xl text-foreground">{plan.name}</h3>
                  <p className="mt-2">
                    <span className="font-display text-3xl text-foreground sm:text-4xl">{plan.price}</span>
                    {plan.period && <span className="text-sm text-muted-foreground">{plan.period}</span>}
                  </p>
                  <ul className="mt-5 space-y-2.5">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-[13.5px] text-foreground">
                        <Check size={15} className="mt-0.5 shrink-0 text-accent" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/login"
                    className={
                      plan.highlighted
                        ? "mt-6 flex w-full items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
                        : "mt-6 flex w-full items-center justify-center rounded-xl border border-border-strong px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
                    }
                  >
                    {plan.highlighted ? "Start with Starter" : "Start free"}
                  </Link>
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* ------------------------------------------------------------ Final CTA */}
      <section className="border-t border-border bg-surface/40">
        <motion.div variants={container} {...inView} className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-24">
          <motion.h2
            variants={rise}
            className="mx-auto max-w-[20ch] text-balance font-display text-[27px] tracking-[-0.015em] text-foreground sm:text-4xl"
          >
            Describe the outcome you want.
          </motion.h2>
          <motion.p variants={rise} className="mx-auto mt-3 max-w-md text-[15px] text-muted-foreground">
            Cortex handles the rest — and shows you exactly how.
          </motion.p>
          <motion.div variants={rise} className="mt-8">
            <Link
              href="/login"
              className="group inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-6 py-3 text-[15px] font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
            >
              Start using SPLEX
              <ArrowRight size={17} className={reduceMotion ? "" : "transition-transform group-hover:translate-x-0.5"} />
            </Link>
          </motion.div>
        </motion.div>
      </section>

      {/* --------------------------------------------------------------- Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:px-6">
          <Logo size={20} />
          <span className="flex-1" />
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
            <Link href="/legal/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href="/legal/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/legal/acceptable-use" className="transition-colors hover:text-foreground">
              Acceptable use
            </Link>
            <Link href="/login" className="transition-colors hover:text-foreground">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
