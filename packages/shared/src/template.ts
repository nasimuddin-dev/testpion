/** `{{name}}` placeholders, as every editor, lint and the engine read them. */

/** A fresh global regex each time (a shared one keeps lastIndex between callers). */
export const templateRegex = () => /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Whether a value holds a placeholder. */
export const hasTemplate = (v: string) => /\{\{\s*[^{}]+\s*\}\}/.test(v);

/**
 * Handlebars syntax inside braces (a visualizer template's `{{#each items}}`, `{{/each}}`, `{{else}}`, `{{^}}`,
 * `{{> partial}}`, `{{! comment}}`): never a variable, wherever it is found.
 */
export const isTemplateBlock = (inner: string) => /^\s*(?:[#/^>!]|else(?:\s|$))/.test(inner);

/** The variable names a text refers to, each once ($dynamic ones and Handlebars blocks left out, "a.b" counted as "a"). */
export function templateVariables(input: string): string[] {
  const out = new Set<string>();
  for (const m of input.matchAll(templateRegex())) {
    const name = m[1]!.trim();
    if (!name.startsWith('$') && !isTemplateBlock(name)) out.add(name.split('.')[0]!);
  }
  return [...out];
}

/** The keys of a request, folder, collection or test step that hold scripts: run, not templated (`{{x}}` there is not a use of x). */
export const SCRIPT_KEYS: ReadonlySet<string> = new Set(['preRequestScript', 'testScript', 'script']);

/**
 * The keys whose text is not templated when a request is sent: its scripts (and the visualizer templates inside them)
 * and its documentation. Everything else (URL, params, headers, body, auth, path variables, assertions) may hold
 * {{variable}} references.
 */
export const UNTEMPLATED_KEYS: ReadonlySet<string> = new Set([...SCRIPT_KEYS, 'description']);

/**
 * The one definition of "the text of a request that holds its {{variables}}", for the environment switcher's badge,
 * the Info panel (`itemInfo`), `vars.inspect` and the variable-usage scanner: the value as JSON without its scripts
 * and descriptions.
 */
export function templatedText(value: unknown): string {
  return JSON.stringify(value, (k, v) => (UNTEMPLATED_KEYS.has(k) ? undefined : v)) ?? '';
}

/** The scripts of a request, folder or collection (its own keys only, not those of the items inside). */
export function scriptsOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return [...SCRIPT_KEYS].map((k) => (value as Record<string, unknown>)[k]).filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** Names a request's own scripts set (`tp.environment.set('token', …)`, `tp.variables.set("x", …)`): defined by the time it is sent. */
export function namesSetByScripts(text: string): Set<string> {
  return new Set([...text.matchAll(/\.set\(\s*\\?['"`]([\w.$-]+)\\?['"`]/g)].map((m) => m[1]!));
}
