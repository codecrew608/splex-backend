import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground",
        // Border shifts on hover as an affordance before the field is even
        // focused; the accent halo on focus reads as "this is where your
        // input is going" without the harsh default outline.
        "transition-[border-color,box-shadow] duration-[180ms] ease-out hover:border-border-strong",
        // focus-visible:outline-none suppresses the global focus ring
        // (globals.css) specifically here — a text input always matches
        // :focus-visible, so without this it draws the global outline AND
        // this halo at once, which reads as a doubled ring. The halo below
        // is the stronger indicator of the two, so it's the one kept.
        "focus:border-accent focus:outline-none focus-visible:outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)]",
        className,
      )}
      {...props}
    />
  );
});
