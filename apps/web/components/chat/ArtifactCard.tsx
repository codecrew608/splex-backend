"use client";

import { FileCode2 } from "lucide-react";
import type { ExtractedArtifact } from "@/lib/extractArtifacts";

interface ArtifactCardProps {
  artifact: ExtractedArtifact;
  active: boolean;
  onOpen: () => void;
}

// The inline "reference" a substantial code block becomes in the chat
// bubble itself — the actual code lives in ArtifactPanel, opened by
// clicking this. Deliberately compact: this replaces what would otherwise
// be a long scrolling code block sitting in the middle of the reply.
export function ArtifactCard({ artifact, active, onOpen }: ArtifactCardProps) {
  const lineCount = artifact.code.split("\n").length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`my-2 flex w-full max-w-sm items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-left transition-colors ${
        active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-accent"
      }`}
    >
      <FileCode2 size={16} strokeWidth={1.6} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">{artifact.title}</span>
        <span className="block text-[11px] text-muted-foreground">{lineCount} lines · click to view</span>
      </span>
    </button>
  );
}
