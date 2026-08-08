/// <reference types="vite/client" />
import { createThread, fetchContextWithPrompt, saveMessages } from "@convex-dev/agent";
import agentTest from "@convex-dev/agent/test";
import { convexTest } from "convex-test";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { components } from "../_generated/api";
import schema from "../schema";
import { buildCoachAgentsForProvider, makeCoachAgentConfig } from "./coach";
import { buildCoachTools } from "./coachTools";

const modules = import.meta.glob("../**/*.*s");

/**
 * The AI SDK re-derives approvals from history on the continuation turn: it
 * only collects them when the LAST message is a `tool` message, it throws if a
 * response has no matching request (or the request has no tool-call), and
 * @convex-dev/agent's autoDenyUnresolvedApprovals converts any *unresolved*
 * request into `approved: false` — which is persisted as an execution-denied
 * result and rendered as a red "Denied" badge on a push the user approved.
 *
 * These tests pin the shape our contextHandler hands the SDK.
 */

type ContextParts = { role: string; types: string[] | "text" };

function summarize(messages: ModelMessage[]): ContextParts[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      types: Array.isArray(message.content)
        ? (message.content as { type: string }[]).map((part) => part.type)
        : ("text" as const),
    }));
}

async function buildThread() {
  const t = convexTest(schema, modules);
  agentTest.register(t);
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  const threadId = await t.run((ctx) => createThread(ctx, components.agent, { userId }));

  const { messages: promptMessages } = await t.run((ctx) =>
    saveMessages(ctx, components.agent, {
      threadId,
      userId,
      messages: [{ role: "user", content: "looks good push it" }],
      metadata: [{ status: "success" }],
    }),
  );

  await t.run((ctx) =>
    saveMessages(ctx, components.agent, {
      threadId,
      userId,
      promptMessageId: promptMessages[0]._id,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "approve-week-1",
              toolName: "approve_week_plan",
              input: {},
            },
            {
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "approve-week-1",
            },
          ],
        },
      ],
      metadata: [{ status: "success" }],
    }),
  );

  return { t, userId, threadId, promptMessageId: promptMessages[0]._id };
}

async function fetchContext(
  t: Awaited<ReturnType<typeof buildThread>>["t"],
  args: { userId: string; threadId: string; promptMessageId?: string; prompt?: string },
): Promise<ModelMessage[]> {
  const config = makeCoachAgentConfig({ messageSearchMode: "disabled" });
  const actionCtx = {
    runQuery: t.query,
    runMutation: t.mutation,
    runAction: t.action,
  } as Parameters<typeof fetchContextWithPrompt>[0];

  const result = await fetchContextWithPrompt(actionCtx, components.agent, {
    userId: args.userId,
    threadId: args.threadId,
    prompt: args.prompt,
    messages: undefined,
    promptMessageId: args.promptMessageId,
    agentName: "approval-continuation-test",
    contextOptions: config.contextOptions,
    contextHandler: config.contextHandler,
    usageHandler: undefined,
    callSettings: {},
  });
  return result.messages;
}

describe("approval continuation context", () => {
  it("ends with the approved response so the SDK executes the tool instead of denying it", async () => {
    const { t, userId, threadId } = await buildThread();
    const { tierAgents } = buildCoachAgentsForProvider({
      provider: "gemini",
      apiKey: "test-key",
      messageSearchMode: "disabled",
    });
    const { messageId: approvalMessageId } = await t.run((ctx) =>
      tierAgents.programming.approveToolCall(ctx, { threadId, approvalId: "approval-1" }),
    );

    const messages = await fetchContext(t, {
      userId,
      threadId,
      promptMessageId: approvalMessageId,
    });

    expect(summarize(messages)).toEqual([
      { role: "user", types: "text" },
      { role: "assistant", types: ["tool-call", "tool-approval-request"] },
      { role: "tool", types: ["tool-approval-response"] },
    ]);

    // collectToolApprovals bails unless the last message is a tool message.
    // Bracket access (not .at(-1)) to stay under Convex's tsc lib target,
    // which is ES2021 — .at() there fails the deploy typecheck.
    const last = messages[messages.length - 1];
    expect(last.role).toBe("tool");
    expect(last.content).toEqual([
      expect.objectContaining({ approvalId: "approval-1", approved: true }),
    ]);
  });

  it("drops the approval request with its tool-call when a new prompt abandons it", async () => {
    const { t, userId, threadId } = await buildThread();

    const messages = await fetchContext(t, {
      userId,
      threadId,
      prompt: "wait is there warm ups for any of these?",
    });

    // An approval-request surviving without its tool-call is what makes
    // autoDenyUnresolvedApprovals manufacture a denial on the next turn.
    const partTypes = summarize(messages).flatMap((entry) =>
      entry.types === "text" ? [] : entry.types,
    );
    expect(partTypes).not.toContain("tool-approval-request");
    expect(partTypes).not.toContain("tool-call");
    expect(messages[messages.length - 1]?.role).toBe("user");
  });

  it("does not auto-deny an approval when its tool result already exists without a response", async () => {
    const { t, userId, threadId, promptMessageId } = await buildThread();
    await t.run((ctx) =>
      saveMessages(ctx, components.agent, {
        threadId,
        userId,
        promptMessageId,
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "approve-week-1",
                toolName: "approve_week_plan",
                output: { type: "text", value: "pushed" },
              },
            ],
          },
        ],
        metadata: [{ status: "success" }],
      }),
    );

    const messages = await fetchContext(t, {
      userId,
      threadId,
      prompt: "what happened with that push?",
    });

    expect(summarize(messages)).toEqual([
      { role: "user", types: "text" },
      { role: "assistant", types: ["tool-call"] },
      { role: "tool", types: ["tool-result"] },
      { role: "user", types: "text" },
    ]);
  });
});

describe("approve_week_plan approval metadata", () => {
  it("still needs approval on the continuation turn", async () => {
    // validateApprovedToolApprovals flips an approved call to denied when the
    // tool is missing from the tool set or needsApproval re-resolves falsy.
    const tools = buildCoachTools("America/New_York");
    const approveTool = tools.approve_week_plan as unknown as {
      needsApproval?: (input: unknown, options: unknown) => boolean | Promise<boolean>;
    };

    expect(typeof approveTool.needsApproval).toBe("function");
    const needsApproval = await approveTool.needsApproval!.call(
      approveTool,
      {},
      { toolCallId: "x", messages: [] },
    );
    expect(needsApproval).toBe(true);
  });
});
