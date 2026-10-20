// js-yaml ships no types and only two members are used (util/lazy-yaml.ts: the fast reader of big import files).
declare module 'js-yaml' {
  export const CORE_SCHEMA: unknown;
  export function load(text: string, options?: { schema?: unknown }): unknown;
}
