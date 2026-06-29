/**
 * Shared numeric helpers used by the API client and the accessory mapping.
 */

/** Round a number to the nearest multiple of `step`. */
export function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Clamp a number into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
