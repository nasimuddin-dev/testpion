/** Class names joined, the falsy ones left out. */
export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}
