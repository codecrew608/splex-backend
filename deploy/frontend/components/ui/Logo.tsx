interface LogoMarkProps {
  size?: number;
  className?: string;
}

export function LogoMark({ size = 28, className }: LogoMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <rect width="32" height="32" rx="10" fill="url(#splex-logo-gradient)" />
      <circle cx="15.5" cy="16.5" r="7.25" stroke="white" strokeOpacity="0.95" strokeWidth="2.15" />
      <circle cx="21.5" cy="10.5" r="2.75" fill="white" />
      <defs>
        <linearGradient id="splex-logo-gradient" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffb6a1" />
          <stop offset="1" stopColor="#e8492a" />
        </linearGradient>
      </defs>
    </svg>
  );
}

interface LogoProps {
  size?: number;
  wordmarkClassName?: string;
  className?: string;
}

export function Logo({ size = 28, wordmarkClassName, className }: LogoProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <LogoMark size={size} />
      <span className={`text-base font-semibold tracking-tight text-foreground ${wordmarkClassName ?? ""}`}>SPLEX</span>
    </span>
  );
}
