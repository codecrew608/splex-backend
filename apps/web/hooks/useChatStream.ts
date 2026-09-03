"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { streamChat } from "@/lib/chatStream";
import { fetchMediaStatus } from "@/lib/mediaStatus";
import type {
  ChatMessage,
  CortexDecisionPayload,
  CortexStatusStage,
  Citation,
  ResearchStage,
  CortexVersion,
  CortexRoutingInfo,
} from "@splex/shared-types";
import { useSidebarStore } from "@/state/sidebarStore";

interface PendingMedia {
  mediaId: string;
  messageId: string;
}

// Matched against apps/backend/src/routes/media.ts's polling cadence
// comment — not aggressive enough to hammer the backend (which itself
// calls out to OpenRouter on every non-terminal poll), frequent enough
// that "video ready" feels responsive rather than stale.
const MEDIA_POLL_INTERVAL_MS = 6_000;
// ~12 minutes of polling before giving up — generous relative to the
// spec's own 8-10s clip length, but bounded so a genuinely stuck job
// doesn't poll forever in a background tab.
const MEDIA_POLL_MAX_ATTEMPTS = 120;

// Reconciliation poll for an assistant row this tab did NOT itself start
// streaming — loaded fresh from the server (chat rehydration) still
// showing status:'streaming'. Most commonly: the generation genuinely
// finished a moment after the page's server-side fetch ran, or is still
// running in another tab/session; rarely, a row an unexpected server-side
// failure never got to finalize. Shorter and far more bounded than the
// media poll above — this is confirming a normal completion that's
// already very likely done, not watching a job that takes minutes by
// design.
const RECONCILE_POLL_INTERVAL_MS = 3_000;
const RECONCILE_POLL_MAX_ATTEMPTS = 40; // ~2 minutes

export interface LocalChatMessage extends ChatMessage {
  streaming?: boolean;
  // Attached to the specific assistant message that produced it, not kept
  // as a single session-wide "latest decision" — so each message's own
  // disclosure (MessageCortexDisclosure) still shows the right data after
  // later messages are sent, matching the reference design's per-message
  // Cortex pill instead of one panel that only ever reflects the last turn.
  cortexDecision?: CortexDecisionPayload | null;
  workflowSteps?: WorkflowStepView[] | null;
  // Absent (not []) unless a search genuinely grounded this answer — see
  // DoneEventData.citations' doc comment.
  citations?: Citation[];
  // Cortex Routing disclosure data for an ORDINARY (non-workflow) turn —
  // snapshotted from done.routing exactly like citations above. Null for
  // a workflow-completed message, which uses `cortexVersion` +
  // `workflowSteps` instead (see cortexVersion below).
  routing?: CortexRoutingInfo | null;
  // Set only for a workflow-completed message, snapshotted from the live
  // WorkflowView's own cortexVersion at the moment this message's `done`
  // event arrives — same snapshot pattern already used for workflowSteps.
  cortexVersion?: CortexVersion | null;
}

export interface WorkflowStepView {
  title: string;
  categoryLabel: string;
  status: "pending" | "running" | "completed" | "failed";
  // Only known once a step actually completes (see backend
  // workflow_step_status's own doc comment) — null/undefined while
  // pending or running.
  modelDisplayName?: string | null;
}

export interface WorkflowView {
  steps: WorkflowStepView[];
  clarificationQuestion: string | null;
  cortexVersion?: CortexVersion | null;
}

function emptyMessage(id: string, conversationId: string, role: "user" | "assistant", content: string): LocalChatMessage {
  return {
    id,
    conversationId,
    role,
    content,
    intent: null,
    complexity: null,
    createdAt: new Date().toISOString(),
  };
}

export function useChatStream(
  initialConversationId: string | undefined,
  initialMessages: ChatMessage[],
  initialProjectId?: string,
  initialWorkflow: WorkflowView | null = null,
) {
  const upsertConversation = useSidebarStore((s) => s.upsertConversation);
  const bumpCredits = useSidebarStore((s) => s.bumpCredits);

  const [conversationId, setConversationId] = useState<string | undefined>(initialConversationId);
  const [messages, setMessages] = useState<LocalChatMessage[]>(initialMessages);
  const [status, setStatus] = useState<CortexStatusStage | "idle" | "awaiting_clarification">(
    initialWorkflow?.clarificationQuestion ? "awaiting_clarification" : "idle",
  );
  const [statusLabel, setStatusLabel] = useState("");
  const [cortexDecision, setCortexDecision] = useState<CortexDecisionPayload | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowView | null>(initialWorkflow);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [researchStage, setResearchStage] = useState<ResearchStage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Plain ref, not state — read synchronously right after streamChat()
  // resolves, in the same tick that flips isStreaming off. Avoids a stale
  // closure over "status" inside the onDone handler.
  const doneAwaitingClarification = useRef(false);
  // run() is memoized via useCallback with a deps array that doesn't
  // include `workflow` — so onDone's closure over the plain `workflow`
  // variable would be stale (whatever it was when run() was last
  // reconstructed, not what accumulated via onWorkflowPlan/
  // onWorkflowStepStatus during THIS call). Kept in sync at every
  // setWorkflow call site instead, so onDone can read the true current
  // value synchronously.
  const workflowRef = useRef<WorkflowView | null>(initialWorkflow);
  function updateWorkflow(next: WorkflowView | null | ((prev: WorkflowView | null) => WorkflowView | null)) {
    setWorkflow((prev) => {
      const resolved = typeof next === "function" ? next(prev) : next;
      workflowRef.current = resolved;
      return resolved;
    });
  }

  const run = useCallback(
    async (text: string, regenerateMessageId?: string, fileIds?: string[]) => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        // Previously a bare `return`: the composer cleared, the message
        // vanished, and nothing at all appeared — indistinguishable from
        // the app being broken. Surface it as an assistant message so the
        // user learns the one thing that actually fixes it.
        setMessages((prev) => [
          ...prev,
          {
            ...emptyMessage(crypto.randomUUID(), conversationId ?? "", "assistant", ""),
            content: "Your session has expired. Please sign in again.",
          },
        ]);
        return;
      }

      setCortexDecision(null);
      updateWorkflow(null);
      setResearchStage(null);
      setIsStreaming(true);
      setStatus("understanding");
      setStatusLabel("Understanding task...");

      let userLocalId: string | undefined;
      if (regenerateMessageId) {
        setMessages((prev) => prev.filter((m) => m.id !== regenerateMessageId));
      } else {
        userLocalId = crypto.randomUUID();
        setMessages((prev) => [...prev, emptyMessage(userLocalId as string, conversationId ?? "", "user", text)]);
      }

      const assistantLocalId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { ...emptyMessage(assistantLocalId, conversationId ?? "", "assistant", ""), streaming: true },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      // try/finally, not a bare await: this is the frontend's own
      // "reservation" on the loading state — same reason the backend
      // never settles a credit reservation outside a finally (see
      // checkAndReserveCredits' own doc comment). streamChat() itself is
      // now exception-safe (see its own comment), but this is cheap
      // defense in depth against ANY future throw between here and the
      // cleanup below — including one from inside a handler callback —
      // ever again leaving isStreaming stuck true with no recovery short
      // of a reload.
      try {
      await streamChat(
        {
          conversationId,
          message: regenerateMessageId ? undefined : text,
          regenerateMessageId,
          fileIds: regenerateMessageId ? undefined : fileIds,
          // Only meaningful when this is the first message of a brand-new
          // conversation — resolveConversation ignores it otherwise.
          projectId: conversationId ? undefined : initialProjectId,
        },
        session.access_token,
        {
          onConversationCreated: ({ conversationId: newId }) => {
            setConversationId(newId);
            upsertConversation({ id: newId, projectId: "", title: text.slice(0, 60) || "New chat", createdAt: new Date().toISOString() });
            // window.history, NOT router.replace/push: a real Next.js App Router
            // navigation here would swap in a fresh server-rendered /chat/[id]
            // page — remounting this whole component mid-stream and silently
            // dropping every token event that arrives after that point, even
            // though the backend call keeps running and completes/persists
            // successfully (discovered live: the message only appeared after
            // a manual reload). Updating the URL via the History API instead
            // just relabels the address bar — no navigation, no remount, the
            // in-flight stream keeps rendering into this same component.
            window.history.replaceState(null, "", `/chat/${newId}`);
          },
          onCortexStatus: ({ stage, label }) => {
            setStatus(stage);
            setStatusLabel(label);
          },
          onCortexDecision: (decision) => {
            setCortexDecision(decision);
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantLocalId ? { ...m, cortexDecision: decision } : m)),
            );
          },
          onToken: ({ delta }) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantLocalId ? { ...m, content: m.content + delta } : m)),
            );
          },
          onError: ({ message }) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantLocalId ? { ...m, content: m.content || message, streaming: false } : m)),
            );
          },
          onDone: ({ messageId, userMessageId, awaitingClarification, pendingMediaId, citations, routing }) => {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id === assistantLocalId) {
                  // Snapshot the live workflow's steps (+ its engine
                  // version) onto this message so its own disclosure keeps
                  // showing them after the next message starts and clears
                  // the top-level `workflow` state. `routing` is the
                  // ordinary-turn equivalent, sourced straight from
                  // done.routing instead of a live-panel snapshot since
                  // there's no live single-shot routing panel to snapshot
                  // from.
                  return {
                    ...m,
                    id: messageId ?? m.id,
                    streaming: false,
                    workflowSteps: workflowRef.current?.steps ?? null,
                    cortexVersion: workflowRef.current?.cortexVersion ?? null,
                    citations,
                    routing: routing ?? null,
                  };
                }
                // Swap the user message's client-generated placeholder id
                // for its real DB id — without this, "Edit" on that message
                // calls the truncate endpoint with an id that matches
                // nothing server-side and silently no-ops.
                if (userLocalId && m.id === userLocalId) return { ...m, id: userMessageId ?? m.id };
                return m;
              }),
            );
            // Authoritative paused signal — not inferred from whether a
            // workflow_clarification event happened to arrive earlier in
            // this stream, which a page reload would lose.
            if (awaitingClarification) doneAwaitingClarification.current = true;
            // Video (the one async capability today) didn't finish within
            // this request — messageId here is that async job's
            // placeholder message; start polling it for the real result.
            if (pendingMediaId) {
              setPendingMedia((prev) => [...prev, { mediaId: pendingMediaId, messageId: messageId ?? assistantLocalId }]);
            }
          },
          onWorkflowPlan: ({ steps, cortexVersion }) => {
            updateWorkflow({
              steps: steps.map((s) => ({ title: s.title, categoryLabel: s.categoryLabel, status: "pending", modelDisplayName: null })),
              clarificationQuestion: null,
              cortexVersion,
            });
          },
          onWorkflowStepStatus: ({ stepIndex, status: stepStatus, title, modelDisplayName }) => {
            // Defense in depth: the backend always sends workflow_plan
            // before any workflow_step_status now, but silently dropping
            // a status update just because the plan hasn't arrived yet
            // (previously: `if (!prev) return prev`) is the wrong failure
            // mode — it left the panel blank for an entire resumed run
            // until this was traced back and fixed server-side. Growing
            // the array to fit is a strictly better fallback than losing
            // the update.
            updateWorkflow((prev) => {
              const steps = prev ? [...prev.steps] : [];
              while (steps.length <= stepIndex) {
                steps.push({ title, categoryLabel: "", status: "pending", modelDisplayName: null });
              }
              steps[stepIndex] = {
                ...steps[stepIndex],
                title,
                status: stepStatus,
                modelDisplayName: modelDisplayName ?? steps[stepIndex].modelDisplayName ?? null,
              };
              return { steps, clarificationQuestion: prev?.clarificationQuestion ?? null, cortexVersion: prev?.cortexVersion ?? null };
            });
            // Each completed step charges credits server-side as it
            // finishes, not just once at the very end of the workflow —
            // refresh the sidebar as each one lands rather than only after
            // the whole (possibly long) run completes.
            if (stepStatus === "completed") bumpCredits();
          },
          onWorkflowClarification: ({ question }) => {
            updateWorkflow((prev) => (prev ? { ...prev, clarificationQuestion: question } : { steps: [], clarificationQuestion: question }));
          },
          onResearchStage: ({ stage }) => {
            setResearchStage(stage);
          },
        },
        controller.signal,
      );
      } finally {
        setIsStreaming(false);
        setStatus(doneAwaitingClarification.current ? "awaiting_clarification" : "idle");
        setStatusLabel("");
        setResearchStage(null);
        doneAwaitingClarification.current = false;
        // A real credit charge just landed (or a workflow charged per step
        // along the way) — tell the usage panel to refetch now rather
        // than wait for its own timer/focus tick.
        bumpCredits();
      }
    },
    [conversationId, initialProjectId, upsertConversation, bumpCredits],
  );

  const sendMessage = useCallback((text: string, fileIds?: string[]) => run(text, undefined, fileIds), [run]);
  const regenerate = useCallback((messageId: string) => run("", messageId), [run]);
  const stop = useCallback(() => abortRef.current?.abort(), []);

  // "Check on read" polling for async media (video) — no websocket/SSE
  // channel stays open for this (the original /chat request already ended
  // once the job was submitted), so the client has to come back and ask.
  // Runs once per distinct `pendingMedia` array identity; on a genuine
  // concurrent-video restart mid-poll this restarts every in-flight poll
  // rather than resuming precisely, which is an acceptable simplification
  // given the backend hard-caps concurrent video jobs at 1 per user (see
  // MAX_CONCURRENT_VIDEO_GENERATIONS in routes/chat.ts) — in practice this
  // array almost never holds more than one entry at a time.
  useEffect(() => {
    if (pendingMedia.length === 0) return;
    let cancelled = false;

    async function pollOne(entry: PendingMedia) {
      const supabase = createClient();
      for (let attempt = 0; attempt < MEDIA_POLL_MAX_ATTEMPTS && !cancelled; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, MEDIA_POLL_INTERVAL_MS));
        if (cancelled) return;

        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          // Was a bare `return`: polling just stopped and the message sat
          // on "Generating your video..." forever, with the job actually
          // still running server-side. Say what happened instead — the
          // video isn't lost, it just needs a reload once signed back in.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === entry.messageId
                ? { ...m, content: "Your session expired while this was generating. Sign in again and reload to see the result." }
                : m,
            ),
          );
          setPendingMedia((prev) => prev.filter((p) => p.mediaId !== entry.mediaId));
          return;
        }

        const result = await fetchMediaStatus(entry.mediaId, session.access_token);
        if (cancelled || !result) continue; // transient failure — try again next tick

        if (result.status === "completed" && result.url) {
          setMessages((prev) =>
            prev.map((m) => (m.id === entry.messageId ? { ...m, content: `[Generated video](${result.url})` } : m)),
          );
          setPendingMedia((prev) => prev.filter((p) => p.mediaId !== entry.mediaId));
          bumpCredits(); // real cost was just charged server-side on completion
          return;
        }
        if (result.status === "failed") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === entry.messageId ? { ...m, content: result.errorMessage ?? "Video generation failed. Please try again." } : m,
            ),
          );
          setPendingMedia((prev) => prev.filter((p) => p.mediaId !== entry.mediaId));
          return;
        }
        // still queued/processing — loop continues
      }
    }

    pendingMedia.forEach((entry) => void pollOne(entry));

    return () => {
      cancelled = true;
    };
  }, [pendingMedia, bumpCredits]);

  // Chat rehydration (see useChatStream's own module doc + the durable-
  // persistence backend fix): initialMessages came from a fresh server
  // fetch (ConversationPage is a Server Component — every mount of this
  // hook re-runs it), so any assistant row still showing status:'streaming'
  // at THAT moment is either about to finish any second (most likely: a
  // generation that completed a beat after the fetch ran, or is still
  // genuinely in flight in another tab), or — rarely — a row a server-side
  // failure never got to finalize. Poll it directly rather than leaving
  // the bouncing-dots placeholder up with nothing ever resolving it.
  // Deliberately keyed on mount only ([] deps): a message that starts
  // streaming live in THIS tab already updates via the normal onToken/
  // onDone path above and never needs this.
  useEffect(() => {
    const pendingIds = initialMessages.filter((m) => m.role === "assistant" && m.status === "streaming").map((m) => m.id);
    if (pendingIds.length === 0) return;
    let cancelled = false;
    const supabase = createClient();

    async function pollOne(messageId: string) {
      for (let attempt = 0; attempt < RECONCILE_POLL_MAX_ATTEMPTS && !cancelled; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, RECONCILE_POLL_INTERVAL_MS));
        if (cancelled) return;

        const { data, error } = await supabase.from("messages").select("content, status").eq("id", messageId).maybeSingle();
        if (error || !data) continue; // transient failure — try again next tick
        if (data.status === "streaming") continue; // still genuinely in progress

        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: data.content as string, status: data.status, streaming: false } : m)),
        );
        return;
      }
      // Exhausted every attempt without the row ever resolving — tell the
      // user plainly rather than leaving the dots animating forever with
      // no way to know whether to wait, worry, or retry.
      if (!cancelled) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, content: "This is taking longer than expected. It may have failed without finishing — try regenerating.", status: "failed", streaming: false }
              : m,
          ),
        );
      }
    }

    pendingIds.forEach((id) => void pollOne(id));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    conversationId,
    messages,
    status,
    statusLabel,
    cortexDecision,
    workflow,
    researchStage,
    isStreaming,
    sendMessage,
    regenerate,
    stop,
  };
}
