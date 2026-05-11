"use node";

// Node runtime required: ai/otel.ts loads OpenTelemetry, which needs `performance`.

import { v } from "convex/values";
import { saveMessage } from "@convex-dev/agent";
import { action, type ActionCtx, internalAction } from "./_generated/server";
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
import type { RunAccumulator } from "./ai/runTelemetry";
import { sanitizeTimezone } from "./ai/timeDecay";
import { getFallbackTier, type ModelTier, type ProviderId } from "./ai/providers";
import * as analytics from "./lib/posthog";
import {
  assertThreadOwnership,
  buildPrompt,
  persistScheduledFailure,
  resolveUserProviderConfig,
  withByokErrorSanitization,
} from "./chatHelpers";

// Dev Convex URLs look like `https://<adj>-<animal>-123.convex.cloud` and
// prod ones look the same, so we flag prod on Vercel's build env instead.
const ENVIRONMENT: "dev" | "prod" = process.env.VERCEL_ENV === "production" ? "prod" : "dev";
const RELEASE_SHA = process.env.VERCEL_GIT_COMMIT_SHA;
const TRIVIAL_PROMPT_MAX_CHARS = 30;
const COMPLEX_INTENT_KEYWORDS = ["program", "plan", "build", "swap", "push", "deload"] as const;

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
    case "trivial":
      return "router";
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

function buildTierPrepareStep(
  tierModels: Parameters<typeof createModelTierPrepareStep>[0]["tierModels"],
  initialTier: ModelTier,
  escalationMode?: "fixed-tier",
): ReturnType<typeof createModelTierPrepareStep> {
  return createModelTierPrepareStep(
    escalationMode ? { initialTier, tierModels, escalationMode } : { initialTier, tierModels },
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
    const budgetExceeded = await checkDailyBudget(ctx, userId, threadId);
    if (budgetExceeded) return;

    // Pre-save the user message once so retries use promptMessageId
    // instead of re-saving, re-embedding, and duplicating the message.
    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId,
      userId,
      message: { role: "user" as const, content: prompt },
    });

    let provider: ProviderId | undefined;
    let accumulator: RunAccumulator | undefined;
    const contextTiming: CoachContextTiming = {};
    const retrievalEnabled = shouldUseCrossThreadSearch(prompt, (imageStorageIds?.length ?? 0) > 0);
    const routingIntent = classifyPromptIntent(prompt);
    const startTime = Date.now();
    try {
      const providerConfig = await resolveUserProviderConfig(ctx, userId);
      provider = providerConfig.provider;

      const resolvedPrompt = await buildPrompt(ctx, prompt, imageStorageIds);

      const agents = buildCoachAgentsForProvider({
        ...providerConfig,
        userTimezone,
        retrievalEnabled,
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
          prepareStep: buildTierPrepareStep(agents.tierModels, route.primaryTier),
          fallbackPrepareStep: buildTierPrepareStep(
            agents.tierModels,
            route.fallbackTier,
            "fixed-tier",
          ),
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
      await persistScheduledFailure({
        ctx,
        threadId,
        userId,
        error,
        provider,
        source: "chatProcessing.processMessage",
      });
      return;
    } finally {
      if (accumulator) await persistRun(ctx, accumulator);
    }

    analytics.capture(userId, "coach_response_received", {
      response_time_ms: Date.now() - startTime,
      has_images: (imageStorageIds?.length ?? 0) > 0,
    });
    await analytics.flush();
  },
});

export const continueAfterApproval = action({
  args: {
    threadId: v.string(),
    messageId: v.string(),
    userTimezone: v.optional(v.string()),
  },
  handler: async (ctx, { threadId, messageId, userTimezone: rawTz }) => {
    const userTimezone = sanitizeTimezone(rawTz);
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) throw new Error("Not authenticated");
    await assertThreadOwnership(ctx, threadId, userId);

    let provider: ProviderId | undefined;
    let accumulator: RunAccumulator | undefined;
    const contextTiming: CoachContextTiming = {};
    const retrievalEnabled = true;
    const processingStartedAt = Date.now();
    const startTime = Date.now();
    try {
      const providerConfig = await resolveUserProviderConfig(ctx, userId);
      provider = providerConfig.provider;

      const agents = buildCoachAgentsForProvider({
        ...providerConfig,
        userTimezone,
        retrievalEnabled,
        timing: contextTiming,
      });
      const route = selectCoachTierRoute(agents, "approval_continuation");
      accumulator = await withByokErrorSanitization(() =>
        streamWithRetry(ctx, {
          primaryAgent: route.primary,
          fallbackAgent: route.fallback,
          primaryModelName: route.primaryModelName,
          prepareStep: buildTierPrepareStep(agents.tierModels, route.primaryTier),
          fallbackPrepareStep: buildTierPrepareStep(
            agents.tierModels,
            route.fallbackTier,
            "fixed-tier",
          ),
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
      await persistScheduledFailure({
        ctx,
        threadId,
        userId,
        error,
        provider,
        source: "chatProcessing.continueAfterApproval",
      });
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
