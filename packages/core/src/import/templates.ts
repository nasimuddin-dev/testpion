/**
 * Variable syntax of other API clients, as TestPion's `{{name}}`: Insomnia's `{{ _.baseUrl }}`, `{{ _['a-b'] }}` and
 * `{{ baseUrl }}`, Hoppscotch's `<<baseUrl>>` and Bruno's `{{process.env.X}}` (the collection's .env file, imported as
 * the "Bruno .env" environment). Insomnia's `{% … %}` template tags are mapped separately (insomnia-tags.ts).
 */
export function normalizeTemplate(s: unknown): string {
  return String(s ?? '')
    .replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}')
    .replace(/\{\{\s*_\[\s*(['"])([^'"\]]+)\1\s*\]\s*\}\}/g, '{{$2}}')
    .replace(/\{\{\s*process\.env\.([\w.-]+)\s*\}\}/g, '{{$1}}')
    .replace(/\{\{\s+([\w.$-]+)\s*\}\}|\{\{([\w.$-]+)\s+\}\}/g, (_, a, b) => `{{${a ?? b}}}`)
    .replace(/<<([\w.-]+)>>/g, '{{$1}}');
}
