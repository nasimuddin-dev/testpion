import { applyEdits, chainOf, parseScript, ScriptParseError, walk, type Edit, type N } from './ast.js';
import { BRU_SHIM, BRU_TO_TP, INSOMNIA_MISSING, POSTMAN_LEGACY_CALLS, POSTMAN_MISSING } from './coverage.js';

/**
 * Script converter v2 (import-compat plan 4b): another tool's script API → TestPion's `tp.*`, by the syntax tree.
 * Edits are made by position, so formatting and comments survive; scope analysis decides whether `pm` / `bru` /
 * `insomnia` is the sandbox's global (a local variable of the same name is left alone). What has no equivalent gets a
 * `// TODO(import)` line above it and a finding. The conversion is idempotent: converting its own output changes nothing.
 * A script that does not parse is returned as it is (it still runs through the alias) with a parse finding.
 */

export type ScriptTool = 'postman' | 'insomnia' | 'bruno';

export interface ScriptFinding {
  code: 'SCRIPT_API' | 'SCRIPT_BASE_ENVIRONMENT' | 'SCRIPT_PARSE_ERROR' | 'SCRIPT_OWN_GLOBAL';
  /** The API concerned (`bru.sendRequest`, `insomnia.parentFolders`, `pm.datasets`). */
  api: string;
  line: number;
  message: string;
}

export interface ScriptResult {
  code: string;
  /** `converted`: the code changed; `unchanged`: nothing in it needs converting; `kept`: left as it is, see `reason`. */
  status: 'converted' | 'unchanged' | 'kept';
  /** How many places were rewritten. */
  changes: number;
  findings: ScriptFinding[];
  reason?: string;
}

export interface ConvertOptions {
  /** The name the script API gets: `tp` (TestPion's), or `pm` for an Insomnia script kept in its Postman-compatible form. */
  alias?: 'tp' | 'pm';
}

const OWN: Record<ScriptTool, string> = { postman: 'pm', insomnia: 'insomnia', bruno: 'bru' };
const lineOf = (code: string, pos: number) => code.slice(0, pos).split('\n').length;

/** The node of a chain that covers the root and its first `depth` links (`a.b` of `a.b.c.d` for depth 1). */
function linkNode(outer: N, pathLength: number, depth: number): N {
  let n = outer;
  for (let i = pathLength; i > depth; i--) n = n.object;
  return n;
}

/** Convert one script. */
export function convertScript(code: string, tool: ScriptTool, opts: ConvertOptions = {}): ScriptResult {
  const alias = opts.alias ?? 'tp';
  if (!code?.trim()) return { code, status: 'unchanged', changes: 0, findings: [] };
  let parsed;
  try {
    parsed = parseScript(code);
  } catch (e) {
    if (!(e instanceof ScriptParseError)) throw e;
    // a script that does not parse is still run by the sandbox as written: report where it breaks
    return { code, status: 'kept', changes: 0, reason: `the script does not parse (line ${e.line}, column ${e.column}: ${e.message})`, findings: [{ code: 'SCRIPT_PARSE_ERROR', api: '', line: e.line, message: `line ${e.line}, column ${e.column}: ${e.message}` }] };
  }
  const edits: Edit[] = [];
  const findings: ScriptFinding[] = [];
  /** APIs without an equivalent, by the start of the line they are on (one TODO line per line of code). */
  const todos = new Map<number, string[]>();
  const handled = new Set<N>();
  const replace = (n: { start: number; end: number }, text: string) => edits.push({ start: n.start, end: n.end, text });
  const free = (name: string, isFree: (n: string) => boolean) => isFree(name) && !parsed.topLevel.has(name);

  const missing = (pos: number, api: string, message: string) => {
    const lineStart = code.lastIndexOf('\n', pos - 1) + 1;
    const list = todos.get(lineStart) ?? [];
    if (!list.includes(api)) {
      list.push(api);
      findings.push({ code: 'SCRIPT_API', api, line: lineOf(code, pos), message });
    }
    todos.set(lineStart, list);
  };

  walk(parsed.ast, ({ node, parent, key, isFree, ref }) => {
    // ---- tests["name"] = expr;   (Postman's pre-pm assertions)
    if (tool === 'postman' && node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && node.expression.operator === '=') {
      const l = node.expression.left;
      if (l.type === 'MemberExpression' && l.computed && l.property.type === 'Literal' && typeof l.property.value === 'string' && l.object.type === 'Identifier' && l.object.name === 'tests' && free('tests', isFree)) {
        const right = node.expression.right as N;
        edits.push({ start: node.start, end: right.start, text: `tp.test(${code.slice(l.property.start, l.property.end)}, function () { tp.expect(` });
        edits.push({ start: right.end, end: node.end, text: ').to.be.ok; });' });
        // the expression is still visited: responseCode.code inside it is converted too
        return;
      }
    }
    // ---- JSON.parse(responseBody)
    if (tool === 'postman' && node.type === 'CallExpression' && node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === 'responseBody') {
      const c = node.callee;
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'JSON' && c.property.name === 'parse' && free('responseBody', isFree) && free('JSON', isFree)) {
        replace(node, 'tp.response.json()');
        return false;
      }
    }

    // ---- a chain on the tool's global: pm.x.y, postman.f(), insomnia.request.auth.update, bru.runner.skipRequest()
    if (node.type === 'MemberExpression' && !(parent?.type === 'MemberExpression' && key === 'object')) {
      const ch = chainOf(node);
      if (ch && free(ch.root.name, isFree)) {
        const root = ch.root;
        const dotted = ch.path.join('.');
        const call = parent?.type === 'CallExpression' && key === 'callee' ? parent : undefined;
        if (tool === 'postman') {
          if (root.name === 'postman' && call && POSTMAN_LEGACY_CALLS[dotted]) {
            replace(node, POSTMAN_LEGACY_CALLS[dotted]!);
            return false;
          }
          if (root.name === 'responseCode' && (ch.path[0] === 'code' || ch.path[0] === 'name')) {
            replace(linkNode(node, ch.path.length, 1), ch.path[0] === 'code' ? 'tp.response.code' : 'tp.response.status');
            // (a longer chain keeps its tail: responseCode.code.toString())
            return false;
          }
          if (root.name === 'pm' || root.name === 'aps') {
            replace(root, 'tp');
            handled.add(root);
            const m = POSTMAN_MISSING.find((x) => x === ch.path[0]);
            if (m) missing(root.start, `pm.${m}`, `pm.${m} has no TestPion equivalent yet (marked TODO(import) in the script)`);
          }
        } else if (tool === 'insomnia' && root.name === 'insomnia') {
          handled.add(root);
          // the base environment is merged into every imported environment: insomnia.baseEnvironment / collectionVariables read it
          if (ch.path[0] === 'baseEnvironment' || ch.path[0] === 'collectionVariables') {
            replace({ start: root.start, end: linkNode(node, ch.path.length, 1).end }, `${alias}.environment`);
            findings.push({ code: 'SCRIPT_BASE_ENVIRONMENT', api: `insomnia.${ch.path[0]}`, line: lineOf(code, root.start), message: `insomnia.baseEnvironment / collectionVariables became ${alias}.environment (the base environment is merged into each imported environment)` });
          } else replace(root, alias);
          const gone = INSOMNIA_MISSING.find((m) => dotted === m || dotted.startsWith(`${m}.`));
          if (gone) missing(root.start, `insomnia.${gone}`, `insomnia.${gone} has no TestPion equivalent (marked TODO(import) in the script)`);
        } else if (tool === 'bruno' && root.name === 'bru') {
          handled.add(root);
          const depth = ch.path[0] === 'runner' ? 2 : 1;
          const name = ch.path.slice(0, depth).join('.');
          if (call && call.arguments.length === 0 && BRU_TO_TP[`${name}()`] && ch.path.length === depth) {
            replace(call, BRU_TO_TP[`${name}()`]!);
            return false;
          }
          const to = BRU_TO_TP[name];
          if (to) replace(linkNode(node, ch.path.length, depth), to);
          else if (!BRU_SHIM.has(name)) missing(root.start, `bru.${name}`, `bru.${name} has no TestPion equivalent yet (marked TODO(import) in the script)`);
        }
      }
      return;
    }

    // ---- the global on its own (or computed access): const p = pm; pm[name]
    if (!ref || node.type !== 'Identifier' || handled.has(node)) return;
    const name = node.name;
    if (!free(name, isFree)) return;
    const to = tool === 'postman' ? (name === 'pm' || name === 'aps' ? 'tp' : name === 'responseBody' ? 'tp.response.text()' : name === 'responseTime' ? 'tp.response.responseTime' : undefined) : tool === 'insomnia' && name === 'insomnia' ? alias : undefined;
    if (!to) return;
    // { pm } as a value: keep the property name
    replace(node, parent?.type === 'Property' && parent.shorthand && key === 'value' ? `${name}: ${to}` : to);
  });

  const changes = edits.length;
  // a TODO line above each line that uses an API TestPion doesn't have
  for (const [lineStart, apis] of todos) {
    const prevStart = lineStart > 0 ? code.lastIndexOf('\n', lineStart - 2) + 1 : 0;
    // (once: a script converted again keeps its single TODO)
    if (lineStart > 0 && /^\s*\/\/ TODO\(import\)/.test(code.slice(prevStart, lineStart - 1))) continue;
    const indent = /^[ \t]*/.exec(code.slice(lineStart))![0];
    const text =
      tool === 'insomnia'
        ? `Insomnia's ${apis[0]!.replace(/^insomnia\./, '')} has no TestPion equivalent: rewrite this line`
        : tool === 'bruno'
          ? `${apis.join(', ')} has no TestPion equivalent yet: rewrite this line with TestPion's script API (sendRequest, cookies …)`
          : `${apis.join(', ')} has no TestPion equivalent yet: rewrite this line`;
    edits.push({ start: lineStart, end: lineStart, text: `${indent}// TODO(import): ${text}\n` });
  }
  const out = edits.length ? applyEdits(code, edits) : code;
  // a script that declares its own `pm` at the top level has no sandbox `pm` to convert
  const own = OWN[tool];
  if (!changes && parsed.topLevel.has(own) && new RegExp(`\\b${own}\\b`).test(code)) {
    const reason = `the script declares its own "${own}"`;
    return { code, status: 'kept', changes: 0, findings: [{ code: 'SCRIPT_OWN_GLOBAL', api: own, line: 1, message: reason }], reason };
  }
  return { code: out, status: changes ? 'converted' : 'unchanged', changes, findings };
}

export { BRU_TO_TP, POSTMAN_LEGACY_CALLS, POSTMAN_MISSING, INSOMNIA_MISSING } from './coverage.js';
