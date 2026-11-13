/**
 * Typed variables: a variable of an environment, a collection or the workspace may say what its value is — a number, a
 * boolean, JSON — instead of plain text. The value is still kept as text in the file (git diffs stay readable, an older
 * version reads it as before); the type adds two things: a value that does not fit is reported before a run
 * (the editor, Problems, `testpion attention`), and a script gets the real value (`tp.environment.get('port')` is the
 * number 8080, not the text "8080"). In `{{port}}` a typed value is written the way JSON writes it.
 */
export type VariableType = 'string' | 'number' | 'boolean' | 'json';

/** Every type, in the order the editor lists them; a variable with no type is text. */
export const VARIABLE_TYPES: ReadonlyArray<{ id: VariableType; label: string }> = [
  { id: 'string', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'boolean', label: 'Boolean' },
  { id: 'json', label: 'JSON' },
];

export const isVariableType = (v: unknown): v is VariableType => v === 'string' || v === 'number' || v === 'boolean' || v === 'json';

/** A value that is only a `{{reference}}` (or has one in it) gets its type when it is resolved: it cannot be checked as text. */
const hasReference = (value: string) => /\{\{[^{}]+\}\}/.test(value);

/**
 * Why a value does not fit its type, in words; undefined when it fits. An empty value fits (the variable has no value
 * yet: a secret typed elsewhere, a value a script sets), and so does one with a {{reference}} in it.
 */
export function variableTypeProblem(type: VariableType | undefined, value: string): string | undefined {
  if (!type || type === 'string' || value === '' || hasReference(value)) return undefined;
  const text = value.trim();
  if (type === 'number') return text !== '' && Number.isFinite(Number(text)) ? undefined : `not a number: ${short(value)}`;
  if (type === 'boolean') return /^(true|false)$/i.test(text) ? undefined : `not true or false: ${short(value)}`;
  try {
    JSON.parse(text);
    return undefined;
  } catch (e) {
    return `not valid JSON (${e instanceof Error ? e.message.replace(/\s+in JSON.*$/, '') : 'it cannot be read'})`;
  }
}

const short = (s: string) => (s.length > 40 ? `"${s.slice(0, 40)}…"` : `"${s}"`);

/**
 * The value a typed variable has for scripts and for `{{name}}`: the number, the boolean or the parsed JSON. A value
 * that does not fit, has a reference in it or is empty stays the text it is (the problem is reported, the run goes on
 * as it would have without a type).
 */
export function typedVariableValue(type: VariableType | undefined, value: unknown): unknown {
  if (typeof value !== 'string' || !type || type === 'string' || value === '' || hasReference(value) || variableTypeProblem(type, value)) return value;
  const text = value.trim();
  if (type === 'number') return Number(text);
  if (type === 'boolean') return text.toLowerCase() === 'true';
  return JSON.parse(text) as unknown;
}
