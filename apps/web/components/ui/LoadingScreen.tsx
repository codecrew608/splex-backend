import { LogoMark } from "./Logo";

// Used both as a Next.js route-segment loading.tsx (automatic Suspense
// fallback while a page's Server Components fetch data) and anywhere else
// a full-screen loading state is needed.
export function LoadingScreen() {
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-background">
      <span className="animate-pulse-soft">
        <LogoMark size={34} />
      </span>
      <div className="flex items-center gap-[9px]">
        <span className="h-[6px] w-[6px] shrink-0 animate-pulse-soft rounded-full bg-accent" />
        <span className="font-mono text-[10.5px] uppercase tracking-[0.13em] text-muted-foreground">Loading SPLEX</span>
      </div>
    </div>
  );
}
