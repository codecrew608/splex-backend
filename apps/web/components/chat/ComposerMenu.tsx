"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, FileUp, ImagePlus, Camera, Sparkles, Volume2, Video, Presentation, Telescope, Lock } from "lucide-react";
import { useEntitlements } from "@/hooks/useEntitlements";
import { cn } from "@/lib/cn";
import type { Capability } from "@splex/shared-types";

interface MenuAction {
  key: string;
  label: string;
  icon: typeof Plus;
  // Capability this maps to for entitlement gating — undefined means
  // "always available regardless of plan" (file/image upload have no
  // plan-level lock, only per-plan upload-count/storage quotas the
  // backend already enforces on the upload route itself).
  capability?: Capability;
  onSelect: () => void;
}

interface ComposerMenuProps {
  onUploadFile: () => void;
  onOpenCamera: () => void;
  // Prefills the composer with a natural-language lead-in for the given
  // capability and focuses it — Cortex still classifies and routes the
  // actual request server-side once sent, same as if the user had typed
  // the whole thing themselves. This deliberately does NOT add a
  // client-side "force this capability" override: SPLEX's whole design is
  // that Cortex decides, not a client-supplied flag, and inventing one
  // here would be a second, parallel routing signal to keep in sync with
  // the classifier — exactly what the spec says not to build.
  onPrefill: (text: string) => void;
  disabled?: boolean;
}

const CAPABILITY_ACTIONS: Array<Omit<MenuAction, "onSelect"> & { prefill: string }> = [
  { key: "web_search", label: "Search the web", icon: Sparkles, capability: "web_search", prefill: "Search the web for " },
  { key: "image", label: "Generate an image", icon: ImagePlus, capability: "image", prefill: "Generate an image of " },
  { key: "audio", label: "Generate audio", icon: Volume2, capability: "audio", prefill: "Generate audio narrating: " },
  { key: "video", label: "Generate a video", icon: Video, capability: "video", prefill: "Generate a short video of " },
  { key: "ppt", label: "Create a presentation", icon: Presentation, capability: "ppt", prefill: "Create a presentation about " },
  { key: "deep_research", label: "Deep Research", icon: Telescope, capability: "deep_research", prefill: "Do a deep research report on " },
];

export function ComposerMenu({ onUploadFile, onOpenCamera, onPrefill, disabled }: ComposerMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { snapshot } = useEntitlements();

  const quotaFor = (capability: Capability) => snapshot?.quotas.find((q) => q.capability === capability);
  // Locked in the entitlement sense (this plan doesn't include the
  // capability at all — limit === 0) — distinct from "included but you've
  // used today's allotment" (limit > 0, allowed currently false), which
  // stays clickable here; the real-time quota-exceeded message on send
  // already covers that case correctly and doesn't need duplicating.
  const isPlanLocked = (capability?: Capability) => {
    if (!capability) return false;
    const q = quotaFor(capability);
    return q ? q.limit === 0 : false;
  };

  const actions: MenuAction[] = [
    { key: "upload_file", label: "Upload file", icon: FileUp, onSelect: onUploadFile },
    { key: "upload_image", label: "Upload image", icon: ImagePlus, onSelect: onUploadFile },
    { key: "camera", label: "Take a photo", icon: Camera, onSelect: onOpenCamera },
    ...CAPABILITY_ACTIONS.map((a) => ({
      key: a.key,
      label: a.label,
      icon: a.icon,
      capability: a.capability,
      onSelect: () => (isPlanLocked(a.capability) ? router.push("/upgrade") : onPrefill(a.prefill)),
    })),
  ];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % actions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + actions.length) % actions.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        actions[activeIndex]?.onSelect();
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex, actions.length]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setActiveIndex(0);
          setOpen((o) => !o);
        }}
        disabled={disabled}
        title="Add"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex h-[31px] w-[31px] shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40",
          open ? "bg-hover text-foreground" : "text-muted-foreground hover:bg-hover hover:text-foreground",
        )}
      >
        <Plus size={18} strokeWidth={1.6} className={cn("transition-transform duration-150", open && "rotate-45")} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Add attachment or capability"
          className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-[228px] animate-fade-in-up overflow-hidden rounded-[14px] border border-border-strong bg-surface-raised py-1.5"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          {actions.map((action, i) => {
            const locked = isPlanLocked(action.capability);
            const Icon = action.icon;
            return (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  action.onSelect();
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-[10px] px-3.5 py-[9px] text-left text-[13.5px] transition-colors",
                  i === activeIndex ? "bg-hover" : "",
                  locked ? "text-muted-foreground" : "text-foreground",
                )}
              >
                <Icon size={15} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
                <span className="flex-1">{action.label}</span>
                {locked && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full border border-border-strong px-[7px] py-[2px] font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground">
                    <Lock size={9} strokeWidth={2} />
                    Starter
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
