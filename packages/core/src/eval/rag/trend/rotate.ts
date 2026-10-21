/**
 * The rotating sample of a nightly monitor: which `n` of `total` dataset records are scored on a given day. The window moves by
 * `n` every UTC day over a fixed shuffle of the dataset, so a month of nightly runs covers the dataset (about total / n days
 * for a full pass), consecutive days differ, and the same day always picks the same records: a night's run can be reproduced
 * from its date alone.
 */

/** Days since 1970-01-01 (UTC) of an ISO date or time. */
export function utcDay(date: string | Date): number {
  const t = typeof date === 'string' ? Date.parse(date.length === 10 ? `${date}T00:00:00Z` : date) : date.getTime();
  return Math.floor(t / 86_400_000);
}

const mix = (a: number, b: number) => {
  let h = (a ^ 0x9e3779b9) + Math.imul(b, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
};

/** The same order for the same `total`: records are not shuffled by the day, only the window over them moves. */
function order(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i).sort((x, y) => mix(x, total) - mix(y, total) || x - y);
}

/** The indexes (into the dataset's records) scored on `day`, in dataset order. */
export function rotatingIndexes(total: number, n: number, day: number): number[] {
  if (total <= 0 || n <= 0) return [];
  if (n >= total) return Array.from({ length: total }, (_, i) => i);
  const ord = order(total);
  const start = (((day % total) * (n % total)) % total + total) % total;
  const picked = Array.from({ length: n }, (_, k) => ord[(start + k) % total]!);
  return picked.sort((a, b) => a - b);
}
