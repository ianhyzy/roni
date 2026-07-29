import type { ActionCtx } from "../_generated/server";
import { buildTrainingSnapshotWithMetadata } from "./context";

export type TrainingSnapshotSource = "live_rebuild";

export interface TrainingSnapshotResult {
  snapshot: string;
  source: TrainingSnapshotSource;
  snapshotBuildMs: number;
  memoryFactsInjected: number;
}

type SnapshotCtx = Pick<ActionCtx, "runQuery">;

export async function getTrainingSnapshotForChat(
  ctx: SnapshotCtx,
  userId: string,
  userTimezone?: string,
): Promise<TrainingSnapshotResult> {
  const startedAt = Date.now();
  const result = await buildTrainingSnapshotWithMetadata(ctx, userId, userTimezone);
  return {
    snapshot: result.snapshot,
    source: "live_rebuild",
    snapshotBuildMs: Date.now() - startedAt,
    memoryFactsInjected: result.memoryFactsInjected,
  };
}
