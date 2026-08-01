import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { deleteAccount } from "./account";

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type DeleteAccountHandler = (ctx: ActionCtx, args: object) => Promise<void>;

const deleteAccountHandler = (deleteAccount as unknown as { _handler: DeleteAccountHandler })
  ._handler;

function localFunctionName(ref: TestFunctionReference): string | null {
  try {
    return getFunctionName(ref);
  } catch {
    return null;
  }
}

describe("Strava account-deletion revocation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("continues local account deletion when Strava revocation throws", async () => {
    const userId = "user-1" as Id<"users">;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runAction = vi.fn(async (ref: TestFunctionReference): Promise<boolean> => {
      if (localFunctionName(ref) === "strava/disconnect:revokeForAccountDeletion") {
        throw new Error("Strava unavailable");
      }
      return true;
    });
    const runMutation = vi.fn<
      (ref: TestFunctionReference, args: Record<string, unknown>) => Promise<boolean>
    >(async () => false);
    const ctx = {
      auth: {
        getUserIdentity: vi.fn(async () => ({ subject: `${userId}|session` })),
      },
      runAction,
      runMutation,
    } as unknown as ActionCtx;

    await expect(deleteAccountHandler(ctx, {})).resolves.toBeUndefined();

    const actionNames = runAction.mock.calls.map(([ref]) => localFunctionName(ref));
    expect(actionNames).toContain("strava/disconnect:revokeForAccountDeletion");
    const mutationNames = runMutation.mock.calls.map(([ref]) => localFunctionName(ref));
    expect(mutationNames).toContain("accountDeletion:deleteUserRecord");
    expect(mutationNames).not.toContain("accountDeletion:clearDeletionInProgress");
  });
});
