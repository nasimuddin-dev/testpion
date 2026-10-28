/**
 * Select by condition and the Debugger's command bar (FG-3). One small grammar, used by the window's Select matching
 * dialog and command bar, by `testpion debug exchanges --where` and by the MCP tool debugger_exchanges, so all of them
 * mean the same thing. Pure and browser-safe.
 *
 *   where:    status>=400 and host~api and size>200kb         (clauses joined by `and`, `&&`, `&` or `;`; all must hold)
 *   fields:   status method host url type size time app ip user pid note mark kind
 *   operators = != > >= < <= ~ (contains) !~ ^= (starts with) $= (ends with)
 *   values:   a word, or "quoted text"; size takes 200kb / 1.5mb, time takes 500ms / 2s; status = 4xx is the class
 */

/** The part of an exchange (a list row is enough) the conditions read. */
export interface SelectRow {
  method: string;
  url: string;
  host: string;
  status?: number;
  error?: string;
  contentType?: string;
  responseBodyBytes: number;
  durationMs?: number;
  application?: string;
  user?: string;
  serverAddress?: string;
  pid?: number;
  note?: string;
  mark?: string;
  kind?: string;
}

export type SelectField = 'status' | 'method' | 'host' | 'url' | 'type' | 'size' | 'time' | 'app' | 'ip' | 'user' | 'pid' | 'note' | 'mark' | 'kind';
export type SelectOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | '!~' | '^=' | '$=';

export interface SelectClause {
  field: SelectField;
  op: SelectOp;
  value: string;
}

/** The fields, with the words people type for them. */
export const SELECT_FIELDS: ReadonlyArray<{ field: SelectField; label: string; numeric: boolean; aliases: string[] }> = [
  { field: 'status', label: 'Status', numeric: true, aliases: [] },
  { field: 'method', label: 'Method', numeric: false, aliases: [] },
  { field: 'host', label: 'Domain', numeric: false, aliases: ['domain'] },
  { field: 'url', label: 'URL', numeric: false, aliases: [] },
  { field: 'type', label: 'Type', numeric: false, aliases: ['content-type', 'contenttype'] },
  { field: 'size', label: 'Size', numeric: true, aliases: ['bytes'] },
  { field: 'time', label: 'Duration', numeric: true, aliases: ['duration', 'ms'] },
  { field: 'app', label: 'Application', numeric: false, aliases: ['application', 'program'] },
  { field: 'ip', label: 'IP address', numeric: false, aliases: [] },
  { field: 'user', label: 'User', numeric: false, aliases: [] },
  { field: 'pid', label: 'PID', numeric: true, aliases: [] },
  { field: 'note', label: 'Comment', numeric: false, aliases: ['comment'] },
  { field: 'mark', label: 'Mark', numeric: false, aliases: ['colour', 'color'] },
  { field: 'kind', label: 'Kind', numeric: false, aliases: [] },
];

export const SELECT_OPS: ReadonlyArray<{ op: SelectOp; label: string }> = [
  { op: '=', label: 'is' },
  { op: '!=', label: 'is not' },
  { op: '~', label: 'contains' },
  { op: '!~', label: 'does not contain' },
  { op: '^=', label: 'starts with' },
  { op: '$=', label: 'ends with' },
  { op: '>', label: 'is more than' },
  { op: '>=', label: 'is at least' },
  { op: '<', label: 'is less than' },
  { op: '<=', label: 'is at most' },
];

const FIELD_OF = new Map<string, SelectField>(SELECT_FIELDS.flatMap((f) => [[f.field, f.field] as const, ...f.aliases.map((a) => [a, f.field] as const)]));
const NUMERIC = new Set<SelectField>(SELECT_FIELDS.filter((f) => f.numeric).map((f) => f.field));
const MAX_CLAUSES = 12;
const MAX_VALUE = 500;

/** A size or a time as a number: 200kb, 1.5mb, 2s, 500ms, 40 (as is). NaN when it is not one. */
export function parseAmount(field: 'size' | 'time' | 'status' | 'pid', text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (!unit) return n;
  if (field === 'size') return unit === 'b' ? n : unit === 'kb' || unit === 'k' ? n * 1024 : unit === 'mb' || unit === 'm' ? n * 1024 * 1024 : unit === 'gb' ? n * 1024 ** 3 : NaN;
  if (field === 'time') return unit === 'ms' ? n : unit === 's' || unit === 'sec' ? n * 1000 : unit === 'min' ? n * 60_000 : NaN;
  return NaN;
}

export type ParsedWhere = { ok: true; clauses: SelectClause[] } | { ok: false; error: string };

const OPS = ['>=', '<=', '!=', '!~', '^=', '$=', '=', '>', '<', '~'] as const;

/** Read a condition text into clauses, or say what is wrong with it (in words a person can fix). */
export function parseWhere(text: string): ParsedWhere {
  const s = text.trim();
  if (!s) return { ok: false, error: 'Write a condition, for example status>=400 and host~api' };
  const clauses: SelectClause[] = [];
  let i = 0;
  const skip = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  while (i < s.length) {
    skip();
    const start = i;
    while (i < s.length && /[a-z-]/i.test(s[i]!)) i++;
    const word = s.slice(start, i).toLowerCase();
    const field = FIELD_OF.get(word);
    if (!field) return { ok: false, error: word ? `"${word}" is not a field. Fields: ${SELECT_FIELDS.map((f) => f.field).join(', ')}` : `Expected a field at position ${start + 1}. Fields: ${SELECT_FIELDS.map((f) => f.field).join(', ')}` };
    skip();
    const op = OPS.find((o) => s.startsWith(o, i));
    if (!op) return { ok: false, error: `After "${word}" write an operator: = != > >= < <= ~ !~ ^= $=` };
    i += op.length;
    skip();
    let value: string;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]!;
      const end = s.indexOf(q, i + 1);
      if (end < 0) return { ok: false, error: 'A quoted value is not closed' };
      value = s.slice(i + 1, end);
      i = end + 1;
    } else {
      const from = i;
      while (i < s.length && !/[\s&;]/.test(s[i]!)) i++;
      value = s.slice(from, i);
    }
    if (!value) return { ok: false, error: `"${word}${op}" needs a value` };
    if (value.length > MAX_VALUE) return { ok: false, error: 'A value is too long (500 characters at most)' };
    if (NUMERIC.has(field) && ['>', '>=', '<', '<='].includes(op) && Number.isNaN(parseAmount(field as 'size', value))) return { ok: false, error: `${field}${op}${value}: "${value}" is not a number${field === 'size' ? ' (200kb, 1.5mb)' : field === 'time' ? ' (500ms, 2s)' : ''}` };
    if (!NUMERIC.has(field) && ['>', '>=', '<', '<='].includes(op)) return { ok: false, error: `${field} is text: use = != ~ !~ ^= $= (not ${op})` };
    clauses.push({ field, op, value });
    if (clauses.length > MAX_CLAUSES) return { ok: false, error: `At most ${MAX_CLAUSES} conditions` };
    skip();
    // the joint: and, &&, &, ; (a missing one is an error, so "status=404 host=x" is not silently half read)
    if (i >= s.length) break;
    const rest = s.slice(i);
    const joint = /^(and\b|&&|&|;)/i.exec(rest);
    if (!joint) return { ok: false, error: `Join conditions with "and": ${s.slice(Math.max(0, i - 12), i + 12)}` };
    i += joint[0].length;
    skip();
    if (i >= s.length) return { ok: false, error: 'A condition is missing after "and"' };
  }
  return { ok: true, clauses };
}

/** The condition as text again (the dialog fills the command bar and the CLI echoes it). */
export function whereText(clauses: readonly SelectClause[]): string {
  return clauses.map((c) => `${c.field}${c.op}${/[\s&;"']/.test(c.value) ? JSON.stringify(c.value) : c.value}`).join(' and ');
}

function textOf(r: SelectRow, f: SelectField): string {
  switch (f) {
    case 'method':
      return r.method;
    case 'host':
      return r.host;
    case 'url':
      return r.url;
    case 'type':
      return (r.contentType ?? '').split(';')[0]!.trim();
    case 'app':
      return r.application ?? '';
    case 'ip':
      return r.serverAddress ?? '';
    case 'user':
      return r.user ?? '';
    case 'note':
      return r.note ?? '';
    case 'mark':
      return r.mark ?? '';
    case 'kind':
      return r.kind ?? 'http';
    default:
      return '';
  }
}

function numberOf(r: SelectRow, f: SelectField): number | undefined {
  switch (f) {
    case 'status':
      return r.status;
    case 'size':
      return r.responseBodyBytes;
    case 'time':
      return r.durationMs;
    case 'pid':
      return r.pid;
    default:
      return undefined;
  }
}

/** One compiled clause: the comparison made once, run per row. */
export type ClauseTest = (r: SelectRow) => boolean;

export function compileClause(c: SelectClause): ClauseTest {
  const { field, op } = c;
  const want = c.value.toLowerCase();
  if (NUMERIC.has(field)) {
    const classOf = field === 'status' ? /^([1-5])xx$/i.exec(c.value) : null;
    const target = parseAmount(field as 'size', c.value);
    return (r) => {
      const n = numberOf(r, field);
      if (classOf && (op === '=' || op === '!=')) {
        const hit = n !== undefined && n >= Number(classOf[1]) * 100 && n < Number(classOf[1]) * 100 + 100;
        return op === '=' ? hit : !hit;
      }
      if (field === 'status' && want === 'error' && (op === '=' || op === '!=')) return op === '=' ? !!r.error : !r.error;
      if (op === '~' || op === '!~' || op === '^=' || op === '$=') {
        const t = n === undefined ? '' : String(n);
        const hit = op === '~' || op === '!~' ? t.includes(want) : op === '^=' ? t.startsWith(want) : t.endsWith(want);
        return op === '!~' ? !hit : hit;
      }
      if (n === undefined) return op === '!=';
      if (Number.isNaN(target)) return op === '!=';
      switch (op) {
        case '=':
          return n === target;
        case '!=':
          return n !== target;
        case '>':
          return n > target;
        case '>=':
          return n >= target;
        case '<':
          return n < target;
        default:
          return n <= target;
      }
    };
  }
  return (r) => {
    const t = textOf(r, field).toLowerCase();
    switch (op) {
      case '=':
        return t === want;
      case '!=':
        return t !== want;
      case '~':
        return t.includes(want);
      case '!~':
        return !t.includes(want);
      case '^=':
        return t.startsWith(want);
      case '$=':
        return t.endsWith(want);
      default:
        return false;
    }
  };
}

/** A test for rows: every clause must hold. Compile once, then call it per row. */
export function compileWhere(clauses: readonly SelectClause[]): ClauseTest {
  const tests = clauses.map(compileClause);
  return (r) => {
    for (const t of tests) if (!t(r)) return false;
    return true;
  };
}

/** The rows a condition text selects (throws the parse error's text). */
export function selectRows<R extends SelectRow>(rows: readonly R[], where: string): R[] {
  const p = parseWhere(where);
  if (!p.ok) throw new Error(p.error);
  const test = compileWhere(p.clauses);
  return rows.filter(test);
}

/* ---- the command bar */

export type DebuggerCommand =
  | { verb: 'filter'; text: string }
  | { verb: 'select'; where: string; say: string }
  | { verb: 'breakpoint'; url: string }
  | { verb: 'delete' }
  | { verb: 'clear' }
  | { verb: 'hosts' };

export type ParsedCommand = { ok: true; command: DebuggerCommand } | { ok: false; error: string };

/** The ten verbs of the command bar, for the help line and the documentation. */
export const COMMAND_HELP: ReadonlyArray<{ syntax: string; says: string }> = [
  { syntax: '?text', says: 'Filter the list to rows containing text' },
  { syntax: '>200kb', says: 'Select responses larger than 200 KB' },
  { syntax: '<5kb', says: 'Select responses smaller than 5 KB' },
  { syntax: '=404', says: 'Select status 404 (=4xx for a class)' },
  { syntax: '@host', says: 'Select rows of a domain' },
  { syntax: 'select status>=400 and host~api', says: 'Select rows by a condition' },
  { syntax: 'bp url', says: 'Hold requests whose URL contains it at a breakpoint' },
  { syntax: 'delete', says: 'Delete the selected rows (asks first)' },
  { syntax: 'clear', says: 'Clear the session (asks first)' },
  { syntax: 'hosts', says: 'Open the Structure panel (rows by domain)' },
];

/** Read a command bar line. Only the ten verbs of COMMAND_HELP exist; a second implementation of nothing: each maps to an existing action. */
export function parseCommand(line: string): ParsedCommand {
  const s = line.trim();
  if (!s) return { ok: false, error: 'Type a command. ? for text, >200kb, =404, @host, select …, bp url, delete, clear, hosts' };
  if (s.startsWith('?')) {
    const text = s.slice(1).trim();
    return text ? { ok: true, command: { verb: 'filter', text } } : { ok: false, error: '? needs a text to filter by' };
  }
  const viaWhere = (where: string, say: string): ParsedCommand => {
    const p = parseWhere(where);
    return p.ok ? { ok: true, command: { verb: 'select', where, say } } : p;
  };
  if (s.startsWith('>') || s.startsWith('<')) return viaWhere(`size${s[0]}${s.slice(1).trim()}`, `responses ${s[0] === '>' ? 'larger' : 'smaller'} than ${s.slice(1).trim()}`);
  if (s.startsWith('=')) return viaWhere(`status=${s.slice(1).trim()}`, `status ${s.slice(1).trim()}`);
  if (s.startsWith('@')) return s.length > 1 ? viaWhere(`host~${s.slice(1).trim()}`, `rows of ${s.slice(1).trim()}`) : { ok: false, error: '@ needs a domain' };
  const [verb = '', ...restWords] = s.split(/\s+/);
  const rest = restWords.join(' ');
  switch (verb.toLowerCase()) {
    case 'select':
      return viaWhere(rest, rest);
    case 'bp':
      return rest ? { ok: true, command: { verb: 'breakpoint', url: rest } } : { ok: false, error: 'bp needs part of a URL: bp /orders' };
    case 'delete':
      return { ok: true, command: { verb: 'delete' } };
    case 'clear':
      return { ok: true, command: { verb: 'clear' } };
    case 'hosts':
      return { ok: true, command: { verb: 'hosts' } };
    default:
      return { ok: false, error: `"${verb}" is not a command. ? > < = @ select bp delete clear hosts` };
  }
}

/** A host on this computer or on a test domain: sending a request there again is not load on someone else's server (Replay asks before it goes elsewhere). */
export function isReplayLocalHost(host: string): boolean {
  const h = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost') || h.endsWith('.test') || h.endsWith('.local') || h === 'host.docker.internal';
}
