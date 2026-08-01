import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const RECENT_LIFTING_SESSIONS_LIMIT = 10;
const LIFTING_EXERCISES_PER_SESSION_LIMIT = 20;

export interface LiftingExerciseSummary {
  readonly name: string;
  readonly setCount: number;
  readonly totalReps: number;
  readonly totalVolumeLbs: number;
}

export interface LiftingSessionSnapshot {
  readonly performedAt: number;
  readonly calendarDate: string;
  readonly title: string;
  readonly durationMinutes?: number;
  readonly exerciseCount: number;
  readonly setCount: number;
  readonly totalReps: number;
  readonly totalVolumeLbs: number;
  readonly exercises: ReadonlyArray<LiftingExerciseSummary>;
}

export async function readRecentLiftingSessions(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<LiftingSessionSnapshot[]> {
  const sessions = await ctx.db
    .query("liftingSessions")
    .withIndex("by_userId_and_performedAt", (q) => q.eq("userId", userId))
    .order("desc")
    .take(RECENT_LIFTING_SESSIONS_LIMIT);

  return Promise.all(
    sessions.map(async (session) => {
      const exercises = await ctx.db
        .query("liftingExercises")
        .withIndex("by_sessionId_and_order", (q) => q.eq("sessionId", session._id))
        .order("asc")
        .take(LIFTING_EXERCISES_PER_SESSION_LIMIT);
      return {
        performedAt: session.performedAt,
        calendarDate: session.calendarDate,
        title: session.title,
        durationMinutes: session.durationMinutes,
        exerciseCount: session.exerciseCount,
        setCount: session.setCount,
        totalReps: session.totalReps,
        totalVolumeLbs: session.totalVolumeLbs,
        exercises: exercises.map((exercise) => ({
          name: exercise.name,
          setCount: exercise.setCount,
          totalReps: exercise.totalReps,
          totalVolumeLbs: exercise.totalVolumeLbs,
        })),
      };
    }),
  );
}
