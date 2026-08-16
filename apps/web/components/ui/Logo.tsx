interface LogoMarkProps {
  size?: number;
  className?: string;
}

// Ported directly from the SPLEX Chat reference design — three
// decreasing-weight bars into an accent-colored arrow, no background
// shape (the reference logo has none, unlike the earlier gradient-circle
// mark). Strokes use currentColor so it follows the surrounding text
// color; the arrowhead uses --accent directly, matching the reference.
export function LogoMark({ size = 26, className }: LogoMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M2 5.5H9.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M2 13H9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2 20.5H9.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M10.5 3.6L18 13L10.5 22.4Z" fill="var(--accent)" />
      <path d="M18 13H24.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

interface LogoProps {
  size?: number;
  wordmarkClassName?: string;
  className?: string;
}

export function Logo({ size = 26, wordmarkClassName, className }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-[11px] text-foreground ${className ?? ""}`}>
      <LogoMark size={size} />
      <span className={`text-[13.5px] font-semibold tracking-[0.16em] text-foreground ${wordmarkClassName ?? ""}`}>SPLEX</span>
    </span>
  );
}
