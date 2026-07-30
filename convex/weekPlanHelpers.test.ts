import { describe, expect, it } from "vitest";
import { getDraftWorkoutMutationBlocker } from "./weekPlanHelpers";

describe("getDraftWorkoutMutationBlocker", () => {
  it("allows a draft without scheduling state", () => {
    expect(getDraftWorkoutMutationBlocker({ status: "draft" })).toBeNull();
  });

  it("blocks a non-draft workout", () => {
    expect(getDraftWorkoutMutationBlocker({ status: "pushed" })).toBe("non_draft");
  });

  it.each([
    { label: "signup receipt", schedulingState: { tonalWorkoutSignupId: "" } },
    { label: "scheduled date", schedulingState: { tonalScheduledDate: "" } },
    {
      label: "verified receipt timestamp",
      schedulingState: { tonalSchedulingReceiptVerifiedAt: 0 },
    },
  ])("blocks a draft with a defined $label", ({ schedulingState }) => {
    expect(getDraftWorkoutMutationBlocker({ status: "draft", ...schedulingState })).toBe(
      "scheduled",
    );
  });

  it("blocks a draft with a scheduling claim", () => {
    expect(
      getDraftWorkoutMutationBlocker({
        status: "draft",
        tonalSchedulingClaim: { claimId: "claim-1" },
      }),
    ).toBe("claimed");
  });

  it("prioritizes status and persisted scheduling evidence over a claim", () => {
    expect(
      getDraftWorkoutMutationBlocker({
        status: "pushed",
        tonalWorkoutSignupId: "signup-1",
        tonalSchedulingClaim: { claimId: "claim-1" },
      }),
    ).toBe("non_draft");
    expect(
      getDraftWorkoutMutationBlocker({
        status: "draft",
        tonalScheduledDate: "2099-08-03",
        tonalSchedulingClaim: { claimId: "claim-1" },
      }),
    ).toBe("scheduled");
  });
});
