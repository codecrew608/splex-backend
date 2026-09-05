"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { BACKEND_URL } from "@/lib/backendUrl";

interface ProfileSectionProps {
  userId: string;
  initialFullName: string;
  initialAvatarUrl: string | null;
}

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB — generous for a profile picture, small enough not to be an abuse vector
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

async function authHeader(): Promise<Record<string, string> | null> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  return { Authorization: `Bearer ${session.access_token}` };
}

export function ProfileSection({ userId, initialFullName, initialAvatarUrl }: ProfileSectionProps) {
  const [fullName, setFullName] = useState(initialFullName);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [nameMessage, setNameMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [avatarMessage, setAvatarMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    setSavingName(true);
    setNameMessage(null);

    const headers = await authHeader();
    if (!headers) {
      setSavingName(false);
      setNameMessage({ type: "error", text: "Your session expired. Please sign in again." });
      return;
    }

    const res = await fetch(`${BACKEND_URL}/account/display-name`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ fullName }),
    });
    setSavingName(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setNameMessage({ type: "error", text: body?.message || "Couldn't save your name. Please try again." });
      return;
    }
    setNameMessage({ type: "success", text: "Name updated." });
  }

  async function handleAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;

    setAvatarMessage(null);
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setAvatarMessage({ type: "error", text: "Please choose a PNG, JPEG, WebP, or GIF image." });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarMessage({ type: "error", text: "Image is too large — please choose one under 5MB." });
      return;
    }

    setUploadingAvatar(true);
    try {
      const supabase = createClient();
      const ext = file.type.split("/")[1] === "jpeg" ? "jpg" : file.type.split("/")[1];
      // Fixed filename per user (not a random one) — re-uploading replaces
      // the previous avatar via upsert instead of accumulating orphaned
      // files nothing ever references again.
      const path = `${userId}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
      if (uploadError) {
        setAvatarMessage({ type: "error", text: "Couldn't upload that image. Please try again." });
        return;
      }

      const headers = await authHeader();
      if (!headers) {
        setAvatarMessage({ type: "error", text: "Your session expired. Please sign in again." });
        return;
      }
      const res = await fetch(`${BACKEND_URL}/account/avatar`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ avatarPath: path }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setAvatarMessage({ type: "error", text: body?.message || "Couldn't save your profile picture. Please try again." });
        return;
      }

      // Cache-bust: the public URL for this path is stable, so an
      // unchanged query string would keep showing the browser's cached
      // (old) image after a re-upload to the exact same path.
      const { data } = supabase.storage.from("avatars").getPublicUrl(path);
      setAvatarUrl(`${data.publicUrl}?v=${Date.now()}`);
      setAvatarMessage({ type: "success", text: "Profile picture updated." });
    } finally {
      setUploadingAvatar(false);
    }
  }

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-border bg-surface p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Profile</p>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingAvatar}
          aria-label="Change profile picture"
          title="Change profile picture"
          className="group relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-strong bg-accent-soft text-lg font-semibold text-accent transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage URL, not a local/optimizable asset
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span>{(fullName || "?").slice(0, 1).toUpperCase()}</span>
          )}
          <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
            {uploadingAvatar ? "..." : "Change"}
          </span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          onChange={handleAvatarPick}
          className="hidden"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">Profile picture</p>
          <p className="text-xs text-muted-foreground">PNG, JPEG, WebP, or GIF — up to 5MB.</p>
          {avatarMessage && (
            <p className={`mt-1 text-xs ${avatarMessage.type === "error" ? "text-danger" : "text-muted-foreground"}`}>
              {avatarMessage.text}
            </p>
          )}
        </div>
      </div>

      <form onSubmit={handleSaveName} className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          maxLength={200}
          required
          className="max-w-xs"
          placeholder="Your name"
        />
        <Button type="submit" variant="secondary" disabled={savingName || fullName.trim().length === 0}>
          {savingName ? "Saving..." : "Save name"}
        </Button>
      </form>
      {nameMessage && (
        <p className={`text-sm ${nameMessage.type === "error" ? "text-danger" : "text-muted-foreground"}`}>
          {nameMessage.text}
        </p>
      )}
    </div>
  );
}
