import { z } from "zod";

const stravaActivityResponseSchema = z.object({
  id: z.number().int().nonnegative().safe(),
  athlete: z.object({
    id: z.number().int().nonnegative().safe(),
  }),
  name: z.string(),
  type: z.string(),
  sport_type: z.string(),
  start_date: z.string().datetime({ offset: true }),
  start_date_local: z.string().datetime({ offset: true }),
  timezone: z.string(),
  distance: z.number().nonnegative(),
  moving_time: z.number().int().nonnegative(),
  elapsed_time: z.number().int().nonnegative(),
  total_elevation_gain: z.number().nonnegative(),
  achievement_count: z.number().int().nonnegative(),
  trainer: z.boolean(),
  commute: z.boolean(),
  manual: z.boolean(),
  private: z.boolean(),
});

const stravaActivityListResponseSchema = z.array(stravaActivityResponseSchema);

export interface StravaActivitySummary {
  providerActivityId: string;
  athleteId: string;
  type: string;
  sportType: string;
  name: string;
  startDate: string;
  startDateLocal: string;
  timezone: string;
  distanceMeters: number;
  movingTimeSeconds: number;
  elapsedTimeSeconds: number;
  elevationGainMeters: number;
  achievementCount: number;
  trainer: boolean;
  commute: boolean;
  manual: boolean;
  private: false;
}

function projectPublicActivity(
  activity: z.infer<typeof stravaActivityResponseSchema>,
): StravaActivitySummary | null {
  if (activity.private) return null;
  return {
    providerActivityId: String(activity.id),
    athleteId: String(activity.athlete.id),
    type: activity.type,
    sportType: activity.sport_type,
    name: activity.name,
    startDate: activity.start_date,
    startDateLocal: activity.start_date_local,
    timezone: activity.timezone,
    distanceMeters: activity.distance,
    movingTimeSeconds: activity.moving_time,
    elapsedTimeSeconds: activity.elapsed_time,
    elevationGainMeters: activity.total_elevation_gain,
    achievementCount: activity.achievement_count,
    trainer: activity.trainer,
    commute: activity.commute,
    manual: activity.manual,
    private: false,
  };
}

/** Parse one Strava summary/detail response and discard Only You activities. */
export function parsePublicStravaActivity(raw: unknown): StravaActivitySummary | null {
  return projectPublicActivity(stravaActivityResponseSchema.parse(raw));
}

/** Parse a bounded Strava list response and discard Only You activities. */
export function parsePublicStravaActivityList(raw: unknown): StravaActivitySummary[] {
  return stravaActivityListResponseSchema.parse(raw).flatMap((activity) => {
    const projected = projectPublicActivity(activity);
    return projected ? [projected] : [];
  });
}
