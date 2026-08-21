"use client";

import { Globe } from "lucide-react";
import type { Citation } from "@splex/shared-types";

interface CitationsListProps {
  citations: Citation[];
}

// Backend already filters citation URLs to http(s)-only, non-internal
// targets (research/security.ts's isSafeExternalUrl) before they're ever
// sent to the client — this re-checks the scheme independently rather
// than trusting that held, since an href built from any other scheme
// (javascript:, data:, ...) would be a live XSS vector the instant it's
// rendered as a clickable link, and that's too high a cost to rely on a
// single layer for.
function isRenderableHttpUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "http:" || new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Only ever rendered when the backend actually reports citations (see
// DoneEventData.citations' doc comment — absent, not [], when no search
// happened) — this component itself has no "did we search?" logic of its
// own, by design, so it can't accidentally imply a search occurred.
export function CitationsList({ citations }: CitationsListProps) {
  const safeCitations = citations.filter((c) => isRenderableHttpUrl(c.url));
  if (safeCitations.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
      <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
        <Globe size={11} strokeWidth={1.6} />
        Sources
      </div>
      <div className="flex flex-wrap gap-1.5">
        {safeCitations.map((c, i) => (
          <a
            key={`${c.url}-${i}`}
            href={c.url}
            target="_blank"
            rel="noreferrer noopener"
            title={c.snippet || c.title}
            className="max-w-[220px] truncate rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-accent hover:text-accent"
          >
            {i + 1}. {c.title}
          </a>
        ))}
      </div>
    </div>
  );
}
