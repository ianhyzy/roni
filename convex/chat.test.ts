/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const listMessagesMock = vi.hoisted(() =>
  vi.fn(async (): Promise<{ page: unknown[]; isDone: boolean; continueCursor: string }> => ({
    page: [],
    isDone: true,
    continueCursor: "",
  })),
);

// Mock @convex-dev/agent to avoid component dependencies in unit tests.
// These mocks are only reached when the user IS authenticated; the
// unauthenticated path returns before any agent call.
vi.mock("@convex-dev/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent")>()),
  listMessages: listMessagesMock,
  syncStreams: vi.fn(async () => []),
  createThread: vi.fn(async () => "mock-thread-id"),
}));

vi.mock("./chatHelpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatHelpers")>()),
  assertThreadOwnership: vi.fn(async () => undefined),
}));

vi.mock("./rateLimits", () => ({
  rateLimiter: { limit: vi.fn(async () => ({ ok: true, retryAfter: undefined })) },
}));

const modules = import.meta.glob("./**/*.*s");

describe("listMessages (unauthenticated)", () => {
  test("returns empty page instead of throwing when not authenticated", async () => {
    // Sentry TONALCOACH-2D: the query was throwing "Not authenticated" during the
    // brief window between component mount and Convex auth token establishment.
    // It should return an empty result so the subscription recovers silently once
    // the auth token arrives.
    const t = convexTest(schema, modules);

    // Call without wrapping in withIdentity — no auth token → userId is null.
    const result = await t.query(api.chat.listMessages, {
      threadId: "some-thread-id",
      paginationOpts: { cursor: null, numItems: 20 },
      // streamArgs is optional (v.optional); omit it to simulate the default call.
    });

    expect(result).toMatchObject({
      page: [],
      isDone: true,
      continueCursor: "",
    });
    expect(result.streams).toBeUndefined();
  });
});

describe("listMessages retry metadata", () => {
  test("exposes the durable retry lease in the same message subscription", async () => {
    const retryPage = {
      page: [
        {
          _id: "prompt-1",
          _creationTime: 1_000,
          threadId: "thread-1",
          userId: "user-1",
          order: 0,
          stepOrder: 0,
          status: "success",
          error: "transient_retry",
          message: { role: "user", content: "Hello" },
        },
        {
          _id: "failed-1",
          _creationTime: 2_000,
          threadId: "thread-1",
          userId: "user-1",
          order: 0,
          stepOrder: 1,
          status: "failed",
          error: "transient_retry",
          message: { role: "assistant", content: [] },
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    listMessagesMock.mockResolvedValueOnce(retryPage).mockResolvedValueOnce({
      page: [retryPage.page[0]],
      isDone: true,
      continueCursor: "",
    });
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const authed = t.withIdentity({ subject: `${userId}|session` });

    const result = await authed.query(api.chat.listMessages, {
      threadId: "thread-1",
      paginationOpts: { cursor: null, numItems: 20 },
    });

    expect(result.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          metadata: expect.objectContaining({ roniTurn: { phase: "retrying" } }),
        }),
      ]),
    );
  });

  test("finds a prompt lease beyond the visible message page", async () => {
    listMessagesMock
      .mockResolvedValueOnce({
        page: [
          {
            _id: "latest-assistant",
            _creationTime: 2_000,
            threadId: "thread-1",
            userId: "user-1",
            order: 0,
            stepOrder: 60,
            status: "success",
            message: { role: "assistant", content: "Still working" },
          },
        ],
        isDone: true,
        continueCursor: "",
      })
      .mockResolvedValueOnce({
        page: Array.from({ length: 50 }, (_, index) => ({
          _id: `tool-step-${index}`,
          order: 0,
          stepOrder: 60 - index,
          status: "success",
        })),
        isDone: false,
        continueCursor: "retry-scan-2",
      })
      .mockResolvedValueOnce({
        page: [
          {
            _id: "prompt-1",
            order: 0,
            stepOrder: 0,
            status: "success",
            error: "transient_retry",
          },
        ],
        isDone: true,
        continueCursor: "",
      });
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const authed = t.withIdentity({ subject: `${userId}|session` });

    const result = await authed.query(api.chat.listMessages, {
      threadId: "thread-1",
      paginationOpts: { cursor: null, numItems: 20 },
    });

    expect(result.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          metadata: { roniTurn: { phase: "retrying" } },
        }),
      ]),
    );
    expect(listMessagesMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        paginationOpts: { cursor: "retry-scan-2", numItems: 50 },
        statuses: ["success"],
      }),
    );
  });

  test("does not keep a superseded failed attempt active after terminal cleanup", async () => {
    const rawPage = {
      page: [
        {
          _id: "prompt-1",
          _creationTime: 1_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 0,
          status: "success",
          error: "retry_finished",
          message: { role: "user", content: "Hello" },
        },
        {
          _id: "failed-attempt",
          _creationTime: 2_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 1,
          status: "failed",
          error: "transient_retry",
          message: { role: "assistant", content: "Partial answer" },
        },
        {
          _id: "successful-attempt",
          _creationTime: 3_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 2,
          status: "success",
          message: { role: "assistant", content: "Complete answer" },
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    listMessagesMock.mockResolvedValueOnce(rawPage).mockResolvedValueOnce({
      page: [rawPage.page[2], rawPage.page[0]],
      isDone: true,
      continueCursor: "",
    });
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const authed = t.withIdentity({ subject: `${userId}|session` });

    const result = await authed.query(api.chat.listMessages, {
      threadId: "thread-1",
      paginationOpts: { cursor: null, numItems: 20 },
    });

    expect(result.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", text: "Complete answer" }),
      ]),
    );
    expect(result.page).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
    );
    expect(result.page).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ roniTurn: expect.anything() }),
        }),
      ]),
    );
  });

  test("omits a grouped tool attempt that failed transiently before a successful retry", async () => {
    const rawPage = {
      page: [
        {
          _id: "prompt-1",
          _creationTime: 1_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 0,
          status: "success",
          error: "retry_finished",
          message: { role: "user", content: "Build a workout" },
        },
        {
          _id: "tool-call",
          _creationTime: 2_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 1,
          status: "success",
          tool: true,
          message: {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "call-1", toolName: "search", input: {} }],
          },
        },
        {
          _id: "tool-result",
          _creationTime: 3_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 2,
          status: "success",
          tool: true,
          message: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "search",
                output: { type: "json", value: { exercises: [] } },
              },
            ],
          },
        },
        {
          _id: "failed-attempt",
          _creationTime: 4_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 3,
          status: "failed",
          error: "transient_retry",
          tool: false,
          message: { role: "assistant", content: "Partial answer" },
        },
        {
          _id: "successful-attempt",
          _creationTime: 5_000,
          threadId: "thread-1",
          order: 0,
          stepOrder: 4,
          status: "success",
          tool: false,
          message: { role: "assistant", content: "Complete answer" },
        },
      ],
      isDone: true,
      continueCursor: "",
    };
    listMessagesMock.mockResolvedValueOnce(rawPage).mockResolvedValueOnce({
      page: rawPage.page.filter((message) => message.status === "success"),
      isDone: true,
      continueCursor: "",
    });
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const authed = t.withIdentity({ subject: `${userId}|session` });

    const result = await authed.query(api.chat.listMessages, {
      threadId: "thread-1",
      paginationOpts: { cursor: null, numItems: 20 },
    });

    expect(result.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", text: "Complete answer" }),
      ]),
    );
    expect(result.page).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
    );
    expect(JSON.stringify(result.page)).not.toContain("Partial answer");
  });
});
