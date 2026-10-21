/**
 * Local `$ref`s and JSON pointers in OpenAPI / AsyncAPI / JSON Schema documents, and the JSON type of a schema.
 * Shared by the outline, lint, diff, fuzz, contract and import code so every reader resolves references the same way.
 */
type Json = Record<string, any>;

/** The value a JSON pointer (`#/components/schemas/Pet` or `/components/schemas/Pet`) points at; undefined when a step is missing. */
export function jsonPointerGet(doc: unknown, pointer: string): unknown {
  const p = pointer.startsWith('#') ? pointer.slice(1) : pointer;
  let cur: any = doc;
  for (const seg of p.replace(/^\//, '').split('/')) {
    cur = cur?.[decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'))];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Resolve a local `$ref` (`#/components/schemas/Pet`), following chains of references; a non-local reference and a
 * cycle resolve to an empty schema. Anything that is not a reference comes back as it is.
 */
export function deref(doc: Json | undefined, node: any, seen: Set<string> = new Set()): any {
  if (!doc || !node || typeof node !== 'object' || typeof node.$ref !== 'string') return node;
  if (seen.has(node.$ref) || !node.$ref.startsWith('#/')) return {};
  seen.add(node.$ref);
  return deref(doc, jsonPointerGet(doc, node.$ref), seen);
}

/**
 * The parameters of an operation, references resolved: its own, then those of its path item that it does not override
 * (the same name and place). Entries that are not objects (a dangling reference) are kept for the caller to filter.
 */
export function operationParameters(doc: Json | undefined, pathItem: Json, op: Json): Json[] {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const own = list(op.parameters).map((p) => deref(doc, p) as Json);
  const inherited = list(pathItem.parameters).map((p) => deref(doc, p) as Json).filter((p) => !own.some((o) => o?.name === p?.name && o?.in === p?.in));
  return [...own, ...inherited];
}

/**
 * The JSON type of a schema: its `type`, or the first non-null one of a type list (`all` joins them all with `|`).
 * With `infer`, a schema with `properties` is an object and one with `items` an array when it does not say.
 */
export function typeOf(s: any, opts: { infer?: boolean; all?: boolean } = {}): string | undefined {
  const inferred = () => (opts.infer ? (s?.properties ? 'object' : s?.items ? 'array' : undefined) : undefined);
  if (!Array.isArray(s?.type)) return s?.type ?? inferred();
  const types = (s.type as unknown[]).filter((x) => x !== 'null') as string[];
  return opts.all ? types.join('|') || inferred() : types[0];
}
