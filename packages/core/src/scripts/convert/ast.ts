import { parse, type Node } from 'acorn';

/**
 * A small ESTree layer for the script converter: parse a script (acorn), walk it with the scope chain of every node,
 * and tell references from declarations and property names. "Is `pm` the sandbox's global here?" is answered by the
 * scopes, not by a regular expression: `function (pm) {}` keeps its own `pm`, the rest of the script is still converted.
 */

export type N = Node & Record<string, any>;

export interface ParsedScript {
  ast: N;
  /** Names declared at the top level of the script (they shadow the sandbox's globals everywhere). */
  topLevel: Set<string>;
}

export class ScriptParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

export function parseScript(code: string): ParsedScript {
  try {
    // a script is a function body in the sandbox: top-level await and return are allowed
    const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowHashBang: true }) as N;
    return { ast, topLevel: declaredIn(ast) };
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    throw new ScriptParseError((e as Error).message.replace(/\s*\(\d+:\d+\)$/, ''), loc?.line ?? 1, (loc?.column ?? 0) + 1);
  }
}

/** The names a pattern (`a`, `{ a, b: [c] }`, `...rest`, `d = 1`) declares. */
export function patternNames(p: N | null | undefined, out: Set<string> = new Set()): Set<string> {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier':
      out.add(p.name);
      break;
    case 'ObjectPattern':
      for (const prop of p.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      break;
    case 'ArrayPattern':
      for (const el of p.elements) patternNames(el, out);
      break;
    case 'AssignmentPattern':
      patternNames(p.left, out);
      break;
    case 'RestElement':
      patternNames(p.argument, out);
      break;
  }
  return out;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** `var` declarations anywhere below `node` (not inside nested functions): they belong to the enclosing function scope. */
function hoistedVars(node: N, out: Set<string>): void {
  for (const key of Object.keys(node)) {
    const v = node[key];
    for (const c of Array.isArray(v) ? v : [v]) {
      if (!c || typeof c !== 'object' || typeof c.type !== 'string') continue;
      if (FUNCTIONS.has(c.type) || c.type === 'ClassDeclaration' || c.type === 'ClassExpression') continue;
      if (c.type === 'VariableDeclaration' && c.kind === 'var') for (const d of c.declarations) patternNames(d.id, out);
      hoistedVars(c, out);
    }
  }
}

/** Declarations made directly by the statements of a body (let, const, class, function; `var` too when asked). */
function bodyDeclarations(statements: N[], out: Set<string>): void {
  for (const s of statements) {
    if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations) patternNames(d.id, out);
    else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) out.add(s.id.name);
  }
}

function declaredIn(scope: N): Set<string> {
  const out = new Set<string>();
  if (scope.type === 'Program') {
    hoistedVars(scope, out);
    bodyDeclarations(scope.body, out);
  } else if (FUNCTIONS.has(scope.type)) {
    for (const p of scope.params) patternNames(p, out);
    if (scope.type === 'FunctionExpression' && scope.id) out.add(scope.id.name);
    out.add('arguments');
    if (scope.body.type === 'BlockStatement') {
      hoistedVars(scope.body, out);
      bodyDeclarations(scope.body.body, out);
    }
  } else if (scope.type === 'BlockStatement' || scope.type === 'StaticBlock') bodyDeclarations(scope.body, out);
  else if (scope.type === 'SwitchStatement') for (const c of scope.cases) bodyDeclarations(c.consequent, out);
  else if (scope.type === 'CatchClause') patternNames(scope.param, out);
  else if (scope.type === 'ForStatement' && scope.init?.type === 'VariableDeclaration' && scope.init.kind !== 'var') for (const d of scope.init.declarations) patternNames(d.id, out);
  else if ((scope.type === 'ForInStatement' || scope.type === 'ForOfStatement') && scope.left.type === 'VariableDeclaration' && scope.left.kind !== 'var') for (const d of scope.left.declarations) patternNames(d.id, out);
  else if (scope.type === 'ClassExpression' && scope.id) out.add(scope.id.name);
  return out;
}

const SCOPES = new Set([...FUNCTIONS, 'BlockStatement', 'StaticBlock', 'SwitchStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'ClassExpression']);

export interface Visit {
  node: N;
  parent: N | undefined;
  /** The key of `parent` this node sits in. */
  key: string | undefined;
  /** True when no scope between the node and the script declares `name`: it is the sandbox's global (or undeclared). */
  isFree(name: string): boolean;
}

/** Is this Identifier a reference to a variable (not a property name, label or declaration)? */
function isReference(n: N, parent: N | undefined, key: string | undefined, decl: boolean): boolean {
  if (decl || !parent) return !parent;
  switch (parent.type) {
    case 'MemberExpression':
      return key !== 'property' || parent.computed;
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return key !== 'key' || parent.computed;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false;
  }
  return true;
}

/**
 * Visit every node, parents first. `onNode` returns `false` to skip the node's children (it handled them). `ref` is
 * set for an Identifier that refers to a variable. Scopes are tracked so `isFree` is correct at every node.
 */
export function walk(root: N, onNode: (v: Visit & { ref: boolean }) => boolean | void): void {
  const chain: Array<Set<string>> = [];
  const isFree = (name: string) => !chain.some((s) => s.has(name));
  const visit = (node: N, parent: N | undefined, key: string | undefined, decl: boolean): void => {
    const scoped = SCOPES.has(node.type) || node.type === 'Program';
    if (scoped) chain.push(declaredIn(node));
    const ref = node.type === 'Identifier' && isReference(node, parent, key, decl);
    const go = onNode({ node, parent, key, isFree, ref });
    if (go !== false)
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = node[k];
        // a declaration's pattern holds declared names; its defaults and computed keys are expressions again
        const declKey = (node.type === 'VariableDeclarator' && k === 'id') || (FUNCTIONS.has(node.type) && (k === 'params' || k === 'id')) || (node.type === 'CatchClause' && k === 'param') || ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && k === 'id');
        const childDecl = declKey || (decl && !((node.type === 'AssignmentPattern' && k === 'right') || (node.type === 'Property' && k === 'key' && node.computed)));
        for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c === 'object' && typeof c.type === 'string') visit(c, node, k, childDecl);
      }
    if (scoped) chain.pop();
  };
  visit(root, undefined, undefined, false);
}

/** `a.b.c` / `a["b"].c` as a root identifier and a path (undefined when a link is computed, a call or anything else). */
export function chainOf(n: N): { root: N; path: string[] } | undefined {
  const path: string[] = [];
  let cur = n;
  while (cur.type === 'MemberExpression') {
    if (!cur.computed) path.unshift(cur.property.name);
    else if (cur.property.type === 'Literal' && typeof cur.property.value === 'string') path.unshift(cur.property.value);
    else return undefined;
    cur = cur.object;
  }
  return cur.type === 'Identifier' ? { root: cur, path } : undefined;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits (an insertion has start === end). */
export function applyEdits(code: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = code;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
