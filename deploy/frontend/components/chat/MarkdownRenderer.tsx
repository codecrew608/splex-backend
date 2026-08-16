"use client";

import { isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
    <div className="prose-splex max-w-none text-[0.95rem] leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
              <code className={className ?? "rounded bg-code-background px-1.5 py-0.5 text-[0.85em]"}>
                {children}
              </code>
            );
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {children}
              </a>
            );
          },
          ul({ children }) {
            return <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>;
          },
          p({ children }) {
            return <p className="mb-3 last:mb-0">{children}</p>;
          },
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-sm">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border-b border-border bg-surface-raised px-3 py-1.5 text-left font-medium">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border-b border-border px-3 py-1.5">{children}</td>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
