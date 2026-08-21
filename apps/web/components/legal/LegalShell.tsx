import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

interface LegalShellProps {
  title: string;
  updated: string;
  children: ReactNode;
}

export function LegalShell({ title, updated, children }: LegalShellProps) {
  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link href="/">
          <Logo size={22} />
        </Link>
        <div className="flex items-center gap-4">
          <nav className="flex items-center gap-4 text-[13px] text-muted-foreground">
            <Link href="/legal/terms" className="transition-colors hover:text-foreground">
              Terms
            </Link>
            <Link href="/legal/privacy" className="transition-colors hover:text-foreground">
              Privacy
            </Link>
            <Link href="/legal/acceptable-use" className="transition-colors hover:text-foreground">
              Acceptable Use
            </Link>
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-[720px] px-6 py-14">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {updated}</p>
        <div className="legal-prose mt-10 flex flex-col gap-7 text-[14.5px] leading-[1.7] text-foreground">{children}</div>
      </main>
    </div>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-[15px] font-semibold text-foreground">{heading}</h2>
      <div className="flex flex-col gap-2.5 text-muted-foreground [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-foreground [&_strong]:font-medium">
        {children}
      </div>
    </section>
  );
}
