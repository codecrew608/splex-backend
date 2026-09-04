"use client";

import { isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
// Third-party stylesheet, not a CSS module — Next's App Router supports
// importing one directly from the component that needs it rather than
// routing it through globals.css. KaTeX's own generated markup depends on
// this for correct glyph positioning; without it, math renders as
// unstyled/misaligned text instead of failing loudly, so it's easy to miss
// if this import is ever dropped.
import "katex/dist/katex.min.css";
import { CodeBlock } from "./CodeBlock";

interface MarkdownRendererProps {
  content: string;
}

interface CodeElementProps {
  className?: string;
  children?: React.ReactNode;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    // min-w-0 + break-words: a flex/grid child defaults to min-width:auto,
    // so a single long unbreakable token in a reply (a URL, a stack trace
    // path, a base64 blob) would widen this column past the viewport and
    // give the whole page a horizontal scrollbar — very visible on a
    // phone, where there's no slack to absorb it.
    <div className="min-w-0 max-w-none break-words text-[15px] leading-[1.68] text-foreground [text-wrap:pretty]">
      <ReactMarkdown
        // remarkMath parses $$...$$ into math nodes (inline when it appears
        // within a line, block/display when it's on its own line(s)) and
        // rehypeKatex renders those nodes to real KaTeX markup. Order
        // matters: remarkMath must run before the tree is handed to rehype.
        //
        // singleDollarTextMath: false turns OFF single-$ inline math —
        // remark-math's own README calls this out as the standard fix for
        // exactly the collision this app would otherwise hit constantly: an
        // ordinary reply mentioning a price ("$5 and $10") would otherwise
        // parse "5 and " as an inline formula. cortex/systemPrompt.ts's
        // MATH_NOTATION_GUIDANCE instructs the model to use $$...$$ for
        // both inline and display math specifically so this stays in sync
        // with what's actually enabled here.
        //
        // Malformed/unbalanced math (a genuine LaTeX syntax error the model
        // produced) fails closed — rehype-katex renders KaTeX's own inline
        // error text for just that span rather than throwing and blanking
        // the whole message.
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre({ children }) {
            const child = Array.isArray(children) ? children[0] : children;
            if (isValidElement<CodeElementProps>(child)) {
              const className = child.props.className ?? "";
              const match = /language-(\w+)/.exec(className);
              const codeText = String(child.props.children ?? "").replace(/\n$/, "");
              return <CodeBlock language={match?.[1] ?? ""} code={codeText} />;
            }
            return <pre>{children}</pre>;
          },
          code({ className, children }) {
            return (
              <code
                className={
                  className ?? "rounded-[4px] border border-border bg-code-background px-[5px] py-px font-mono text-[0.86em]"
                }
              >
                {children}
              </code>
            );
          },
          img({ src, alt }) {
            if (typeof src !== "string") return null;
            // eslint-disable-next-line @next/next/no-img-element -- remote/signed Supabase Storage URL, not a static local asset
            return <img src={src} alt={alt ?? ""} className="my-2 max-w-full rounded-lg border border-border" loading="lazy" />;
          },
          a({ href, children }) {
            // Generated audio is a normal markdown link (see
            // apps/backend/src/routes/chat.ts's audio buildMarkdown) whose
            // signed Storage URL happens to end in a known audio
            // extension before its `?token=...` query string — sniffing
            // that avoids inventing a new markdown syntax just for one
            // media kind.
            if (typeof href === "string" && /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(href)) {
              return (
                // eslint-disable-next-line jsx-a11y/media-has-caption -- generated speech, no caption track exists
                <audio controls src={href} className="my-2 w-full max-w-sm" />
              );
            }
            if (typeof href === "string" && /\.(mp4|webm|mov)(\?|$)/i.test(href)) {
              return (
                // eslint-disable-next-line jsx-a11y/media-has-caption -- generated video, no caption track exists
                <video controls src={href} className="my-2 w-full max-w-md rounded-lg border border-border" />
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {children}
              </a>
            );
          },
          ul({ children }) {
            return <ul className="my-2 list-disc space-y-1.5 pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-2 list-decimal space-y-1.5 pl-5">{children}</ol>;
          },
          // font-sans overrides globals.css's base h1–h4 rule (which now
          // sets the display face for page-level headings) — a heading
          // inside an AI reply is still chat message text, and the design
          // system reserves the display face for chrome, not paragraph-
          // length content: switching typefaces mid-response would read
          // as a glitch, not a heading.
          h1({ children }) {
            return <h1 className="mt-1 font-sans text-[15px] font-semibold tracking-[-0.01em]">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mt-1 font-sans text-[15px] font-semibold tracking-[-0.01em]">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mt-1 font-sans text-[15px] font-semibold tracking-[-0.01em]">{children}</h3>;
          },
          p({ children }) {
            return <p className="mb-3 last:mb-0">{children}</p>;
          },
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-[13.5px]">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="whitespace-nowrap border-b border-border bg-surface px-3.5 py-2.5 text-left text-xs font-medium text-muted-foreground">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border-t border-border px-3.5 py-2.5 align-top">{children}</td>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
