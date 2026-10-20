import { applyEdits, parseScript, walk, type Edit } from './ast.js';

/**
 * The way back for exports: a script in TestPion's `tp.*` for another tool's script API (`insomnia.*`). The sandbox
 * names (`tp`, `pm`, `aps`) are the same object, so the root identifier is renamed wherever it is the global (a local
 * variable called `tp` keeps its own meaning). Members the target tool does not have are returned so the export can say
 * which scripts will need a hand: nothing is changed silently.
 */

export interface Retargeted {
  code: string;
  /** Members used that the target tool has no equivalent for (`tp.globals`, `tp.iterationData` …). */
  unsupported: string[];
}

/** `insomnia.*` has no equivalent of these `tp.*` members. */
const INSOMNIA_LACKS = new Set(['globals', 'iterationData', 'state', 'visualizer', 'vault', 'require', 'execution', 'datasets', 'mock']);

export function retargetScript(code: string, to: 'insomnia'): Retargeted {
  if (!code.trim()) return { code, unsupported: [] };
  let parsed;
  try {
    parsed = parseScript(code);
  } catch {
    return { code, unsupported: ['(a script that does not parse)'] };
  }
  const lacks = INSOMNIA_LACKS;
  const edits: Edit[] = [];
  const unsupported = new Set<string>();
  walk(parsed.ast, ({ node, parent, key, isFree, ref }) => {
    if (!ref || node.type !== 'Identifier' || !['tp', 'pm', 'aps'].includes(node.name) || !isFree(node.name)) return;
    // { tp } as a value: keep the property name
    edits.push({ start: node.start, end: node.end, text: parent?.type === 'Property' && parent.shorthand && key === 'value' ? `${node.name}: ${to}` : to });
    if (parent?.type === 'MemberExpression' && key === 'object' && !parent.computed && lacks.has(parent.property.name)) unsupported.add(`${to}.${parent.property.name}`);
  });
  return { code: edits.length ? applyEdits(code, edits) : code, unsupported: [...unsupported] };
}
