"use client";

import { FileText, Image as ImageIcon, Loader2, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { StagedAttachment } from "./Composer";

// Also renders a persisted MessageAttachment (shared-types) — filename +
// mimeType only, no status — for a message already sent/loaded from
// history. onRemove absent means read-only: no X button, since there's
// nothing a "remove" could mean for something already sent.
interface AttachmentChipProps {
  attachment: Pick<StagedAttachment, "filename" | "mimeType"> & { status?: StagedAttachment["status"] };
  onRemove?: () => void;
}

export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const isImage = attachment.mimeType?.startsWith("image/");
  const isBusy = attachment.status === "uploading" || attachment.status === "processing";
  const isFailed = attachment.status === "failed";

  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-xs",
        isFailed ? "border-danger/40 bg-danger/10 text-danger" : "border-border bg-surface-raised text-foreground",
      )}
    >
      {isBusy ? (
        <Loader2 size={13} className="shrink-0 animate-spin text-muted-foreground" />
      ) : isFailed ? (
        <TriangleAlert size={13} className="shrink-0" />
      ) : isImage ? (
        <ImageIcon size={13} className="shrink-0 text-accent" />
      ) : (
        <FileText size={13} className="shrink-0 text-accent" />
      )}
      <span className="max-w-[140px] truncate" title={attachment.filename}>
        {attachment.filename}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-border hover:text-foreground"
          title="Remove"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
