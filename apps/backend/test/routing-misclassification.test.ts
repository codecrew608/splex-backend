import { describe, it, expect } from "vitest";
import { classifyDeterministic } from "../src/cortex/classify.js";

// REGRESSION — reported with a screenshot, 2026-09-07. A long, detailed
// request to build an e-commerce page in a single HTML file came back with
// "Web search isn't available on your plan."
//
// TWO independent defects stacked:
//
//  1. web_search's price/now pattern used an UNBOUNDED `[\s\S]*` between its
//     two halves, so they could sit anywhere in a message of any length.
//     The brief said "a strong VALUE proposition" near the top and "Shop
//     NOW" in a button label ~200 characters later, in unrelated sentences.
//     Two innocent words beat every other signal, because it is a STRONG
//     keyword and matched outright.
//
//  2. Underneath that, code_generation had NO pattern for building a web
//     artefact at all. `build (a|an) (function|app|api|component|script)`
//     needs the noun immediately after the article; this request had five
//     adjectives in between. So even with web_search out of the way the
//     message had zero coding signal and fell to `vision`, on an incidental
//     weak hit on the word "image".
//
// The bounded-span lesson generalises beyond this one pattern: an
// unbounded gap inside a STRONG keyword turns any long message into a
// lottery, because the odds that both halves appear somewhere approach 1.

const GRAB_PROMPT = `Build a modern, high-converting, fully responsive e-commerce homepage and product view for my brand Grab in a single, self-contained HTML file. Include internal CSS (using Tailwind via CDN) and vanilla JavaScript for interactivity.Requirements:Header/Navigation: Sleek sticky navbar with the 'Grab' logo, links (Shop, Categories, About, Contact), a search bar, and a working cart icon with a live item counter badge.Hero Section: Bold, eye-catching banner with a strong value proposition for Grab, a striking call-to-action button ('Shop Now'), and a placeholder product image.Product Grid: Showcase 4-6 featured products with high-quality Unsplash image URLs, product titles, prices in INR/USD, star ratings, and an 'Add to Cart' button.Interactive Cart Drawer/Modal: Clicking the cart icon or 'Add to Cart' should open a slide-over drawer showing selected items, quantity adjustments, a running total, and a mock 'Checkout' button.Footer: Clean footer with brand links, social media icons, and new`;

const categoryOf = (prompt: string) => classifyDeterministic(prompt)?.category ?? "llm_fallback";

describe("the reported prompt routes to coding — not web_search, not vision", () => {
  it("classifies the full Grab e-commerce brief as coding", () => {
    expect(categoryOf(GRAB_PROMPT)).toBe("coding");
  });

  it("specifically is NOT web_search (the refusal the user actually saw)", () => {
    expect(categoryOf(GRAB_PROMPT)).not.toBe("web_search");
  });

  it("'value' and 'now' far apart in one long message no longer trigger web_search", () => {
    // The minimal shape of defect 1, isolated from everything else.
    const prompt =
      "Write a strong value proposition for the hero banner. " +
      "Then add a call to action button labelled Shop Now at the bottom of the page.";
    expect(categoryOf(prompt)).not.toBe("web_search");
  });
});

describe("genuine time-sensitive questions still reach web_search", () => {
  // The bounded pattern must not cost the real case it exists for: these
  // have both halves within a few words, in one sentence.
  it.each([
    "what is the price of btc now",
    "what's the price of bitcoin right now?",
    "as of today, what is the status of the mission?",
  ])("%s", (prompt) => {
    expect(categoryOf(prompt)).toBe("web_search");
  });
});

describe("building a web artefact is recognised as coding", () => {
  it.each([
    "build me an ecommerce website for clothing",
    "build me a landing page with a search bar and a Shop Now button",
    "put everything into 1 html file and give it to me",
    "create a dashboard in React",
    "design a homepage for my portfolio",
    "make me a responsive landing page using Tailwind",
  ])("%s", (prompt) => {
    expect(categoryOf(prompt)).toBe("coding");
  });
});

describe("mentioning a framework is NOT a build request", () => {
  // Deliberate negatives — a first version of the framework rule listed the
  // names unqualified and claimed this for coding. bench/routing/cases.jsonl
  // caught it before it shipped; pinned here so it stays caught.
  it("'What is React and why do people use it?' stays out of coding", () => {
    expect(categoryOf("What is React and why do people use it?")).not.toBe("coding");
  });

  it("asking what JavaScript is stays out of coding", () => {
    expect(categoryOf("What is JavaScript?")).not.toBe("coding");
  });

  it("a non-technical 'build' request is not coding", () => {
    expect(categoryOf("help me build a brand people trust")).not.toBe("coding");
  });
});

describe("no STRONG keyword may use an unbounded gap", () => {
  // The generalised form of defect 1. A strong keyword decides the route
  // outright, so an unbounded span inside one makes long messages a
  // coin-flip. Bounded spans ([^.?!\n]{0,N}) are fine; `.*` and `[\s\S]*`
  // are not.
  it("intents.ts contains no [\\s\\S]* span in any pattern", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(import.meta.dirname, "..", "src", "cortex", "intents.ts"), "utf8");
    // Strip comments first — the explanatory comments legitimately quote the
    // old pattern when describing what went wrong.
    const code = src
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("[\\s\\S]*");
  });
});
