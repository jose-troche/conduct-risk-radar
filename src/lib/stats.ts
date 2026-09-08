/** Clamp a raw signal value onto 0–100 against a saturation point. */
export function normalise(raw: number, saturation: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(100, (raw / saturation) * 100);
}

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * How far a window's mean daily rate sits from its baseline mean daily rate,
 * in standard errors.
 *
 * The denominator is the standard error of a mean over `n` days, not the daily
 * standard deviation. Dividing a 14-day average by the day-to-day spread
 * understates the deviation by a factor of sqrt(14) - which is what an earlier
 * version of this function did, and it flattened every real spike in the data
 * to a z-score below 1.
 *
 * The standard deviation is floored before that: a cell whose baseline is
 * perfectly flat has stddev 0, which would send every deviation to infinity.
 * Poisson counts give sqrt(mean) as a defensible minimum spread.
 */
export function zScore(
  value: number,
  mean: number,
  stddev: number,
  windowDays = 1,
): number {
  const floor = Math.max(Math.sqrt(Math.max(mean, 0)), 0.5);
  const standardError = Math.max(stddev, floor) / Math.sqrt(Math.max(windowDays, 1));
  return (value - mean) / standardError;
}

export function pct(n: number, places = 1): string {
  return `${(n * 100).toFixed(places)}%`;
}
