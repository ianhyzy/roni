"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useUIMessages } from "@convex-dev/agent/react";
import { toUIMessages, vMessageDoc } from "@convex-dev/agent";
import type { UIMessage } from "@convex-dev/agent/react";
import { parse } from "convex-helpers/validators";
import { api } from "../../../convex/_generated/api";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { ThinkingIndicator } from "./ThinkingIndicator";
import {
  deriveCoachTurnState,
  getApprovalContinuationKey,
  MAX_ACTIVE_TURN_AGE_MS,
} from "./chatTurnState";
import { ChevronDown, ChevronUp } from "lucide-react";

type ChatThreadProps = { userInitial?: string; threadId: string };
type PendingSubmission = { afterOrder: number; message: UIMessage };
type ApprovalObservation = { key: string; startedAt: number };

function makePendingMessage(text: string): UIMessage {
  const createdAt = Date.now();
  return {
    key: `pending-${createdAt}`,
    _creationTime: createdAt,
    order: Number.MAX_SAFE_INTEGER,
    stepOrder: 0,
    status: "pending",
    role: "user",
    text,
    parts: [{ type: "text", text }],
  } as UIMessage;
}

export function ChatThread({ userInitial, threadId }: ChatThreadProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const {
    results: currentMessages,
    status,
    loadMore,
  } = useUIMessages(api.chat.listMessages, { threadId }, { initialNumItems: 20, stream: true });

  const [historicalMessages, setHistoricalMessages] = useState<UIMessage[]>([]);
  const [pendingSubmission, setPendingSubmission] = useState<PendingSubmission | null>(null);
  const history = useQuery(api.threads.listConversationHistory, {
    beforeThreadId: threadId,
  });

  const handleLoadEarlier = () => {
    if (!history || history.messages.length === 0) return;
    try {
      const validated = history.messages.map((m) => parse(vMessageDoc, m));
      const converted = toUIMessages(validated);
      setHistoricalMessages((prev) => [...converted, ...prev]);
    } catch (e) {
      console.error("Failed to parse historical messages:", e);
    }
  };

  const serverMessages = [...historicalMessages, ...(currentMessages ?? [])];
  const pendingMessage = pendingSubmission?.message ?? null;
  const serverHasPending = pendingSubmission
    ? (currentMessages ?? []).some(
        (message) =>
          message.role === "user" &&
          message.text === pendingSubmission.message.text &&
          message.order > pendingSubmission.afterOrder,
      )
    : false;

  useEffect(() => {
    if (!serverHasPending) return;
    const timer = window.setTimeout(() => setPendingSubmission(null), 0);
    return () => window.clearTimeout(timer);
  }, [serverHasPending]);

  const allMessages =
    pendingMessage && !serverHasPending ? [...serverMessages, pendingMessage] : serverMessages;
  const visiblePendingMessage = pendingMessage && !serverHasPending ? pendingMessage : null;
  const [now, setNow] = useState(() => Date.now());
  const approvalContinuationKey = getApprovalContinuationKey(currentMessages ?? []);
  const [approvalObservation, setApprovalObservation] = useState<ApprovalObservation | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setApprovalObservation((current) => {
        if (!approvalContinuationKey) return null;
        if (current?.key === approvalContinuationKey) return current;
        return { key: approvalContinuationKey, startedAt: Date.now() };
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [approvalContinuationKey]);
  const approvalContinuationStartedAt =
    approvalObservation?.key === approvalContinuationKey ? approvalObservation.startedAt : null;
  const turnState = deriveCoachTurnState({
    messages: currentMessages ?? [],
    pendingMessage: visiblePendingMessage,
    now,
    approvalContinuationStartedAt,
  });
  const isTurnActive =
    turnState.status === "submitting" ||
    turnState.status === "working" ||
    turnState.status === "awaiting-approval" ||
    turnState.status === "retrying";
  const showThinking =
    (turnState.status === "working" || turnState.status === "retrying") &&
    turnState.activity === "preparing";
  const stateRefreshAt =
    turnState.status === "submitting" ||
    turnState.status === "working" ||
    turnState.status === "retrying"
      ? turnState.startedAt + MAX_ACTIVE_TURN_AGE_MS
      : null;

  useEffect(() => {
    if (stateRefreshAt === null) return;
    const delay = Math.max(0, stateRefreshAt - Date.now() + 1);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [stateRefreshAt]);

  const [showScrollButton, setShowScrollButton] = useState(false);
  const NEAR_BOTTOM_THRESHOLD = 150;

  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => setShowScrollButton(!isNearBottom());
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [isNearBottom]);

  const hasMountScrolled = useRef(false);
  useEffect(() => {
    if (hasMountScrolled.current || !currentMessages?.length) return;
    hasMountScrolled.current = true;
    scrollToBottom("instant");
  }, [currentMessages, scrollToBottom]);

  const serverMessageCount = serverMessages.length;
  useEffect(() => {
    if (isNearBottom()) scrollToBottom("smooth");
  }, [serverMessageCount, isTurnActive, showThinking, isNearBottom, scrollToBottom]);

  const handleSend = (text: string) => {
    setPendingSubmission({
      afterOrder: currentMessages?.at(-1)?.order ?? -1,
      message: makePendingMessage(text),
    });
    scrollToBottom("smooth");
  };

  const canLoadMoreHistory = history?.hasMore && historicalMessages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollContainerRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl">
          {status === "CanLoadMore" && (
            <div className="flex justify-center py-3">
              <button
                onClick={() => loadMore(20)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              >
                <ChevronUp className="size-3" />
                Load earlier messages
              </button>
            </div>
          )}
          {status !== "CanLoadMore" && canLoadMoreHistory && (
            <div className="flex justify-center py-3">
              <button
                onClick={handleLoadEarlier}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
              >
                <ChevronUp className="size-3" />
                Load earlier conversations
              </button>
            </div>
          )}
          <div role="log" aria-live="polite" aria-label="Chat messages">
            <MessageList messages={allMessages} userInitial={userInitial} threadId={threadId} />
          </div>
          {turnState.status === "submitting" && (
            <p role="status" className="px-4 pt-2 text-xs text-muted-foreground sm:px-6">
              Sending message...
            </p>
          )}
          {showThinking && <ThinkingIndicator startedAt={turnState.startedAt} />}
          {turnState.status === "failed" && turnState.reason === "expired" && (
            <div
              role="alert"
              className="mx-4 mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive sm:mx-6"
            >
              Roni&apos;s response did not finish. You can send another message.
            </div>
          )}
          <div className="h-4" />
        </div>
      </div>
      <div className="relative shrink-0 border-t border-border/50 p-3 sm:p-4">
        {showScrollButton && (
          <button
            onClick={() => scrollToBottom("smooth")}
            aria-label="Scroll to latest messages"
            className="absolute -top-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-md transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className="size-3" />
            Latest
          </button>
        )}
        <ChatInput
          threadId={threadId}
          disabled={isTurnActive}
          onSend={handleSend}
          onSendError={() => setPendingSubmission(null)}
        />
      </div>
    </div>
  );
}
