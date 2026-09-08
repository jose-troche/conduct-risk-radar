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
 * z-score with a floor on the standard deviation. A cell whose baseline is
 * perfectly flat has stddev 0, which would send every deviation to infinity;
 * Poisson counts give sqrt(mean) as a defensible minimum spread.
 */
export function zScore(value: number, mean: number, stddev: number): number {
  const floor = Math.max(Math.sqrt(Math.max(mean, 0)), 0.5);
  return (value - mean) / Math.max(stddev, floor);
}

export function pct(n: number, places = 1): string {
  return `${(n * 100).toFixed(places)}%`;
}
