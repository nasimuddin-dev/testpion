/** The entries of a list as texts (none when it is not a list), at most `max` of them. */
export function stringList(v: unknown, max?: number): string[] {
  if (!Array.isArray(v)) return [];
  const list = v.map(String);
  return max === undefined ? list : list.slice(0, max);
}

/** A Map that keeps at most `max` entries: when a new key makes it bigger, the oldest entry (first inserted) goes. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }

  override set(key: K, value: V): this {
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value!);
    return this;
  }
}
