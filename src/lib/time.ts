/** All dates in this system are YYYY-MM-DD strings in UTC. */

export const DAY_MS = 86_400_000;

export function toDay(d: Date | string): string {
  if (typeof d === "string") return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return toDay(new Date());
}

export function addDays(day: string, delta: number): string {
  return toDay(new Date(Date.parse(day + "T00:00:00Z") + delta * DAY_MS));
}

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS,
  );
}

/** Inclusive-start, exclusive-end list of days. */
export function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}
