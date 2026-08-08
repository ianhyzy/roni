"use client";

import type { UIMessage } from "@convex-dev/agent/react";
import { useSmoothText } from "@convex-dev/agent/react";
import { getToolName, isToolUIPart } from "ai";
import { AlertTriangle, Sparkles } from "lucide-react";
import Image from "next/image";
import { MarkdownContent } from "./MarkdownContent";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { ToolCallIndicator } from "./ToolCallIndicator";
import { WeekPlanCard } from "./WeekPlanCard";
import { hasRetryLease } from "./chatTurnState";
import { isWeekPlanCardToolName } from "./weekPlanCardData";
import { type WeekPlanPresentation, weekPlanPresentationSchema } from "../../../convex/ai/schemas";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

const WEEK_PLAN_PATTERNS = [
  // The canonical ```week-plan fence tag, preferred.
  /```week-plan\s*\n([\s\S]*?)\n```/,
  // AI sometimes uses ```json instead — validated against the schema below.
  /```json\s*\n([\s\S]*?)\n```/,
  // Last resort: raw JSON with no fence, identified by its distinctive keys.
  /(\{[\s\S]*"weekStartDate"[\s\S]*"days"[\s\S]*\})\s*$/,
] as const;

interface ExtractedWeekPlan {
  readonly plan: WeekPlanPresentation;
  /** The exact span consumed, so the caller strips only this and nothing else. */
  readonly matchedText: string;
}

function extractWeekPlan(text: string): ExtractedWeekPlan | null {
  for (const pattern of WEEK_PLAN_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    try {
      return {
        plan: weekPlanPresentationSchema.parse(JSON.parse(match[1])),
        matchedText: match[0],
      };
    } catch {
      // Matched the shape but not a week plan — don't try a looser pattern.
      return null;
    }
  }
  return null;
}

function SmoothAssistantText({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [smoothText] = useSmoothText(text, {
    charsPerSec: 60,
    startStreaming: isStreaming,
  });

  const displayText = isStreaming ? smoothText + "\u258D" : text;
  return <MarkdownContent content={displayText} />;
}

interface ChatMessageProps {
  message: UIMessage;
  userInitial?: string;
  /** Whether the previous message was from the same role (enables grouping) */
  isGrouped?: boolean;
  threadId: string;
}

export function ChatMessage({ message, isGrouped, threadId }: ChatMessageProps) {
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const hasResponseText = message.text.trim().length > 0;
  const isRetrying = hasRetryLease(message);

  // User messages: right-aligned bubble
  if (isUser) {
    const imageParts = message.parts.filter(
      (part): part is Extract<typeof part, { type: "file" }> =>
        part.type === "file" && (!part.mediaType || part.mediaType.startsWith("image/")),
    );
    const textParts = message.parts.filter((part) => part.type === "text");

    return (
      <div
        className={`group relative flex justify-end px-4 sm:px-6 ${isGrouped ? "pt-1" : "pt-3"} pb-1`}
      >
        <div className="max-w-[80%]">
          {!isGrouped && (
            <div className="mb-1 flex items-center justify-end gap-2">
              <span className="text-xs text-muted-foreground">
                {formatTime(message._creationTime)}
              </span>
            </div>
          )}
          {imageParts.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
              {imageParts.map((part, i) => (
                <Image
                  key={`img-${i}`}
                  src={part.url}
                  alt={part.filename ?? `Attached image ${i + 1}`}
                  width={384}
                  height={384}
                  unoptimized
                  className="h-auto max-h-48 w-auto max-w-full rounded-xl border border-border object-contain"
                  loading="lazy"
                />
              ))}
            </div>
          )}
          <div className="rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5">
            {textParts.map((part, i) =>
              part.type === "text" ? (
                <p
                  key={i}
                  className="whitespace-pre-wrap text-sm leading-relaxed text-primary-foreground"
                >
                  {part.text}
                </p>
              ) : null,
            )}
          </div>
        </div>
      </div>
    );
  }

  // Coach messages: left-aligned with avatar
  return (
    <div className={`group relative px-4 sm:px-6 ${isGrouped ? "pt-1" : "pt-4"} pb-1`}>
      {!isGrouped && (
        <div className="mb-1.5 flex items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[oklch(0.6_0.22_300)]">
            <Sparkles className="size-3 text-white" />
          </div>
          <span className="text-[13px] font-semibold text-foreground">Roni</span>
          <span className="text-xs text-muted-foreground">{formatTime(message._creationTime)}</span>
        </div>
      )}

      <div className="sm:pl-8">
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            const text = part.text;
            if (!text && !isStreaming) return null;

            // Coach: check for structured week plan
            const extracted = extractWeekPlan(text);
            if (extracted && !isStreaming) {
              const remainingText = text.replace(extracted.matchedText, "").trim();
              return (
                <div key={i}>
                  <WeekPlanCard plan={extracted.plan} />
                  {remainingText && <MarkdownContent content={remainingText} />}
                </div>
              );
            }

            // Coach: render with smooth streaming
            return <SmoothAssistantText key={i} text={text} isStreaming={isStreaming} />;
          }

          if (isToolUIPart(part) && part.state === "approval-requested" && part.approval) {
            return (
              <ToolApprovalCard
                key={`approval-${part.toolCallId}`}
                toolName={getToolName(part)}
                input={part.input}
                approvalId={part.approval.id}
                threadId={threadId}
              />
            );
          }

          if (
            isToolUIPart(part) &&
            (part.state === "approval-responded" || part.state === "output-denied") &&
            part.approval
          ) {
            const approved = part.approval.approved;
            return (
              <span
                key={`approval-response-${part.toolCallId}`}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
                  approved
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {approved ? "\u2713 Approved" : "\u2717 Denied"}
              </span>
            );
          }

          return null;
        })}
        {message.status === "failed" && !isRetrying && (
          <div
            role="alert"
            className={`flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive ${hasResponseText ? "mt-2" : ""}`}
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {hasResponseText
                ? "Roni's response was interrupted before it finished."
                : "Roni couldn't finish this response. Please try again."}
            </span>
          </div>
        )}

        {/* Tool calls. Week-plan cards are full-width blocks, so they render
            above the chip row instead of wrapping as flex items inside it. */}
        {(() => {
          const toolParts = message.parts.filter(isToolUIPart);
          if (toolParts.length === 0) return null;

          const cardParts = toolParts.filter((part) => isWeekPlanCardToolName(getToolName(part)));
          const chipParts = toolParts.filter((part) => !isWeekPlanCardToolName(getToolName(part)));

          const renderIndicator = (part: (typeof toolParts)[number]) => (
            <ToolCallIndicator
              key={part.toolCallId}
              toolName={getToolName(part)}
              state={part.state}
              output={"output" in part ? part.output : undefined}
            />
          );

          return (
            <>
              {cardParts.map(renderIndicator)}
              {chipParts.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {chipParts.map(renderIndicator)}
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Hover timestamp for grouped messages */}
      {isGrouped && (
        <span className="pointer-events-none absolute left-1 top-1/2 hidden -translate-y-1/2 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 sm:block">
          {formatTime(message._creationTime)}
        </span>
      )}
    </div>
  );
}
