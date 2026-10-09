import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowStep } from '@testpion/shared';
import { call } from '../api';
import { toastError } from '../store';
import type { KeyValue } from '../types';
import { CodeEditor } from './CodeEditor';
import { KeyValueEditor } from './KeyValueEditor';
import { VarInput } from './VarInput';
import { Field, Input, SectionTitle, Select, Textarea } from './ui';

/**
 * The flow designer's fields for the flow blocks (FlowDesigner's inspector): a condition's expression, a script, a
 * sub-flow's file and inputs, a log message; and for any step when it runs (if:, the branch of a condition) and how
 * often (repeat: / forEach:). Every change is one tests.flowEdit updateStep through `update`, like the other fields.
 */

/** A value edited here and saved a moment after the last change (and when the inspector closes). */
export function useCommitted<T>(initial: T, commit: (v: T) => unknown, ms = 600): [T, (v: T) => void, () => void] {
  const [value, setValue] = useState(initial);
  const pending = useRef<{ v: T; t: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.t);
    pending.current = undefined;
    void commitRef.current(p.v);
  }, []);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      if (pending.current) clearTimeout(pending.current.t);
      pending.current = { v, t: setTimeout(flush, ms) };
    },
    [flush, ms],
  );
  useEffect(() => flush, [flush]);
  return [value, set, flush];
}

export const asRows = (v: unknown): KeyValue[] =>
  Array.isArray(v)
    ? v.map((x) =>
        x && typeof x === 'object' ? { key: String((x as KeyValue).key ?? ''), value: String((x as KeyValue).value ?? ''), enabled: (x as KeyValue).enabled !== false } : { key: String(x), value: '' },
      )
    : v && typeof v === 'object'
      ? Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : JSON.stringify(value) }))
      : [];
export const asMap = (rows: KeyValue[]): Record<string, string> | null => {
  const on = rows.filter((r) => r.key && r.enabled !== false);
  return on.length ? Object.fromEntries(on.map((r) => [r.key, r.value])) : null;
};
export const asText = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : undefined);

/** `to` as written from the folder of `from` (both inside tests/): child.yaml, ../auth/login.yaml. */
export function relativeTestPath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array<string>(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

/** The test files of the workspace (paths inside tests/), for a sub-flow's file. */
function useTestFiles(enabled: boolean): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    type Node = { path: string; kind: 'dir' | 'file'; children?: Node[] };
    const flat = (nodes: Node[]): string[] => nodes.flatMap((n) => (n.kind === 'dir' ? flat(n.children ?? []) : /\.(ya?ml|json)$/i.test(n.path) && !/\.suite\./i.test(n.path) ? [n.path] : []));
    void call<Node[]>('tests.tree').then((t) => setFiles(flat(t)), toastError);
  }, [enabled]);
  return files;
}

/** The fields of a condition, script, sub-flow or log step; null for the other types. */
export function BlockFields({
  file,
  step,
  raw,
  steps,
  update,
}: {
  file: string;
  step: FlowStep;
  raw: Record<string, unknown>;
  steps: FlowStep[];
  update(set: Record<string, unknown>): Promise<unknown>;
}) {
  const [expr, setExpr] = useState(asText(raw.if ?? raw.condition) ?? '');
  const [message, setMessage] = useState(asText(raw.message) ?? '');
  const [script, setScript] = useCommitted<string>(asText(raw.script) ?? '', (code) => update({ script: code }));
  const [inputs, setInputs] = useCommitted<KeyValue[]>(asRows(raw.inputs), (rows) => update({ inputs: asMap(rows) }));
  const files = useTestFiles(step.type === 'flow');
  if (step.type === 'condition') {
    const branch = (w: boolean) => steps.filter((s) => s.when === w && s.dependsOn?.includes(step.id));
    const commit = () => expr.trim() && expr !== asText(raw.if) && void update({ if: expr.trim() });
    return (
      <>
        <SectionTitle>Condition</SectionTitle>
        <Field label="If" hint="status, $.json.path of the previous step's response, {{variables}}; == != > < && || !">
          <div onBlur={commit} data-inspector-condition>
            <VarInput ariaLabel="Condition" value={expr} onChange={setExpr} onEnter={commit} placeholder="status == 200 && $.role == 'admin'" />
          </div>
        </Field>
        <div className="grid gap-1 text-xs" data-inspector-branches>
          {([true, false] as const).map((w) => (
            <p key={String(w)}>
              <b className={w ? 'text-ok' : 'text-bad'}>{String(w)}</b>{' '}
              {branch(w).length ? (
                branch(w)
                  .map((s) => s.name)
                  .join(', ')
              ) : (
                <span className="text-muted">nothing yet: drag the {String(w)} dot onto a step</span>
              )}
            </p>
          ))}
        </div>
      </>
    );
  }
  if (step.type === 'script')
    return (
      <>
        <SectionTitle>Script</SectionTitle>
        <div className="h-48 border border-line rounded-md overflow-hidden" data-inspector-script>
          <CodeEditor value={script} onChange={setScript} language="javascript" minimal />
        </div>
        <p className="text-xs text-muted">No request: tp.variables.set(…) passes values to the steps after it; tp.test(…) adds checks. pm.* works too.</p>
      </>
    );
  if (step.type === 'flow') {
    const current = asText(raw.file ?? raw.flow) ?? '';
    const options = files.filter((f) => f !== file).map((f) => relativeTestPath(file, f));
    return (
      <>
        <SectionTitle>Sub-flow</SectionTitle>
        <Field label="Flow file" hint="Runs as one step; its output: (or the values it extracts) come back as variables">
          <Select aria-label="Flow file" data-inspector-flow-file value={current} onChange={(e) => void update({ file: e.target.value })}>
            {!options.includes(current) && <option value={current}>{current || 'Pick a test file'}</option>}
            {options.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Inputs">
          <div data-inspector-inputs>
            <KeyValueEditor rows={inputs} onChange={setInputs} keyPlaceholder="Variable" valuePlaceholder="{{value}}" />
          </div>
        </Field>
      </>
    );
  }
  if (step.type === 'log') {
    const commit = () => message !== asText(raw.message) && void update({ message });
    return (
      <>
        <SectionTitle>Log</SectionTitle>
        <Field label="Message" hint="Shown in the run results, with {{variables}} resolved">
          <div onBlur={commit} data-inspector-message>
            <VarInput ariaLabel="Message" value={message} onChange={setMessage} onEnter={commit} placeholder="Token: {{token}}" />
          </div>
        </Field>
      </>
    );
  }
  return null;
}

type LoopMode = 'once' | 'times' | 'list' | 'dataset';

/** When a step runs (`if:`, the branch of a condition it waits for) and how often (`repeat:` / `forEach:`). */
export function RunControlFields({ step, raw, steps, update }: { step: FlowStep; raw: Record<string, unknown>; steps: FlowStep[]; update(set: Record<string, unknown>): Promise<unknown> }) {
  const [cond, setCond] = useState(step.type === 'condition' ? '' : (asText(raw.if) ?? ''));
  const fe = raw.forEach ?? raw.for_each;
  const mode0: LoopMode = raw.repeat !== undefined && raw.repeat !== null ? 'times' : Array.isArray(fe) ? 'list' : fe ? 'dataset' : 'once';
  const [mode, setMode] = useState<LoopMode>(mode0);
  const [times, setTimes] = useState(String(raw.repeat ?? 3));
  const [rows, setRows] = useState(Array.isArray(fe) ? JSON.stringify(fe) : '[{ "id": 1 }, { "id": 2 }, { "id": 3 }]');
  const [dataset, setDataset] = useState(typeof fe === 'string' ? fe : fe && typeof fe === 'object' && !Array.isArray(fe) ? String((fe as { dataset?: unknown }).dataset ?? '') : '');
  const conditions = useMemo(() => new Set(steps.filter((s) => s.type === 'condition').map((s) => s.id)), [steps]);
  const onCondition = (step.dependsOn ?? []).some((d) => conditions.has(d));

  const commitIf = () => cond.trim() !== (asText(raw.if) ?? '').trim() && void update({ if: cond.trim() || null });
  const commitTimes = () => {
    const n = Number(times);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) return toastError(new Error('Repeat runs a step 0 to 10000 times'));
    if (n !== raw.repeat) void update({ repeat: n, forEach: null });
  };
  const commitRows = () => {
    let v: unknown;
    try {
      v = JSON.parse(rows);
    } catch (e) {
      return toastError(new Error(`The rows are not JSON: ${(e as Error).message}`));
    }
    if (!Array.isArray(v)) return toastError(new Error('The rows are a JSON list: [{ "id": 1 }, { "id": 2 }]'));
    if (JSON.stringify(v) !== JSON.stringify(fe)) void update({ forEach: v, repeat: null });
  };
  const commitDataset = () => dataset.trim() && void update({ forEach: { dataset: dataset.trim() }, repeat: null });
  const changeMode = (m: LoopMode) => {
    setMode(m);
    if (m === 'once') void update({ repeat: null, forEach: null });
    else if (m === 'times') void update({ repeat: Number(times) || 3, forEach: null });
    else if (m === 'list') commitRows();
  };

  return (
    <>
      <SectionTitle>Runs</SectionTitle>
      {step.type !== 'condition' && (
        <Field label="Only if" hint="Left empty, the step always runs; false skips it (and the steps that wait only for it)">
          <div onBlur={commitIf} data-inspector-if>
            <VarInput ariaLabel="Only if" value={cond} onChange={setCond} onEnter={commitIf} placeholder="status == 200" />
          </div>
        </Field>
      )}
      {onCondition && (
        <Field label="Branch" hint="Which output of the condition it waits for this step is on">
          <Select
            aria-label="Branch"
            data-inspector-branch
            value={step.when === undefined ? '' : String(step.when)}
            onChange={(e) => void update({ when: e.target.value === '' ? null : e.target.value === 'true' })}
          >
            <option value="">either (runs after the condition)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </Select>
        </Field>
      )}
      {step.type !== 'condition' && (
        <Field label="Repeat" hint="{{$index}} (0, 1, …), {{$item}} and each row's fields are the step's variables; at most 10000 times">
          <div className="grid gap-1.5" data-inspector-repeat>
            <Select aria-label="Repeat" value={mode} onChange={(e) => changeMode(e.target.value as LoopMode)} className="w-48">
              <option value="once">Once</option>
              <option value="times">A number of times</option>
              <option value="list">For each row of a list</option>
              <option value="dataset">For each row of a dataset</option>
            </Select>
            {mode === 'times' && (
              <Input
                type="number"
                min={0}
                max={10000}
                aria-label="Times"
                value={times}
                onChange={(e) => setTimes(e.target.value)}
                onBlur={commitTimes}
                onKeyDown={(e) => e.key === 'Enter' && commitTimes()}
              />
            )}
            {mode === 'list' && (
              <Textarea autoGrow maxRows={8} className="mono text-xs" aria-label="Rows" data-inspector-rows value={rows} onChange={(e) => setRows(e.target.value)} onBlur={commitRows} />
            )}
            {mode === 'dataset' && (
              <Input
                aria-label="Dataset"
                placeholder="datasets/users.csv (relative to this file)"
                value={dataset}
                onChange={(e) => setDataset(e.target.value)}
                onBlur={commitDataset}
                onKeyDown={(e) => e.key === 'Enter' && commitDataset()}
              />
            )}
          </div>
        </Field>
      )}
    </>
  );
}

/** What the flow returns (`output:` at the top of the file): name → template, for sub-flows and flows exposed to agents. */
export function FlowOutputEditor({ output, update }: { output?: Record<string, unknown>; update(output: Record<string, string> | null): Promise<unknown> }) {
  const [rows, setRows] = useCommitted<KeyValue[]>(asRows(output), (r) => update(asMap(r)));
  return (
    <div className="grid gap-1.5" data-flow-output>
      <SectionTitle>Output</SectionTitle>
      <p className="text-xs text-muted">What the flow returns after a run: a sub-flow step gets these values, and a flow exposed as an MCP tool returns them.</p>
      <KeyValueEditor rows={rows} onChange={setRows} keyPlaceholder="Name" valuePlaceholder="{{variable}}" />
    </div>
  );
}
