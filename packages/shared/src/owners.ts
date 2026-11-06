/**
 * Whether a typed team (`@payments`, `payments`, `@org/payments`) names one of an item's owners (CODEOWNERS): the whole
 * name, or its part after the slash, case-insensitive, the `@` optional. The Collections tree's `@team` filter and
 * `testpion collections --owner` read it the same way.
 */
export function ownedBy(owners: readonly string[] | undefined, team: string): boolean {
  const norm = (x: string) => x.trim().replace(/^@/, '').toLowerCase();
  const want = norm(team);
  return !!want && !!owners?.some((o) => norm(o) === want || norm(o).split('/').pop() === want);
}
