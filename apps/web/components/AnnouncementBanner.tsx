"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";

interface Announcement {
  id: string;
  message: string;
}

// Dismissal is per-announcement (keyed by id), not a single "seen it"
// flag — a NEW announcement (e.g. a future launch) must always resurface
// even for someone who dismissed an earlier one. Defaults to visible
// (not dismissed) so the common case — nobody has seen this yet — renders
// immediately with no flash-of-nothing; only flips to hidden once
// localStorage confirms this exact id was already dismissed.
export function AnnouncementBanner({ announcement }: { announcement: Announcement | null }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!announcement) return;
    try {
      if (localStorage.getItem(`splex-announcement-dismissed-${announcement.id}`) === "true") {
        setDismissed(true);
      }
    } catch {
      // Private window / blocked storage — fine, it just won't remember
      // dismissal across reloads. Never a reason to hide the banner.
    }
  }, [announcement]);

  if (!announcement || dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(`splex-announcement-dismissed-${announcement!.id}`, "true");
    } catch {
      // Best effort — worst case it reappears next load, not a correctness issue.
    }
  }

  return (
    <div className="flex items-start gap-2.5 border-b border-accent/30 bg-accent-soft px-4 py-2.5 text-[13px] text-foreground sm:px-6">
      <Sparkles size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-accent" />
      <span className="flex-1">{announcement.message}</span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X size={15} strokeWidth={1.8} />
      </button>
    </div>
  );
}
