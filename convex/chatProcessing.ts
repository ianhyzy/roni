"use node";

// Node runtime required: ai/otel.ts loads OpenTelemetry, which needs `performance`.

import { v } from "convex/values";
import { saveMessage } from "@convex-dev/agent";
import { type ActionCtx, internalAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import {
  buildCoachAgentsForProvider,
  type CoachContextTiming,
  createModelTierPrepareStep,
  shouldUseCrossThreadSearch,
  STATIC_INSTRUCTIONS_HASH,
} from "./ai/coach";
import { checkDailyBudget } from "./ai/budget";
import { streamWithRetry } from "./ai/resilience";
import { type AgentTurnRef, clearTurnRetrying } from "./ai/resilienceReporting";
import { STUCK_MESSAGE_WATCHDOG_DELAY_MS } from "./ai/stuckMessageWatchdog";
import type { RunAccumulator } from "./ai/runTelemetry";
import { sanitizeTimezone } from "./ai/timeDecay";
import { getFallbackTier, type ModelTier, type ProviderId } from "./ai/providers";
import { classifyCoachToolMode, type CoachToolMode } from "./ai/coachTools";
import * as analytics from "./lib/posthog";
import {
  assertThreadOwnership,
  buildPrompt,
  persistScheduledFailure,
  resolveUserProviderConfig,
  withByokErrorSanitization,
} from "./chatHelpers";
import { getWeekStartDateString } from "./weekPlanHelpers";
import { resolveRuntimeEnvironment } from "./lib/env";
import { shouldScheduleMemoryExtraction } from "./ai/memoryFactExtraction";

const ENVIRONMENT = resolveRuntimeEnvironment({
  roniEnvironment: process.env.RONI_ENVIRONMENT,
  vercelEnvironment: process.env.VERCEL_ENV,
});
const RELEASE_SHA = process.env.VERCEL_GIT_COMMIT_SHA;
const TRIVIAL_PROMPT_MAX_CHARS = 30;
const COMPLEX_INTENT_KEYWORDS = ["program", "plan", "build", "swap", "deload"] as const;

export type RoutingIntent = "trivial" | "complex" | "default";
type CoachRouteIntent = RoutingIntent | "approval_continuation";

interface CoachRoute<TAgent> {
  primary: TAgent;
  fallback: TAgent;
  primaryModelName: string;
  fallbackModelName: string | null;
  primaryTier: ModelTier;
  fallbackTier: ModelTier;
}

interface CoachTierRouteOptions<TAgent> {
  tierAgents: Record<ModelTier, TAgent>;
  tierModelNames: Record<ModelTier, string>;
  fallbackModelName: string | null;
}

export function classifyPromptIntent(prompt: string): RoutingIntent {
  const normalized = prompt.trim().toLowerCase();
  if (classifyCoachToolMode(normalized) === "weekly_programming") {
    return "complex";
  }
  if (COMPLEX_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "complex";
  }
  if (normalized.length < TRIVIAL_PROMPT_MAX_CHARS) return "trivial";
  return "default";
}

export function selectCoachTierRoute<TAgent>(
  agents: CoachTierRouteOptions<TAgent>,
  intent: CoachRouteIntent,
): CoachRoute<TAgent> {
  const primaryTier = getPrimaryTierForIntent(intent);
  if (!agents.fallbackModelName) {
    return {
      primary: agents.tierAgents[primaryTier],
      fallback: agents.tierAgents[primaryTier],
      primaryModelName: agents.tierModelNames[primaryTier],
      fallbackModelName: null,
      primaryTier,
      fallbackTier: primaryTier,
    };
  }

  const fallbackTier = getFallbackTier(primaryTier);
  return {
    primary: agents.tierAgents[primaryTier],
    fallback: agents.tierAgents[fallbackTier],
    primaryModelName: agents.tierModelNames[primaryTier],
    fallbackModelName: agents.tierModelNames[fallbackTier],
    primaryTier,
    fallbackTier,
  };
}

function getPrimaryTierForIntent(intent: CoachRouteIntent): ModelTier {
  switch (intent) {
    // Trivial prompts route to the chat tier, NOT the flash-lite router tier.
    // Short, low-keyword requests (e.g. "make me a workout") are frequently
    // actionable, and the router model does not reliably drive
    // search_exercises -> create_workout, so it silently produced no workout.
    // Keep them tool-capable on the chat tier; genuinely trivial chit-chat just
    // costs slightly more. (complex still escalates to the programming tier.)
    case "trivial":
    case "default":
      return "chat";
    case "complex":
    case "approval_continuation":
      return "programming";
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

interface TierPrepareStepOptions {
  tierModels: Parameters<typeof createModelTierPrepareStep>[0]["tierModels"];
  initialTier: ModelTier;
  toolMode: CoachToolMode;
  escalationMode?: "fixed-tier";
}

function buildTierPrepareStep({
  tierModels,
  initialTier,
  toolMode,
  escalationMode,
}: TierPrepareStepOptions): ReturnType<typeof createModelTierPrepareStep> {
  return createModelTierPrepareStep(
    escalationMode
      ? { initialTier, tierModels, escalationMode, toolMode }
      : { initialTier, tierModels, toolMode },
  );
}

// A coach turn's generating action can be killed (the Convex 600s cap, OOM, or
// a hung tool call) before it finalizes its assistant message, leaving the chat
// stuck on "generating" forever. Scheduling this durable sweep up front means it
// still runs after the action dies and fails the orphaned message.
async function scheduleStuckMessageWatchdog(ctx: ActionCtx, turnRef: AgentTurnRef): Promise<void> {
  await ctx.scheduler.runAfter(
    STUCK_MESSAGE_WATCHDOG_DELAY_MS,
    internal.ai.stuckMessageWatchdog.finalizeStuckMessagesForThread,
    turnRef,
  );
}

async function persistRun(ctx: ActionCtx, accumulator: RunAccumulator): Promise<void> {
  try {
    await ctx.runMutation(internal.aiUsage.recordRun, accumulator.toRow());
  } catch {
    // Never fail the turn on telemetry persistence error.
  }
}

async function recordRoutingIntent(
  ctx: ActionCtx,
  args: { userId: string; threadId: string; intent: RoutingIntent; agentName: string },
): Promise<void> {
  try {
    await ctx.runMutation(internal.aiUsage.recordRouting, args);
  } catch {
    // Routing telemetry should never block the user's chat turn.
  }
}

export const processMessage = internalAction({
  args: {
    threadId: v.string(),
    userId: v.id("users"),
    prompt: v.string(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    userTimezone: v.optional(v.string()),
    scheduledAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { threadId, userId, prompt, imageStorageIds, userTimezone: rawTz, scheduledAt },
  ) => {
    const processingStartedAt = Date.now();
    const userTimezone = sanitizeTimezone(rawTz);

    // Pre-save the user message once so retries use promptMessageId
    // instead of re-saving, re-embedding, and duplicating the message.
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      userId,
      message: { role: "user" as const, content: prompt },
    });
    const turnRef: AgentTurnRef = { threadId, promptMessageId: messageId };

    let provider: ProviderId | undefined;
    let accumulator: RunAccumulator | undefined;
    const contextTiming: CoachContextTiming = { searchHits: 0, searchUsed: false };
    const retrievalEnabled = shouldUseCrossThreadSearch(prompt, (imageStorageIds?.length ?? 0) > 0);
    const routingIntent = classifyPromptIntent(prompt);
    const startTime = Date.now();
    try {
      await scheduleStuckMessageWatchdog(ctx, turnRef);

      const budgetExceeded = await checkDailyBudget(
        ctx,
        userId,
        turnRef.threadId,
        turnRef.promptMessageId,
      );
      if (budgetExceeded) return;

      const hasPendingWeekDraft = await ctx.runQuery(
        internal.weekPlans.hasPendingDraftForWeekInternal,
        {
          userId,
          weekStartDate: getWeekStartDateString(new Date()),
        },
      );
      const toolMode = classifyCoachToolMode(prompt, hasPendingWeekDraft);

      const providerConfig = await resolveUserProviderConfig(ctx, userId);
      provider = providerConfig.provider;

      const resolvedPrompt = await buildPrompt(ctx, prompt, imageStorageIds);

      const agents = buildCoachAgentsForProvider({
        ...providerConfig,
        userTimezone,
        messageSearchMode: retrievalEnabled ? "cross_thread" : "thread_only",
        timing: contextTiming,
      });
      const route = selectCoachTierRoute(agents, routingIntent);
      await recordRoutingIntent(ctx, {
        userId,
        threadId,
        intent: routingIntent,
        agentName: route.primaryModelName,
      });
      accumulator = await withByokErrorSanitization(() =>
        streamWithRetry(ctx, {
          primaryAgent: route.primary,
          fallbackAgent: route.fallback,
          primaryModelName: route.primaryModelName,
          prepareStep: buildTierPrepareStep({
            tierModels: agents.tierModels,
            initialTier: route.primaryTier,
            toolMode,
          }),
          fallbackPrepareStep: buildTierPrepareStep({
            tierModels: agents.tierModels,
            initialTier: route.fallbackTier,
            toolMode,
            escalationMode: "fixed-tier",
          }),
          threadId,
          userId,
          promptMessageId: messageId,
          prompt: typeof resolvedPrompt === "string" ? undefined : resolvedPrompt,
          isByok: !providerConfig.isHouseKey,
          provider: providerConfig.provider,
          source: "chat",
          environment: ENVIRONMENT,
          release: RELEASE_SHA,
          promptVersion: STATIC_INSTRUCTIONS_HASH,
          hasImages: (imageStorageIds?.length ?? 0) > 0,
          scheduledAt,
          processingStartedAt,
          retrievalEnabled,
        }),
      );
      accumulator.setContextTiming(contextTiming);
    } catch (error) {
      try {
        await persistScheduledFailure({
          ctx,
          ...turnRef,
          userId,
          error,
          provider,
          source: "chatProcessing.processMessage",
        });
      } finally {
        await clearTurnRetrying(ctx, turnRef);
      }
      return;
    } finally {
      if (accumulator) await persistRun(ctx, accumulator);
    }
    const coachTurnSucceeded =
      accumulator !== undefined && accumulator.toRow().terminalErrorClass === undefined;
    if (coachTurnSucceeded && shouldScheduleMemoryExtraction(prompt)) {
      try {
        await ctx.scheduler.runAfter(0, internal.ai.memoryFactExtraction.extractFromTurn, {
          userId,
          threadId,
          promptMessageId: messageId,
        });
      } catch {
        console.warn("[memoryFactExtraction] scheduling_failed");
      }
    }

    analytics.capture(userId, "coach_response_received", {
      response_time_ms: Date.now() - startTime,
      has_images: (imageStorageIds?.length ?? 0) > 0,
    });
    await analytics.flush();
  },
});

export const continueAfterApproval = internalAction({
  args: {
    threadId: v.string(),
    messageId: v.string(),
    userId: v.id("users"),
    userTimezone: v.optional(v.string()),
    toolMode: v.optional(v.union(v.literal("all"), v.literal("weekly_programming"))),
  },
  handler: async (ctx, { threadId, messageId, userId, userTimezone: rawTz, toolMode = "all" }) => {
    const userTimezone = sanitizeTimezone(rawTz);
    await assertThreadOwnership(ctx, threadId, userId);

    let provider: ProviderId | undefined;
    let accumulator: RunAccumulator | undefined;
    const contextTiming: CoachContextTiming = {};
    const retrievalEnabled = false;
    const processingStartedAt = Date.now();
    const startTime = Date.now();
    try {
      await scheduleStuckMessageWatchdog(ctx, { threadId, promptMessageId: messageId });

      const providerConfig = await resolveUserProviderConfig(ctx, userId);
      provider = providerConfig.provider;

      const agents = buildCoachAgentsForProvider({
        ...providerConfig,
        userTimezone,
        messageSearchMode: "disabled",
        timing: contextTiming,
      });
      const route = selectCoachTierRoute(agents, "approval_continuation");
      accumulator = await withByokErrorSanitization(() =>
        streamWithRetry(ctx, {
          primaryAgent: route.primary,
          fallbackAgent: route.fallback,
          primaryModelName: route.primaryModelName,
          prepareStep: buildTierPrepareStep({
            tierModels: agents.tierModels,
            initialTier: route.primaryTier,
            toolMode,
          }),
          fallbackPrepareStep: buildTierPrepareStep({
            tierModels: agents.tierModels,
            initialTier: route.fallbackTier,
            toolMode,
            escalationMode: "fixed-tier",
          }),
          threadId,
          userId,
          promptMessageId: messageId,
          isByok: !providerConfig.isHouseKey,
          provider: providerConfig.provider,
          source: "approval_continuation",
          environment: ENVIRONMENT,
          release: RELEASE_SHA,
          promptVersion: STATIC_INSTRUCTIONS_HASH,
          processingStartedAt,
          retrievalEnabled,
        }),
      );
      accumulator.setContextTiming(contextTiming);
    } catch (error) {
      try {
        await persistScheduledFailure({
          ctx,
          threadId,
          promptMessageId: messageId,
          userId,
          error,
          provider,
          source: "chatProcessing.continueAfterApproval",
        });
      } finally {
        await clearTurnRetrying(ctx, { threadId, promptMessageId: messageId });
      }
      return;
    } finally {
      if (accumulator) await persistRun(ctx, accumulator);
    }

    analytics.capture(userId, "coach_response_received", {
      response_time_ms: Date.now() - startTime,
      after_approval: true,
    });
    await analytics.flush();
  },
});
