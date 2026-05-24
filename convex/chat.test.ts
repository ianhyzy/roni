/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Mock @convex-dev/agent to avoid component dependencies in unit tests.
// These mocks are only reached when the user IS authenticated; the
// unauthenticated path returns before any agent call.
vi.mock("@convex-dev/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent")>()),
  listUIMessages: vi.fn(async () => ({ page: [], isDone: true, continueCursor: "" })),
  syncStreams: vi.fn(async () => []),
  createThread: vi.fn(async () => "mock-thread-id"),
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
