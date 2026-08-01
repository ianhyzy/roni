import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

type RecoveryCheckInExportRow = Omit<Doc<"recoveryCheckIns">, "_id" | "_creationTime" | "userId">;

export interface RecoveryExportData {
  recoveryCheckIns: RecoveryCheckInExportRow[];
}

export async function collectRecoveryExportData(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<RecoveryExportData> {
  const rows = await ctx.db
    .query("recoveryCheckIns")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
  return {
    recoveryCheckIns: rows.map((row) => ({
      calendarDate: row.calendarDate,
      energy: row.energy,
      soreness: row.soreness,
      stress: row.stress,
      ...(row.notes !== undefined ? { notes: row.notes } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  };
}
