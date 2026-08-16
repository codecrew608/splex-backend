"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Mic, Square } from "lucide-react";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";
import { useUserPlanTier } from "@/hooks/useUserPlanTier";
import { FILE_SIZE_LIMITS, formatBytes } from "@/lib/fileLimits";
import { AttachmentChip } from "./AttachmentChip";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL as string;
const MAX_ATTACHMENTS = 5;
const ACCEPT =
  "image/*,.pdf,.docx,.txt,.md,.csv,.js,.ts,.tsx,.jsx,.py,.json,.yaml,.yml,.sql,.html,.css,.sh,.go,.rs,.java,.c,.cpp,.rb,.php";

export interface StagedAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
  status: "uploading" | "processing" | "ready" | "failed";
}

interface ComposerProps {
  onSend: (text: string, fileIds?: string[]) => void;
  onStop?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

// Minimal ambient typing for the Web Speech API — not in lib.dom.d.ts.
interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

export function Composer({ onSend, onStop, isStreaming, disabled }: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceBaseRef = useRef("");
  const planTier = useUserPlanTier();

  const attachmentsBusy = attachments.some((a) => a.status === "uploading" || a.status === "processing");

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    setVoiceSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  function autosize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 196)}px`;
  }

  function toggleVoice() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    voiceBaseRef.current = value ? `${value} ` : "";

    recognition.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
      }
      setValue(voiceBaseRef.current + transcript);
      requestAnimationFrame(autosize);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }

  async function handleFilesPicked(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList).slice(0, MAX_ATTACHMENTS - attachments.length);
    const sizeLimit = FILE_SIZE_LIMITS[planTier];

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    for (const file of files) {
      if (file.size > sizeLimit) {
        window.alert(`${file.name} is over your plan's ${formatBytes(sizeLimit)} file size limit.`);
        continue;
      }

      const { data: fileRow, error: insertError } = await supabase
        .from("files")
        .insert({
          user_id: user.id,
          filename: file.name,
          file_type: file.type || "application/octet-stream",
          mime_type: file.type || null,
          size_bytes: file.size,
          storage_path: "", // set below once we have the file id
          processing_status: "uploaded",
        })
        .select("id")
        .single();

      if (insertError || !fileRow) {
        // The files.trg_files_enforce_limits trigger (db/migrations/0011)
        // rejects the insert outright once a plan's monthly upload count or
        // total storage cap is hit — surface that specifically rather than
        // letting the file silently vanish with no feedback, matching the
        // window.alert pattern already used for the per-file size check above.
        if (insertError?.message?.includes("file_upload_limit_exceeded")) {
          window.alert("You've hit your plan's monthly file upload limit. Upgrade for a higher limit.");
        } else if (insertError?.message?.includes("storage_limit_exceeded")) {
          window.alert("You've hit your plan's storage limit. Delete some files or upgrade for more space.");
        }
        continue;
      }

      const fileId = fileRow.id as string;
      const storagePath = `${user.id}/${fileId}/${file.name}`;
      setAttachments((prev) => [...prev, { id: fileId, filename: file.name, mimeType: file.type || null, status: "uploading" }]);

      await supabase.from("files").update({ storage_path: storagePath }).eq("id", fileId);

      const { error: uploadError } = await supabase.storage.from("uploads").upload(storagePath, file, {
        contentType: file.type || undefined,
        upsert: false,
      });

      if (uploadError) {
        setAttachments((prev) => prev.map((a) => (a.id === fileId ? { ...a, status: "failed" } : a)));
        continue;
      }

      setAttachments((prev) => prev.map((a) => (a.id === fileId ? { ...a, status: "processing" } : a)));

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const res = await fetch(`${BACKEND_URL}/files/${fileId}/process`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session?.access_token}` },
        });
        setAttachments((prev) => prev.map((a) => (a.id === fileId ? { ...a, status: res.ok ? "ready" : "failed" } : a)));
      } catch {
        setAttachments((prev) => prev.map((a) => (a.id === fileId ? { ...a, status: "failed" } : a)));
      }
    }
  }

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || isStreaming || disabled || attachmentsBusy) return;
    if (listening) recognitionRef.current?.stop();
    const readyFileIds = attachments.filter((a) => a.status === "ready").map((a) => a.id);
    onSend(trimmed, readyFileIds.length > 0 ? readyFileIds : undefined);
    setValue("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[720px] px-6 pb-[22px] pt-3.5">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
            />
          ))}
        </div>
      )}

      <div
        className="flex flex-col gap-[9px] rounded-[18px] border border-border-strong bg-surface-raised px-[15px] pb-[11px] pt-[14px]"
        style={{ boxShadow: "var(--shadow-card)" }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            handleFilesPicked(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            autosize();
          }}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder="Describe what you want to get done"
          className="max-h-[196px] w-full resize-none overflow-y-auto bg-transparent p-0.5 pt-0 text-[15px] leading-[1.6] text-foreground placeholder:text-muted-foreground focus:outline-none"
          disabled={disabled}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
            title="Attach a file"
            className="flex h-[31px] w-[31px] shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40"
          >
            <Paperclip size={17} strokeWidth={1.4} />
          </button>
          {voiceSupported && (
            <button
              type="button"
              onClick={toggleVoice}
              disabled={disabled}
              title={listening ? "Stop voice input" : "Voice input"}
              className={cn(
                "flex h-[31px] w-[31px] shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40",
                listening ? "text-accent" : "text-muted-foreground hover:bg-hover hover:text-foreground",
              )}
            >
              <Mic size={17} strokeWidth={1.4} />
            </button>
          )}
          <span className="flex-1" />
          <span className="pr-1 font-mono text-[9.5px] tracking-[0.08em] text-muted-foreground">
            {value.trim() ? "ENTER TO SEND" : ""}
          </span>
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="flex h-[31px] w-[31px] shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:opacity-80"
              title="Stop"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!value.trim() || disabled || attachmentsBusy}
              className={cn(
                "flex h-[31px] w-[31px] shrink-0 items-center justify-center rounded-full transition-colors",
                value.trim() && !disabled && !attachmentsBusy
                  ? "bg-accent text-accent-foreground"
                  : "bg-hover text-muted-foreground",
              )}
              title="Send"
            >
              <ArrowUp size={16} strokeWidth={1.6} />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
        SPLEX can make mistakes. Consider checking important information.
      </p>
    </div>
  );
}
