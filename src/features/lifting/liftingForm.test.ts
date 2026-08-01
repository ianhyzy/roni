import { describe, expect, it } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  buildLiftingSaveInput,
  createEmptyLiftingDraft,
  createLiftingDraftFromDetail,
  createLiftingReplaceTarget,
  type LiftingSessionDetail,
  type LiftingSessionDraft,
} from "./liftingForm";

const sessionId = "lifting-session-1" as Id<"liftingSessions">;

function createValidDraft(overrides: Partial<LiftingSessionDraft> = {}): LiftingSessionDraft {
  return {
    title: " Evening strength ",
    performedDate: "2026-07-30",
    performedTime: "21:15",
    durationMinutes: "45",
    notes: " Strong finish ",
    exercises: [
      {
        clientId: "exercise-1",
        name: " Barbell squat ",
        sets: [
          { clientId: "set-1", kind: "warmup", reps: "10", weightLbs: "45", rpe: "" },
          {
            clientId: "set-2",
            kind: "working",
            reps: "5",
            weightLbs: "185.5",
            rpe: "8.5",
          },
        ],
      },
    ],
    ...overrides,
  };
}

function createDetail(): LiftingSessionDetail {
  return {
    sessionId,
    source: "manual",
    performedAt: new Date(2026, 0, 2, 3, 4).getTime(),
    calendarDate: "2025-12-31",
    title: "New year strength",
    durationMinutes: 55,
    notes: "Felt strong",
    exerciseCount: 1,
    setCount: 1,
    totalReps: 5,
    totalVolumeLbs: 925,
    createdAt: 100,
    updatedAt: 200,
    exercises: [
      {
        exerciseId: "lifting-exercise-1" as Id<"liftingExercises">,
        order: 0,
        name: "Back squat",
        setCount: 1,
        totalReps: 5,
        totalVolumeLbs: 925,
        sets: [
          {
            setId: "lifting-set-1" as Id<"liftingSets">,
            order: 0,
            kind: "working",
            reps: 5,
            weightLbs: 185,
            rpe: 8,
          },
        ],
      },
    ],
  };
}

describe("liftingForm", () => {
  it("uses deterministic browser-local date and time defaults", () => {
    const localNow = new Date(2026, 6, 30, 23, 59, 45);

    const draft = createEmptyLiftingDraft(localNow);

    expect(draft.performedDate).toBe("2026-07-30");
    expect(draft.performedTime).toBe("23:59");
    expect(draft.exercises).toEqual([
      {
        clientId: expect.any(String),
        name: "",
        sets: [
          {
            clientId: expect.any(String),
            kind: "working",
            reps: "",
            weightLbs: "",
            rpe: "",
          },
        ],
      },
    ]);
  });

  it("keeps the persisted calendar date when initializing an edit", () => {
    const detail = createDetail();

    const draft = createLiftingDraftFromDetail(detail);

    expect(draft).toMatchObject({
      title: "New year strength",
      performedDate: "2025-12-31",
      performedTime: "03:04",
      durationMinutes: "55",
      notes: "Felt strong",
    });
    expect(draft.exercises[0]).toMatchObject({
      clientId: `exercise-${detail.exercises[0]?.exerciseId}`,
      name: "Back squat",
      sets: [
        {
          clientId: `set-${detail.exercises[0]?.sets[0]?.setId}`,
          kind: "working",
          reps: "5",
          weightLbs: "185",
          rpe: "8",
        },
      ],
    });
  });

  it("normalizes a valid create payload", () => {
    const draft = createValidDraft();

    const result = buildLiftingSaveInput(draft, { kind: "create" });

    expect(result).toEqual({
      status: "valid",
      input: {
        kind: "create",
        session: {
          performedAt: new Date(2026, 6, 30, 21, 15).getTime(),
          calendarDate: "2026-07-30",
          title: "Evening strength",
          durationMinutes: 45,
          notes: "Strong finish",
          exercises: [
            {
              name: "Barbell squat",
              sets: [
                { kind: "warmup", reps: 10, weightLbs: 45 },
                { kind: "working", reps: 5, weightLbs: 185.5, rpe: 8.5 },
              ],
            },
          ],
        },
      },
    });
  });

  it("includes the selected session ID in a replace payload", () => {
    const draft = createValidDraft();

    const result = buildLiftingSaveInput(draft, {
      kind: "replace",
      sessionId,
      originalPerformedAt: 123,
      originalPerformedDate: "2026-07-30",
      originalPerformedTime: "21:15",
    });

    expect(result).toMatchObject({
      status: "valid",
      input: { kind: "replace", sessionId },
    });
  });

  it("preserves the original timestamp when edit date and time are unchanged", () => {
    const detail = createDetail();
    const draft = createLiftingDraftFromDetail(detail);

    const result = buildLiftingSaveInput(draft, createLiftingReplaceTarget(detail));

    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("Expected a valid lifting payload");
    expect(result.input.session.performedAt).toBe(detail.performedAt);
  });

  it("recomputes a local timestamp when the displayed edit time changes", () => {
    const detail = createDetail();
    const draft = { ...createLiftingDraftFromDetail(detail), performedTime: "04:05" };

    const result = buildLiftingSaveInput(draft, createLiftingReplaceTarget(detail));

    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("Expected a valid lifting payload");
    expect(result.input.session.performedAt).toBe(new Date(2025, 11, 31, 4, 5).getTime());
  });

  it("omits blank optional session and set fields", () => {
    const draft = createValidDraft({
      durationMinutes: " ",
      notes: " ",
      exercises: [
        {
          clientId: "exercise-bodyweight",
          name: "Bodyweight squat",
          sets: [
            {
              clientId: "set-bodyweight",
              kind: "working",
              reps: "12",
              weightLbs: " ",
              rpe: "",
            },
          ],
        },
      ],
    });

    const result = buildLiftingSaveInput(draft, { kind: "create" });

    expect(result.status).toBe("valid");
    if (result.status !== "valid") throw new Error("Expected a valid lifting payload");
    expect(result.input.session).not.toHaveProperty("durationMinutes");
    expect(result.input.session).not.toHaveProperty("notes");
    expect(result.input.session.exercises[0]?.sets[0]).toEqual({
      kind: "working",
      reps: 12,
    });
  });

  it("rejects a nonexistent local calendar date", () => {
    const draft = createValidDraft({ performedDate: "2026-02-30" });

    const result = buildLiftingSaveInput(draft, { kind: "create" });

    expect(result).toEqual({
      status: "invalid",
      message: "Choose a valid performed date and time.",
    });
  });

  it.each([
    ["fractional reps", { reps: "5.5", weightLbs: "185", rpe: "8" }, "reps"],
    ["weight above the maximum", { reps: "5", weightLbs: "5000.1", rpe: "8" }, "weight"],
    ["RPE below the minimum", { reps: "5", weightLbs: "185", rpe: "0" }, "RPE"],
  ])("rejects %s", (_caseName, set, fieldName) => {
    const draft = createValidDraft({
      exercises: [
        {
          clientId: "exercise-invalid",
          name: "Back squat",
          sets: [{ clientId: "set-invalid", kind: "working", ...set }],
        },
      ],
    });

    const result = buildLiftingSaveInput(draft, { kind: "create" });

    expect(result).toMatchObject({ status: "invalid" });
    if (result.status !== "invalid") throw new Error("Expected an invalid lifting payload");
    expect(result.message).toContain(fieldName);
  });

  it("rejects sessions above the exercise-count boundary", () => {
    const exercise = {
      clientId: "exercise-boundary",
      name: "Back squat",
      sets: [
        {
          clientId: "set-boundary",
          kind: "working" as const,
          reps: "5",
          weightLbs: "185",
          rpe: "8",
        },
      ],
    };
    const draft = createValidDraft({ exercises: Array.from({ length: 21 }, () => exercise) });

    const result = buildLiftingSaveInput(draft, { kind: "create" });

    expect(result).toEqual({
      status: "invalid",
      message: "Add between 1 and 20 exercises.",
    });
  });

  it("reports the set-count boundary for the affected exercise", () => {
    const set = {
      clientId: "set-boundary",
      kind: "working" as const,
      reps: "5",
      weightLbs: "185",
      rpe: "8",
    };
    const draft = createValidDraft({
      exercises: [
        {
          clientId: "exercise-boundary",
          name: "Back squat",
          sets: Array.from({ length: 21 }, () => set),
        },
      ],
    });

    const result = buildLiftingSaveInput(draft, { kind: "create" });

    expect(result).toEqual({
      status: "invalid",
      message: "Exercise 1 must have 1 to 20 sets.",
    });
  });
});
