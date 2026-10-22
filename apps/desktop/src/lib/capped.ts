/** `list` with `add` at the end, the oldest dropped past `max` entries (the kept entries keep their identity: rows keyed by them stay mounted). */
export function appendCapped<T>(list: T[], add: T[], max: number): T[] {
  const next = list.length + add.length > max ? [...list.slice(Math.max(0, list.length + add.length - max)), ...add] : [...list, ...add];
  return next.length > max ? next.slice(-max) : next;
}
