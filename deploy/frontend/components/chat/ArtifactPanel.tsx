"use client";

import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { X, Copy, Check, Download } from "lucide-react";
import type { ExtractedArtifact } from "@/lib/extractArtifacts";
import { SYNTAX_HIGHLIGHT_STYLE } from "./CodeBlock";

interface ArtifactPanelProps {
  artifact: ExtractedArtifact;
  onClose: () => void;
}

// Slide-in panel a substantial code block opens into (see ArtifactCard) —
// the code streams into it live as the underlying message keeps arriving,
// since this just renders whatever the current extractArtifacts() pass
// produced for the same artifact id.
export function ArtifactPanel({ artifact, onClose }: ArtifactPanelProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(artifact.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleDownload() {
    const blob = new Blob([artifact.code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = artifact.title;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-surface sm:w-[440px]">
      <div className="flex h-[58px] shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">{artifact.title}</span>
        <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-accent">
          {artifact.language}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy code"
          aria-label="Copy code"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          {copied ? <Check size={14} strokeWidth={1.8} /> : <Copy size={14} strokeWidth={1.8} />}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          title="Download file"
          aria-label="Download file"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <Download size={14} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <SyntaxHighlighter
          language={artifact.language || "text"}
          style={SYNTAX_HIGHLIGHT_STYLE}
          customStyle={{
            margin: 0,
            minHeight: "100%",
            background: "var(--code-background)",
            color: "var(--foreground)",
            fontSize: "12.5px",
            lineHeight: 1.65,
            padding: "16px",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
          showLineNumbers
          wrapLongLines
        >
          {artifact.code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
