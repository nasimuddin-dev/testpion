/** `{{name}}` placeholders, as every editor, lint and the engine read them. */

/** A fresh global regex each time (a shared one keeps lastIndex between callers). */
export const templateRegex = () => /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Whether a value holds a placeholder. */
export const hasTemplate = (v: string) => /\{\{\s*[^{}]+\s*\}\}/.test(v);

/** The variable names a text refers to, each once ($dynamic ones left out, "a.b" counted as "a"). */
export function templateVariables(input: string): string[] {
  const out = new Set<string>();
  for (const m of input.matchAll(templateRegex())) {
    const name = m[1]!.trim();
    if (!name.startsWith('$')) out.add(name.split('.')[0]!);
  }
  return [...out];
}
