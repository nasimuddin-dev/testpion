/**
 * @mentions in a comment for your team: `@Ana`, `@ana.lee` or `@org/payments` (a team of CODEOWNERS). A person is named
 * as git knows them: a name without its spaces, its first word, or the part of the e-mail before the @. An e-mail
 * address in the text is not a mention.
 */

/** An @mention after a space or the start: letters of any script, digits, `_ . -`, and `/` for a team (`@org/payments`). Group 2 is the name. */
export const MENTION = /(^|[\s(,;:])@([\p{L}\p{N}][\p{L}\p{N}_.-]*(?:\/[\p{L}\p{N}_.-]+)?)/gu;

/** The names mentioned in a text, in order, each once (as written, without the @). */
export function mentionsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const name = m[2]!.replace(/[.-]+$/, '');
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** Whether one of the mentions names this person (their git name or e-mail). */
export function mentionsPerson(mentions: readonly string[], who: { name?: string; email?: string }): boolean {
  const mine = new Set<string>();
  if (who.name?.trim()) {
    mine.add(norm(who.name));
    mine.add(norm(who.name.trim().split(/\s+/)[0]!));
    mine.add(norm(who.name).replace(/[^\w]/g, ''));
  }
  if (who.email?.includes('@')) {
    const local = who.email.split('@')[0]!.toLowerCase();
    // a GitHub no-reply address: 12345+login@users.noreply.github.com names the login
    mine.add(local.replace(/^\d+\+/, ''));
    mine.add(local);
  }
  return mentions.some((m) => mine.has(norm(m)));
}
