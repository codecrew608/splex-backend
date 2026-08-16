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
    <div className="max-w-none text-[15px] leading-[1.68] text-foreground [text-wrap:pretty]">
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
              <code
                className={
                  className ?? "rounded-[4px] border border-border bg-code-background px-[5px] py-px font-mono text-[0.86em]"
                }
              >
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
            return <ul className="my-2 list-disc space-y-1.5 pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-2 list-decimal space-y-1.5 pl-5">{children}</ol>;
          },
          h1({ children }) {
            return <h1 className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mt-1 text-[15px] font-semibold tracking-[-0.01em]">{children}</h3>;
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
