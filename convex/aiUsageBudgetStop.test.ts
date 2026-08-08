/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

test("records a budget stop as model-attempt telemetry", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));

  await t.mutation(internal.aiUsage.recordBudgetStop, {
    userId,
    threadId: "thread-1",
    provider: "openai",
    model: "gpt-5.6-terra",
  });

  const rows = await t.run((ctx) => ctx.db.query("aiUsage").collect());
  expect(rows).toEqual([
    expect.objectContaining({
      stoppedByBudget: true,
      budgetScope: "model_attempt",
    }),
  ]);
});
