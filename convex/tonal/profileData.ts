import type { TonalUser } from "./types";

interface ExistingProfileMeasurements {
  heightInches?: number;
  weightPounds?: number;
  workoutsPerWeek?: number;
}

interface ToUserProfileDataOptions {
  existingProfileData?: ExistingProfileMeasurements | null;
}

function resolveProfileMeasurement(
  tonalValue: number | null | undefined,
  existingValue: number | undefined,
): number {
  return tonalValue ?? existingValue ?? 0;
}

export function toUserProfileData(profile: TonalUser, options: ToUserProfileDataOptions = {}) {
  const existingProfileData = options.existingProfileData;

  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    heightInches: resolveProfileMeasurement(
      profile.heightInches,
      existingProfileData?.heightInches,
    ),
    weightPounds: resolveProfileMeasurement(
      profile.weightPounds,
      existingProfileData?.weightPounds,
    ),
    gender: profile.gender ?? undefined,
    level: profile.tonalStatus ?? "",
    workoutsPerWeek: resolveProfileMeasurement(
      profile.workoutsPerWeek,
      existingProfileData?.workoutsPerWeek,
    ),
    workoutDurationMin: profile.workoutDurationMin ?? 0,
    workoutDurationMax: profile.workoutDurationMax ?? 0,
    dateOfBirth: profile.dateOfBirth || undefined,
    username: profile.username || undefined,
    tonalCreatedAt: profile.createdAt || undefined,
  };
}
