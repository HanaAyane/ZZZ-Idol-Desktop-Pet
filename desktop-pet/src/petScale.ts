export const PET_SCALE_MIN_PERCENT = 20;
export const PET_SCALE_MAX_PERCENT = 125;
export const PET_SCALE_STEP_PERCENT = 5;

export const PET_SCALE_MIN = PET_SCALE_MIN_PERCENT / 100;
export const PET_SCALE_MAX = PET_SCALE_MAX_PERCENT / 100;

export function clampPetScale(scale: number): number {
  return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, scale));
}

export function normalizePetScale(scale: number): number {
  return Math.round(clampPetScale(scale) * 100) / 100;
}

export function isPetScaleInRange(scale: number): boolean {
  return Number.isFinite(scale) && scale >= PET_SCALE_MIN && scale <= PET_SCALE_MAX;
}
