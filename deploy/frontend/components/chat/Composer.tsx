"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Mic, Square } from "lucide-react";
import { cn } from "@/lib/cn";
import { createClient } from "@/lib/supabase/client";
import { useUserPlanTier } from "@/hooks/useUserPlanTier";
import { FILE_SIZE_LIMITS, formatBytes } from "@/lib/fileLimits";
import { AttachmentChip } from "./AttachmentChip";
import { ComposerMenu } from "./ComposerMenu";
import { BACKEND_URL } from "@/lib/backendUrl";
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
  onSend: (text: string, attachments?: SentAttachment[]) => void;
  onStop?: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

// What the composer hands off on send — enough for useChatStream to both
// build the API request (id) and render the attachment chip on the user's
// own bubble immediately, without waiting on a server round-trip
// (filename/mimeType, mirroring shared-types' MessageAttachment).
export interface SentAttachment {
  id: string;
  filename: string;
  mimeType: string | null;
}

// Minimal ambient typing for the Web Speech API — not in lib.dom.d.ts.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike extends ArrayLike<SpeechRecognitionAlternativeLike> {
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

// The engine's accuracy depends heavily on being told the right locale —
// en-US applied to, say, Indian or British English measurably degrades
// recognition, and this app's audience isn't US-default (₹ pricing,
// Asia/Kolkata billing periods). The browser already knows the user's
// locale, so ask it rather than hardcoding one.
function resolveRecognitionLang(): string {
  if (typeof navigator === "undefined") return "en-US";
  const tag = navigator.languages?.[0] || navigator.language;
  // A bare "en" is a valid navigator.language value but a poor recognition
  // hint — the engine wants a region. Anything already regioned passes
  // through untouched.
  if (!tag) return "en-US";
  return tag.includes("-") ? tag : `${tag}-US`;
}

// Errors that mean "keep going": no-speech fires on any pause long enough
// for the engine to give up on the current utterance, and aborted fires as
// a normal part of the stop/restart cycle below. Treating either as fatal
// is why the mic used to silently switch itself off mid-thought.
const TRANSIENT_RECOGNITION_ERRORS = new Set(["no-speech", "aborted", "network"]);

// FIX (user-reported, 2026-09-04): "the mic thing is not working properly."
// The transient/fatal split above was already correct, but neither path
// told the user anything — a fatal error (mic permission blocked, no
// microphone) just silently turned the button back off with zero
// explanation, which reads exactly like "broken" from the outside. And a
// TRANSIENT error that never actually clears (e.g. a flaky network only
// ever produces "network" errors, one after another) restarted forever
// with no cap — the button stayed lit as if it were listening while
// nothing was ever transcribed. Both are fixed below: every fatal error
// gets a real message, and a restart loop that fires too many times too
// fast gets treated as a fatal condition instead of retried indefinitely.
const RESTART_WINDOW_MS = 15_000;
const MAX_RESTARTS_IN_WINDOW = 6;
const VOICE_ERROR_DISPLAY_MS = 6_000;

function describeVoiceError(code: string): string {
  switch (code) {
    case "not-allowed":
      return "Microphone access is blocked. Allow it in your browser's site settings and try again.";
    case "service-not-allowed":
      return "Voice input isn't available right now. Try again in a moment.";
    case "audio-capture":
      return "No microphone found. Check that one is connected and try again.";
    case "language-not-supported":
      return "Voice input doesn't support your language yet.";
    default:
      return "Voice input stopped unexpectedly. Try again.";
  }
}

// maxAlternatives asks the engine for several candidate transcriptions per
// utterance; alternative[0] is its own first guess but not always its most
// confident one, so pick by confidence explicitly. Falls back to [0] when
// an engine reports no confidence at all (Safari leaves it at 0).
function bestAlternative(result: SpeechRecognitionResultLike): string {
  let best = result[0];
  for (let i = 1; i < result.length; i++) {
    if (result[i].confidence > best.confidence) best = result[i];
  }
  return best.transcript;
}

export function Composer({ onSend, onStop, isStreaming, disabled }: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [listening, setListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Text that was in the box before the mic was switched on — dictation is
  // appended to it rather than replacing it.
  const voiceBaseRef = useRef("");
  // Utterances the engine has FINALIZED this session. Kept separate from
  // the live interim guess because a finalized phrase must never be
  // rewritten by a later interim result: the old code rebuilt the whole
  // transcript from results[] on every event, so words the engine had
  // already committed to could still change under the user as they kept
  // talking. Only the interim tail is volatile now.
  const finalTranscriptRef = useRef("");
  // Whether the USER still wants the mic on, as opposed to whether the
  // engine happens to be running right now — the two diverge constantly,
  // because Chrome ends a recognition session on its own after a few
  // seconds of silence. onend consults this to decide restart vs stop.
  const wantsListeningRef = useRef(false);
  // Timestamps of recent auto-restarts (see onend below) — a rolling
  // window used to tell "Chrome ending the session after a pause, as
  // normal" apart from "this keeps failing and restarting won't help."
  const restartTimestampsRef = useRef<number[]>([]);
  const planTier = useUserPlanTier();

  const attachmentsBusy = attachments.some((a) => a.status === "uploading" || a.status === "processing");

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    setVoiceSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    // Hard-stop on unmount: onend's auto-restart would otherwise keep the
    // engine (and the browser's mic indicator) alive after navigating away
    // mid-dictation. abort() rather than stop() so no trailing result
    // fires into an unmounted component.
    return () => {
      wantsListeningRef.current = false;
      recognitionRef.current?.abort();
    };
  }, []);

  // Non-blocking (no window.alert — this can fire mid-dictation, and a
  // modal would swallow the keystroke/focus the user is mid-flow on).
  // Self-clears so a transient hiccup doesn't leave a stale message
  // sitting there after the user's moved on.
  useEffect(() => {
    if (!voiceError) return;
    const t = setTimeout(() => setVoiceError(null), VOICE_ERROR_DISPLAY_MS);
    return () => clearTimeout(t);
  }, [voiceError]);

  function autosize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 196)}px`;
  }

  function buildRecognition(): SpeechRecognitionLike | null {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return null;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = resolveRecognitionLang();
    // Ask for several candidate transcriptions per utterance so the
    // highest-confidence one can be picked below, instead of blindly
    // taking alternative [0].
    recognition.maxAlternatives = 3;

    recognition.onresult = (e) => {
      let interim = "";
      // Start at resultIndex, not 0 — everything before it was already
      // folded into finalTranscriptRef on an earlier event, and
      // re-processing it duplicated finalized text.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (result.isFinal) {
          finalTranscriptRef.current += bestAlternative(result);
        } else {
          interim += result[0].transcript;
        }
      }
      setValue(voiceBaseRef.current + finalTranscriptRef.current + interim);
      requestAnimationFrame(autosize);
      // A real result is proof the connection is genuinely healthy right
      // now — any earlier restarts (a rough patch that's since recovered)
      // shouldn't count against a later, unrelated hiccup.
      restartTimestampsRef.current = [];
      setVoiceError(null);
    };

    recognition.onerror = (e) => {
      if (TRANSIENT_RECOGNITION_ERRORS.has(e.error)) return; // onend restarts us
      // Genuinely fatal (not-allowed, service-not-allowed, audio-capture):
      // stop asking, or onend would restart into the same failure forever.
      // Previously this just flipped the button back off with no
      // explanation — indistinguishable from "broken" to the user.
      wantsListeningRef.current = false;
      setListening(false);
      setVoiceError(describeVoiceError(e.error));
    };

    recognition.onend = () => {
      // Chrome ends the session on its own after a few seconds of silence.
      // Restarting keeps the mic live until the user actually turns it off,
      // which is what "continuous" implies to them even though the API
      // doesn't guarantee it.
      if (!wantsListeningRef.current) {
        setListening(false);
        return;
      }
      // A transient error (network, no-speech) that never actually
      // resolves produces exactly this: onend fires, wantsListening is
      // still true, restart, repeat — forever, with the button lit the
      // whole time as if it were working. Cap it: too many restarts in
      // too short a window means restarting isn't helping.
      const now = Date.now();
      const recent = restartTimestampsRef.current.filter((t) => now - t < RESTART_WINDOW_MS);
      recent.push(now);
      restartTimestampsRef.current = recent;
      if (recent.length > MAX_RESTARTS_IN_WINDOW) {
        wantsListeningRef.current = false;
        setListening(false);
        setVoiceError("Voice input is having trouble staying connected. Check your network and try again.");
        return;
      }
      try {
        recognitionRef.current?.start();
      } catch {
        // Already-started races are harmless; anything else means the
        // engine is gone, so reflect that instead of pretending to listen.
        wantsListeningRef.current = false;
        setListening(false);
        setVoiceError(describeVoiceError("aborted"));
      }
    };

    return recognition;
  }

  async function toggleVoice() {
    if (listening) {
      wantsListeningRef.current = false;
      recognitionRef.current?.stop();
      return;
    }

    setVoiceError(null);
    restartTimestampsRef.current = [];

    // Progressive enhancement, not load-bearing: Chrome/Edge support
    // querying microphone permission ahead of time, so a blocked mic can
    // say so immediately instead of waiting on recognition.start() to
    // fail. Safari doesn't implement this query at all — caught and
    // ignored, falling straight through to the start()-and-see-what-
    // happens path every browser already supports via onerror above.
    try {
      const nav = navigator as Navigator & { permissions?: { query: (d: { name: string }) => Promise<{ state: string }> } };
      const status = await nav.permissions?.query({ name: "microphone" });
      if (status?.state === "denied") {
        setVoiceError(describeVoiceError("not-allowed"));
        return;
      }
    } catch {
      // Unsupported query — proceed normally.
    }

    const recognition = buildRecognition();
    if (!recognition) return;

    // Snapshot what's already typed and reset the dictation buffer, so a
    // second mic session appends to the box rather than replaying the
    // first session's words.
    voiceBaseRef.current = value ? `${value} ` : "";
    finalTranscriptRef.current = "";

    recognitionRef.current = recognition;
    wantsListeningRef.current = true;
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

      // Only the genuine metadata is sent now. user_id, size_bytes and
      // storage_path are database-owned as of migration 0028 — the client
      // holds no write grant on them, because a client-chosen storage_path
      // let a user point their row at someone else's object and have the
      // backend read it with the service-role client.
      //
      // storage_path comes BACK from the insert: a trigger computes the
      // canonical <user_id>/<id>/<sanitised filename>, so the value uploaded
      // to is always the one the server will later validate, with no
      // sanitisation rules duplicated here to drift out of sync.
      const { data: fileRow, error: insertError } = await supabase
        .from("files")
        .insert({
          filename: file.name,
          file_type: file.type || "application/octet-stream",
          mime_type: file.type || null,
          processing_status: "uploaded",
        })
        .select("id, storage_path")
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
      // Server-computed; never constructed here. Storage RLS independently
      // requires the first path segment to equal auth.uid(), so an upload
      // can only ever land in the caller's own namespace.
      const storagePath = fileRow.storage_path as string;
      setAttachments((prev) => [...prev, { id: fileId, filename: file.name, mimeType: file.type || null, status: "uploading" }]);

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
    if (listening) {
      // Clear the intent flag BEFORE stopping — otherwise onend's restart
      // branch fires and the mic comes straight back on after send.
      wantsListeningRef.current = false;
      recognitionRef.current?.stop();
    }
    const readyAttachments: SentAttachment[] = attachments
      .filter((a) => a.status === "ready")
      .map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType }));
    onSend(trimmed, readyAttachments.length > 0 ? readyAttachments : undefined);
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

  function handlePrefill(text: string) {
    setValue(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
      autosize();
    });
  }

  return (
    <div className="mx-auto w-full max-w-[720px] px-3 pb-[18px] pt-3 sm:px-6 sm:pb-[22px] sm:pt-3.5">
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
        {voiceError && (
          <p className="px-0.5 text-[11.5px] leading-snug text-danger" role="alert">
            {voiceError}
          </p>
        )}
        <div className="flex items-center gap-1">
          <ComposerMenu
            onUploadFile={() => fileInputRef.current?.click()}
            onPrefill={handlePrefill}
            disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
          />
          <button
            type="button"
            onClick={toggleVoice}
            disabled={disabled || !voiceSupported}
            title={
              !voiceSupported
                ? "Voice input isn't supported in this browser — try Chrome or Edge"
                : listening
                  ? "Stop voice input"
                  : "Voice input"
            }
            aria-label={listening ? "Stop voice input" : "Voice input"}
            aria-pressed={listening}
            className={cn(
              "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40 sm:h-[31px] sm:w-[31px]",
              listening ? "text-accent" : "text-muted-foreground hover:bg-hover hover:text-foreground",
            )}
          >
            {listening && (
              // Reuses the app's existing "quiet, ongoing activity" pulse
              // (same token as the sidebar's usage indicator) rather than a
              // new animation — the mic button's own color change is easy
              // to miss, and this is the difference between "did my click
              // register?" and a clear, ongoing "yes, it's listening."
              <span className="absolute inset-2 rounded-full bg-accent/20 animate-pulse-soft" aria-hidden />
            )}
            <Mic size={17} strokeWidth={1.4} className="relative" />
          </button>

          <span className="flex-1" />
          <span className="pr-1 font-mono text-[9.5px] tracking-[0.08em] text-muted-foreground">
            {value.trim() ? "ENTER TO SEND" : ""}
          </span>
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:opacity-80 sm:h-[31px] sm:w-[31px]"
              title="Stop"
              aria-label="Stop generating"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!value.trim() || disabled || attachmentsBusy}
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors sm:h-[31px] sm:w-[31px]",
                value.trim() && !disabled && !attachmentsBusy
                  ? "bg-accent text-accent-foreground"
                  : "bg-hover text-muted-foreground",
              )}
              title="Send"
              aria-label="Send message"
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
