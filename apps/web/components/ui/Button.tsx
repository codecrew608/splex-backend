import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

// Primary carries a soft accent-tinted shadow that grows slightly on
// hover — the one place this UI uses elevation, reserved for the single
// most important action on a surface so it stays meaningful. Secondary/
// ghost stay flat and shift only their border/background, keeping the
// visual hierarchy between "the action" and "an action" unambiguous.
const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-foreground shadow-[0_1px_2px_rgba(21,21,31,0.08),0_4px_14px_-6px_var(--accent-soft)] hover:bg-accent-hover hover:shadow-[0_1px_2px_rgba(21,21,31,0.1),0_8px_22px_-8px_var(--accent-soft)]",
  secondary: "bg-surface-raised text-foreground border border-border-strong hover:border-accent hover:bg-hover",
  ghost: "text-foreground hover:bg-hover",
  danger: "bg-danger text-danger-foreground hover:opacity-90",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        // 180ms / ease-out: fast enough to feel instant on press, slow
        // enough to read as a deliberate state change rather than a
        // flicker. Transitions the specific properties that actually
        // change (not `all`, which would also animate layout-affecting
        // ones and cost frames).
        "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium",
        "transition-[background-color,border-color,box-shadow,opacity,transform] duration-[180ms] ease-out",
        "active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:active:scale-100",
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    />
  );
});
