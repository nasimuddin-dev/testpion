/** A check (an assertion) in a few words, the same for an AI proposal's items, its verification and the Checks tab. */

/** What a check reads besides the response itself: a JSON path, a header's name, an MCP tool. */
export function checkSubject(c: { type: string; path?: unknown; header?: unknown; tool?: unknown; [k: string]: unknown }): string {
  return [c.path, c.header ?? (c.type === 'header' ? c.name : undefined), c.tool].filter((x) => typeof x === 'string' && x.length > 0).join(' ');
}

/** `status = 201`, `header content-type = "json"`, `exists $.id`, `matches $.email /@/`: at most 120 characters. */
export function checkLabel(c: { type: string; path?: unknown; expected?: unknown; pattern?: unknown; value?: unknown; [k: string]: unknown }): string {
  const value = c.expected !== undefined ? `= ${JSON.stringify(c.expected)}` : c.pattern !== undefined ? `/${String(c.pattern)}/` : c.value !== undefined ? JSON.stringify(c.value) : '';
  return [c.type, checkSubject(c), value].filter(Boolean).join(' ').slice(0, 120);
}
