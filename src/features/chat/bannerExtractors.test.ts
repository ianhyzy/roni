import { describe, expect, it } from "vitest";
import { extractBannerProps } from "./bannerExtractors";

describe("extractBannerProps", () => {
  describe("approve_week_plan", () => {
    it("returns success when all workouts pushed", () => {
      const output = { success: true, pushed: 5, failed: 0, skipped: 2, results: [] };
      expect(extractBannerProps("approve_week_plan", output)).toEqual({
        variant: "success",
        message: "5 workouts pushed to Tonal",
      });
    });

    it("returns error when some workouts failed", () => {
      const output = { success: false, pushed: 3, failed: 2, skipped: 0, results: [] };
      expect(extractBannerProps("approve_week_plan", output)).toEqual({
        variant: "error",
        message: "3 pushed, 2 failed",
      });
    });

    it("returns error with message when output has error field", () => {
      const output = { error: "No week plan found. Use program_week first." };
      expect(extractBannerProps("approve_week_plan", output)).toEqual({
        variant: "error",
        message: "No week plan found. Use program_week first.",
      });
    });

    it("returns null for unexpected output shape", () => {
      expect(extractBannerProps("approve_week_plan", "string")).toBeNull();
      expect(extractBannerProps("approve_week_plan", null)).toBeNull();
      expect(extractBannerProps("approve_week_plan", { unrelated: true })).toBeNull();
      expect(extractBannerProps("approve_week_plan", { pushed: 4, failed: 0 })).toBeNull();
    });

    it("never reports success when the explicit success sentinel is false", () => {
      expect(
        extractBannerProps("approve_week_plan", { success: false, pushed: 4, failed: 0 }),
      ).toEqual({
        variant: "error",
        message: "Failed to push workouts to Tonal",
      });
    });
  });

  describe("create_workout", () => {
    it("returns success for successful creation", () => {
      const output = { success: true, workoutId: "w1", title: "Upper Body" };
      expect(extractBannerProps("create_workout", output)).toEqual({
        variant: "success",
        message: "Workout created",
      });
    });

    it("returns error for failed creation", () => {
      const output = { success: false, error: "Invalid movement IDs" };
      expect(extractBannerProps("create_workout", output)).toEqual({
        variant: "error",
        message: "Failed to create workout",
      });
    });
  });

  describe("delete_workout", () => {
    it("returns success when deleted", () => {
      const output = { deleted: true };
      expect(extractBannerProps("delete_workout", output)).toEqual({
        variant: "success",
        message: "Workout deleted",
      });
    });

    it("returns null for unexpected shape", () => {
      expect(extractBannerProps("delete_workout", {})).toBeNull();
    });
  });

  describe("delete_week_plan", () => {
    it("returns success when deleted", () => {
      const output = { deleted: true };
      expect(extractBannerProps("delete_week_plan", output)).toEqual({
        variant: "success",
        message: "Week plan deleted",
      });
    });

    it("returns error when not deleted", () => {
      const output = { deleted: false, message: "No week plan found for the current week." };
      expect(extractBannerProps("delete_week_plan", output)).toEqual({
        variant: "error",
        message: "Failed to delete week plan",
      });
    });
  });

  describe("swap_exercise", () => {
    it("returns success", () => {
      const output = { success: true, message: "Swapped Bench Press for Incline Press" };
      expect(extractBannerProps("swap_exercise", output)).toEqual({
        variant: "success",
        message: "Exercise swapped",
      });
    });

    it("returns error", () => {
      const output = { success: false, error: "No workout linked to Monday." };
      expect(extractBannerProps("swap_exercise", output)).toEqual({
        variant: "error",
        message: "Failed to swap exercise",
      });
    });
  });

  describe("move_session", () => {
    it("returns success", () => {
      const output = { success: true, message: "Moved Push from Monday to Wednesday" };
      expect(extractBannerProps("move_session", output)).toEqual({
        variant: "success",
        message: "Session moved",
      });
    });

    it("returns error", () => {
      const output = { success: false, error: "Source and destination days are the same." };
      expect(extractBannerProps("move_session", output)).toEqual({
        variant: "error",
        message: "Failed to move session",
      });
    });
  });

  describe("adjust_session_duration", () => {
    it("returns success", () => {
      const output = { success: true, message: "Adjusted Monday to 30 minutes" };
      expect(extractBannerProps("adjust_session_duration", output)).toEqual({
        variant: "success",
        message: "Session adjusted",
      });
    });

    it("returns error", () => {
      const output = { success: false, error: "Monday is a rest day." };
      expect(extractBannerProps("adjust_session_duration", output)).toEqual({
        variant: "error",
        message: "Failed to adjust session",
      });
    });
  });

  it.each([
    {
      toolName: "add_exercise",
      sentinel: "success",
      successMessage: "Exercise added",
      errorMessage: "Failed to add exercise",
    },
    {
      toolName: "set_warmup_block",
      sentinel: "success",
      successMessage: "Warmup updated",
      errorMessage: "Failed to update warmup",
    },
    {
      toolName: "rebuild_day",
      sentinel: "success",
      successMessage: "Workout rebuilt",
      errorMessage: "Failed to rebuild workout",
    },
    {
      toolName: "record_feedback",
      sentinel: "recorded",
      successMessage: "Feedback recorded",
      errorMessage: "Failed to record feedback",
    },
    {
      toolName: "report_injury",
      sentinel: "recorded",
      successMessage: "Injury recorded",
      errorMessage: "Failed to record injury",
    },
    {
      toolName: "start_training_block",
      sentinel: "started",
      successMessage: "Training block started",
      errorMessage: "Failed to start training block",
    },
    {
      toolName: "advance_training_block",
      sentinel: "advanced",
      successMessage: "Training block advanced",
      errorMessage: "Failed to advance training block",
    },
    {
      toolName: "set_goal",
      sentinel: "created",
      successMessage: "Goal created",
      errorMessage: "Failed to create goal",
    },
    {
      toolName: "update_goal_progress",
      sentinel: "updated",
      successMessage: "Goal progress updated",
      errorMessage: "Failed to update goal progress",
    },
    {
      toolName: "resolve_injury",
      sentinel: "resolved",
      successMessage: "Injury resolved",
      errorMessage: "Failed to resolve injury",
    },
  ])(
    "$toolName requires the exact $sentinel boolean sentinel",
    ({ toolName, sentinel, successMessage, errorMessage }) => {
      expect(extractBannerProps(toolName, { [sentinel]: true })).toEqual({
        variant: "success",
        message: successMessage,
      });
      expect(extractBannerProps(toolName, { [sentinel]: false })).toEqual({
        variant: "error",
        message: errorMessage,
      });
      expect(extractBannerProps(toolName, { [sentinel]: "true" })).toBeNull();
      expect(extractBannerProps(toolName, { ok: true })).toBeNull();
    },
  );

  describe("unknown tools", () => {
    it("returns null for read-only tools", () => {
      expect(extractBannerProps("search_exercises", { results: [] })).toBeNull();
    });

    it("returns null for unknown tool names", () => {
      expect(extractBannerProps("made_up_tool", {})).toBeNull();
    });
  });
});
