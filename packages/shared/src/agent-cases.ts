/**
 * Agent evaluations (AU-19): the two columns of a case that say which tools the agent should and should not call, and the checks
 * they become. Pure functions, so the window (the case table, the wizard), the engine (a dataset record becomes tool checks)
 * and the CLI read the cases the same way.
 *
 * A cell lists tools, separated by commas, semicolons or new lines: `search_docs`, or `search_docs(q=hours, limit=3)` when the
 * arguments matter. A value is read as JSON when it is valid JSON (a number, true, "quoted text", a list), else as text.
 */
export const SHOULD_CALL = 'should_call';
export const SHOULD_NOT_CALL = 'should_not_call';

export interface ToolExpectation {
  tool: string;
  arguments?: Record<string, unknown>;
}

/** Split at commas, semicolons and line breaks that are not inside (), [], {} or quotes. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || ch === ';' || ch === '\n')) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function valueOf(s: string): unknown {
  const t = s.trim();
  if (!t) return '';
  try {
    return JSON.parse(t);
  } catch {
    return t.replace(/^'(.*)'$/, '$1');
  }
}

/** The tools a cell lists. Also reads a list of names or of `{ tool, arguments }` (a case written as JSON). */
export function parseToolList(cell: unknown): ToolExpectation[] {
  if (cell === undefined || cell === null || cell === '') return [];
  if (Array.isArray(cell)) return cell.flatMap((x) => (typeof x === 'string' ? parseToolList(x) : x && typeof x === 'object' && typeof (x as ToolExpectation).tool === 'string' ? [{ tool: (x as ToolExpectation).tool, ...((x as ToolExpectation).arguments ? { arguments: (x as ToolExpectation).arguments } : {}) }] : []));
  if (typeof cell !== 'string') return [];
  const out: ToolExpectation[] = [];
  for (const part of splitTop(cell)) {
    const m = /^([\w.:-]+)\s*(?:\(([\s\S]*)\))?$/.exec(part);
    if (!m) continue;
    const args: Record<string, unknown> = {};
    for (const a of splitTop(m[2] ?? '')) {
      const eq = a.indexOf('=');
      if (eq > 0) args[a.slice(0, eq).trim()] = valueOf(a.slice(eq + 1));
    }
    out.push({ tool: m[1]!, ...(Object.keys(args).length ? { arguments: args } : {}) });
  }
  return out;
}

/** The checks one case's two columns make: each tool to call is checked (with its arguments), the tools not to call as one check. */
export function agentCaseChecks(rec: Record<string, unknown>): Array<{ type: string; tool?: unknown; arguments?: Record<string, unknown> }> {
  const calls = parseToolList(rec[SHOULD_CALL]);
  const never = parseToolList(rec[SHOULD_NOT_CALL]).map((t) => t.tool);
  return [...calls.map((c) => ({ type: 'tool-called', tool: c.tool, ...(c.arguments ? { arguments: c.arguments } : {}) })), ...(never.length ? [{ type: 'tool-not-called', tool: never }] : [])];
}
