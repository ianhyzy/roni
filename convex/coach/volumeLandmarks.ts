export const VOLUME_LANDMARKS = {
  Chest: { min: 10, max: 20 },
  Back: { min: 10, max: 20 },
  Shoulders: { min: 8, max: 16 },
  Biceps: { min: 8, max: 14 },
  Triceps: { min: 8, max: 14 },
  Quads: { min: 10, max: 20 },
  Glutes: { min: 8, max: 16 },
  Hamstrings: { min: 8, max: 16 },
  Calves: { min: 8, max: 16 },
} as const;

export type TrackedMuscleGroup = keyof typeof VOLUME_LANDMARKS;
