import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalQuery } from "./_generated/server";

const EXPORT_PAGE_SIZE = 500;

const sessionDocumentValidator = v.object({
  _id: v.id("liftingSessions"),
  _creationTime: v.number(),
  userId: v.id("users"),
  source: v.literal("manual"),
  performedAt: v.number(),
  calendarDate: v.string(),
  title: v.string(),
  durationMinutes: v.optional(v.number()),
  notes: v.optional(v.string()),
  exerciseCount: v.number(),
  setCount: v.number(),
  totalReps: v.number(),
  totalVolumeLbs: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const exerciseDocumentValidator = v.object({
  _id: v.id("liftingExercises"),
  _creationTime: v.number(),
  userId: v.id("users"),
  sessionId: v.id("liftingSessions"),
  order: v.number(),
  name: v.string(),
  setCount: v.number(),
  totalReps: v.number(),
  totalVolumeLbs: v.number(),
});

const setDocumentValidator = v.object({
  _id: v.id("liftingSets"),
  _creationTime: v.number(),
  userId: v.id("users"),
  sessionId: v.id("liftingSessions"),
  exerciseId: v.id("liftingExercises"),
  exerciseOrder: v.number(),
  order: v.number(),
  kind: v.union(v.literal("warmup"), v.literal("working")),
  reps: v.number(),
  weightLbs: v.optional(v.number()),
  rpe: v.optional(v.number()),
});

export const listSessionPage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(sessionDocumentValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { userId, cursor }) => {
    const result = await ctx.db
      .query("liftingSessions")
      .withIndex("by_userId_and_performedAt", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE });
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const listExercisePage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(exerciseDocumentValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { userId, cursor }) => {
    const result = await ctx.db
      .query("liftingExercises")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE });
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const listSetPage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(setDocumentValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { userId, cursor }) => {
    const result = await ctx.db
      .query("liftingSets")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE });
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export interface LiftingSetExportRow {
  readonly order: number;
  readonly kind: "warmup" | "working";
  readonly reps: number;
  readonly weightLbs: number | null;
  readonly rpe: number | null;
}

export interface LiftingExerciseExportRow {
  readonly name: string;
  readonly order: number;
  readonly setCount: number;
  readonly totalReps: number;
  readonly totalVolumeLbs: number;
  readonly sets: readonly LiftingSetExportRow[];
}

export interface LiftingSessionExportRow {
  readonly source: "manual";
  readonly performedAt: number;
  readonly calendarDate: string;
  readonly title: string;
  readonly durationMinutes: number | null;
  readonly notes: string | null;
  readonly exerciseCount: number;
  readonly setCount: number;
  readonly totalReps: number;
  readonly totalVolumeLbs: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly exercises: readonly LiftingExerciseExportRow[];
}

export interface LiftingExportData {
  readonly liftingSessions: readonly LiftingSessionExportRow[];
}

interface ExportPage<T> {
  readonly page: readonly T[];
  readonly isDone: boolean;
  readonly continueCursor: string;
}

async function collectPages<T>(
  readPage: (cursor: string | null) => Promise<ExportPage<T>>,
): Promise<readonly T[]> {
  const rows: T[] = [];
  const seenCursors = new Set<string | null>([null]);
  let cursor: string | null = null;

  while (true) {
    const result = await readPage(cursor);
    rows.push(...result.page);
    if (result.isDone) return rows;
    if (seenCursors.has(result.continueCursor)) {
      throw new Error("Lifting export pagination cursor did not advance");
    }
    cursor = result.continueCursor;
    seenCursors.add(cursor);
  }
}

export async function collectLiftingExportData(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<LiftingExportData> {
  const [sessions, exercises, sets] = await Promise.all([
    collectPages((cursor) =>
      ctx.runQuery(internal.liftingExport.listSessionPage, { userId, cursor }),
    ),
    collectPages((cursor) =>
      ctx.runQuery(internal.liftingExport.listExercisePage, { userId, cursor }),
    ),
    collectPages((cursor) => ctx.runQuery(internal.liftingExport.listSetPage, { userId, cursor })),
  ]);

  const setsByExercise = new Map<Id<"liftingExercises">, Doc<"liftingSets">[]>();
  for (const set of sets) {
    const exerciseSets = setsByExercise.get(set.exerciseId) ?? [];
    exerciseSets.push(set);
    setsByExercise.set(set.exerciseId, exerciseSets);
  }

  const exercisesBySession = new Map<Id<"liftingSessions">, Doc<"liftingExercises">[]>();
  for (const exercise of exercises) {
    const sessionExercises = exercisesBySession.get(exercise.sessionId) ?? [];
    sessionExercises.push(exercise);
    exercisesBySession.set(exercise.sessionId, sessionExercises);
  }

  return {
    liftingSessions: [...sessions]
      .sort((a, b) => a.performedAt - b.performedAt)
      .map((session) => ({
        source: session.source,
        performedAt: session.performedAt,
        calendarDate: session.calendarDate,
        title: session.title,
        durationMinutes: session.durationMinutes ?? null,
        notes: session.notes ?? null,
        exerciseCount: session.exerciseCount,
        setCount: session.setCount,
        totalReps: session.totalReps,
        totalVolumeLbs: session.totalVolumeLbs,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        exercises: (exercisesBySession.get(session._id) ?? [])
          .sort((a, b) => a.order - b.order)
          .map((exercise) => ({
            name: exercise.name,
            order: exercise.order,
            setCount: exercise.setCount,
            totalReps: exercise.totalReps,
            totalVolumeLbs: exercise.totalVolumeLbs,
            sets: (setsByExercise.get(exercise._id) ?? [])
              .sort((a, b) => a.order - b.order)
              .map((set) => ({
                order: set.order,
                kind: set.kind,
                reps: set.reps,
                weightLbs: set.weightLbs ?? null,
                rpe: set.rpe ?? null,
              })),
          })),
      })),
  };
}
