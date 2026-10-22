import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  NODE_LABEL,
  addNode,
  addOption,
  emptyTree,
  isLeaf,
  outline,
  removeNode,
  removeOption,
  renameNode,
  renameOption,
  setBranch,
  setNodeText,
  setRoot,
  setRule,
  slotsOf,
  treeOf,
  type Branch,
  type NodeType,
  type Slot,
  type Tree,
  type TreeNode,
} from '../../lib/dag-tree';
import { Badge, Button, IconButton, Input, Select, cx } from '../ui';

/** Where a branch goes: to another node, or to a leaf with a score from 0 to 10 and the reason for it. */
function BranchField({ label, branch, nodes, self, onChange, name }: { label: string; branch: Branch; nodes: string[]; self: string; onChange(b: Branch): void; name: string }) {
  const leaf = isLeaf(branch);
  return (
    <div className="flex items-center gap-1.5 text-xs" data-dag-branch={name}>
      <span className="w-24 shrink-0 text-muted truncate" title={label}>
        {label}
      </span>
      <Select
        className="h-6 min-h-6 py-0 text-xs w-36"
        aria-label={`Where ${label} leads`}
        value={leaf ? '' : (branch as string)}
        onChange={(e) => onChange(e.target.value ? e.target.value : { score: 0 })}
      >
        <option value="">a score</option>
        {nodes
          .filter((n) => n !== self)
          .map((n) => (
            <option key={n} value={n}>
              asks {n}
            </option>
          ))}
      </Select>
      {leaf && (
        <>
          <Input className="h-6 min-h-6 text-xs w-16 tabular-nums" type="number" min={0} max={10} step={1} value={(branch as { score: number }).score} aria-label={`Score at the end of ${label} (0 to 10)`} onChange={(e) => onChange({ ...(branch as { score: number; reason?: string }), score: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} />
          <span className="text-muted">of 10</span>
          <Input className="h-6 min-h-6 text-xs flex-1 min-w-24" value={(branch as { reason?: string }).reason ?? ''} placeholder="why (optional)" aria-label={`Why ${label} ends with this score`} onChange={(e) => onChange({ score: (branch as { score: number }).score, ...(e.target.value ? { reason: e.target.value } : {}) })} />
        </>
      )}
    </div>
  );
}

function RuleFields({ id, node, tree, onTree }: { id: string; node: Extract<TreeNode, { type: 'rule' }>; tree: Tree; onTree(t: Tree): void }) {
  const { type, ...rest } = node.check;
  const [text, setText] = useState(JSON.stringify(rest));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(JSON.stringify(rest)), [JSON.stringify(rest)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Input className="h-6 min-h-6 text-xs mono w-32" value={type} aria-label="Check type of the rule" placeholder="contains" onChange={(e) => onTree(setRule(tree, id, { ...rest, type: e.target.value }))} />
      <Input
        className={cx('h-6 min-h-6 text-xs mono flex-1', bad && 'border-bad')}
        value={text}
        aria-label="Options of the rule as JSON"
        aria-invalid={bad}
        placeholder='{"expected": "please"}'
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value || '{}') as unknown;
            if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
            setBad(false);
            onTree(setRule(tree, id, { ...(v as Record<string, unknown>), type }));
          } catch {
            setBad(true);
          }
        }}
      />
    </div>
  );
}

/**
 * The decision tree of a `dag` metric as something to click: the questions in the order they are asked, what each answer leads
 * to (another question or a score), add and remove a question, rename it, choose where the tree starts. The metric file stays the
 * source: every change is written back into its YAML (the rest of the file, comments included, is kept), and the engine's own
 * check says what is wrong with the tree, the same words as the command line.
 */
export function DagTreeEditor({ text, onText }: { text: string; onText(text: string): void }) {
  const [yaml, setYaml] = useState<typeof import('yaml')>();
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    let live = true;
    void import('yaml').then((m) => live && setYaml(m));
    return () => {
      live = false;
    };
  }, []);
  const tree = useMemo(() => {
    if (!yaml) return undefined;
    try {
      return treeOf((yaml.parse(text) as { tree?: unknown } | null)?.tree);
    } catch {
      return undefined;
    }
  }, [yaml, text]);
  if (!yaml) return null;
  const write = (t: Tree) => {
    setProblem(undefined);
    try {
      const doc = yaml.parseDocument(text);
      doc.set('tree', doc.createNode(t));
      onText(doc.toString({ lineWidth: 0 }));
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  const t = tree ?? undefined;
  const ids = t ? Object.keys(t.nodes) : [];
  const order = t ? outline(t) : [];
  const add = (type: NodeType) => write(addNode(t ?? { root: '', nodes: {} }, type).tree);
  return (
    <section className="border border-line rounded-lg p-2 grid gap-2" data-dag-editor>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-muted uppercase tracking-wide">Decision tree</span>
        {t && (
          <label className="flex items-center gap-1 text-xs">
            starts at
            <Select className="h-6 min-h-6 py-0 text-xs" value={t.root} aria-label="The first question of the tree" onChange={(e) => write(setRoot(t, e.target.value))} data-dag-root>
              {ids.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        )}
        <span className="ml-auto flex items-center gap-1">
          {(['binary', 'choice', 'task', 'rule'] as const).map((k) => (
            <Button key={k} size="sm" icon={<Plus size={11} />} onClick={() => add(k)} disabled={ids.length >= 40} reason="40 checks at most" data-dag-add={k} title={k === 'rule' ? 'A check that needs no model' : k === 'task' ? 'The judge writes something down that later questions can read' : k === 'choice' ? 'The judge picks one of several options' : 'The judge answers yes or no'}>
              {NODE_LABEL[k]}
            </Button>
          ))}
        </span>
      </div>
      {!t && (
        <div className="text-xs text-muted">
          The file has no tree yet.
          <Button size="sm" className="ml-2" onClick={() => write(emptyTree())} data-dag-start>
            Start a tree
          </Button>
        </div>
      )}
      {problem && <div className="text-xs text-bad">{problem}</div>}
      {t &&
        order.map(({ id, depth, reached }) => {
          const node = t.nodes[id]!;
          return (
            <div key={id} className={cx('border border-line/70 rounded-md p-2 grid gap-1.5', !reached && 'opacity-70')} style={{ marginLeft: `${Math.min(depth, 6) * 14}px` }} data-dag-node={id}>
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-6 min-h-6 text-xs mono w-28"
                  defaultValue={id}
                  key={id}
                  aria-label={`Id of the node ${id}`}
                  onBlur={(e) => {
                    const r = renameNode(t, id, e.target.value);
                    if (r.problem) {
                      setProblem(r.problem);
                      e.target.value = id;
                    } else write(r.tree);
                  }}
                />
                <Badge tone={node.type === 'rule' ? 'ok' : 'judge'}>{NODE_LABEL[node.type]}</Badge>
                {t.root === id && <Badge tone="accent">first</Badge>}
                {!reached && <Badge tone="warn" title="No answer leads here">not reached</Badge>}
                <IconButton label={`Remove the node ${id}`} className="ml-auto" onClick={() => write(removeNode(t, id))} data-dag-remove={id}>
                  <X size={12} />
                </IconButton>
              </div>
              {node.type !== 'rule' && (
                <Input
                  className="h-7 min-h-7 text-xs"
                  value={node.type === 'task' ? node.instruction : node.question}
                  placeholder={node.type === 'task' ? 'What to write down, e.g. list the documents the answer cites' : node.type === 'choice' ? 'The question, e.g. which document does it cite?' : 'A yes / no question about the answer'}
                  aria-label={node.type === 'task' ? `What node ${id} writes down` : `Question of node ${id}`}
                  onChange={(e) => write(setNodeText(t, id, e.target.value))}
                />
              )}
              {node.type === 'rule' && <RuleFields id={id} node={node} tree={t} onTree={write} />}
              {slotsOf(node).map((s) => (
                <div key={s.slot} className="flex items-start gap-1">
                  {node.type === 'choice' ? (
                    <Input
                      className="h-6 min-h-6 text-xs w-24 shrink-0"
                      defaultValue={s.label}
                      key={`${id}-${s.label}`}
                      aria-label={`Label of an option of ${id}`}
                      onBlur={(e) => {
                        const r = renameOption(t, id, s.label, e.target.value);
                        if (r.problem) {
                          setProblem(r.problem);
                          e.target.value = s.label;
                        } else write(r.tree);
                      }}
                    />
                  ) : null}
                  <div className="flex-1 min-w-0">
                    <BranchField name={`${id}:${s.slot}`} label={node.type === 'choice' ? 'goes to' : s.label} branch={s.branch} nodes={ids} self={id} onChange={(b) => write(setBranch(t, id, s.slot as Slot, b))} />
                  </div>
                  {node.type === 'choice' && Object.keys(node.options).length > 2 && (
                    <IconButton label={`Remove the option ${s.label}`} onClick={() => write(removeOption(t, id, s.label))}>
                      <X size={11} />
                    </IconButton>
                  )}
                </div>
              ))}
              {node.type === 'choice' && Object.keys(node.options).length < 8 && (
                <Button size="sm" className="justify-self-start" icon={<Plus size={11} />} onClick={() => write(addOption(t, id))} data-dag-add-option={id}>
                  Option
                </Button>
              )}
            </div>
          );
        })}
    </section>
  );
}
