"use client";

import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import type { PrismAsyncLight } from "react-syntax-highlighter";
import { Check, Copy } from "lucide-react";

interface CodeBlockProps {
  language: string;
  code: string;
}

// A theme built from the --syn-* CSS variables (defined per-theme in
// globals.css) instead of a canned PrismJS theme like oneDark — oneDark
// is dark-only and clashed hard against the new warm light palette, and
// unlike a static color set, these tokens already branch for light/dark
// via the same [data-theme] mechanism every other color in the app uses.
const style: PrismAsyncLight["props"]["style"] = {
  comment: { color: "var(--syn-comment)", fontStyle: "italic" },
  prolog: { color: "var(--syn-comment)" },
  doctype: { color: "var(--syn-comment)" },
  cdata: { color: "var(--syn-comment)" },
  punctuation: { color: "var(--foreground)" },
  property: { color: "var(--syn-number)" },
  tag: { color: "var(--syn-keyword)" },
  boolean: { color: "var(--syn-number)" },
  number: { color: "var(--syn-number)" },
  constant: { color: "var(--syn-number)" },
  symbol: { color: "var(--syn-number)" },
  selector: { color: "var(--syn-string)" },
  "attr-name": { color: "var(--syn-function)" },
  string: { color: "var(--syn-string)" },
  char: { color: "var(--syn-string)" },
  builtin: { color: "var(--syn-function)" },
  operator: { color: "var(--foreground)" },
  entity: { color: "var(--syn-function)" },
  url: { color: "var(--syn-function)" },
  variable: { color: "var(--foreground)" },
  atrule: { color: "var(--syn-keyword)" },
  "attr-value": { color: "var(--syn-string)" },
  keyword: { color: "var(--syn-keyword)" },
  function: { color: "var(--syn-function)" },
  "class-name": { color: "var(--syn-function)" },
  regex: { color: "var(--syn-string)" },
  important: { color: "var(--syn-keyword)", fontWeight: "bold" },
};

export function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-code-background px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{language || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md px-[7px] py-[3px] font-mono text-[10px] tracking-[0.06em] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "COPIED" : "COPY"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={style}
        customStyle={{
          margin: 0,
          background: "var(--code-background)",
          color: "var(--foreground)",
          fontSize: "12.5px",
          lineHeight: 1.65,
          padding: "14px 14px 15px",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        wrapLongLines
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
