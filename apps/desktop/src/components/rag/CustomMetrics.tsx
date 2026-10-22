import { Copy, FlaskConical, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CUSTOM_METRIC_KINDS, type CustomMetricKind } from '@testpion/shared';
import { call } from '../../api';
import { confirmAction, promptText, toastError, useApp, attempt } from '../../store';
import { confirmDelete } from '../../lib/undo-delete';
import { useRpc } from '../../lib/use-rpc';
import { touchesFiles, type DataChangedEvent } from '../../lib/data-changed';
import { plural } from '../../lib/format';
import { useDebounced } from '../ui';
import { AiAction } from '../ai/AiAction';
import { CodeEditor } from '../CodeEditor';
import { Badge, Button, Callout, Empty, Field, Input, Modal, Select, Spinner, cx } from '../ui';
import { DagTreeEditor } from './DagTreeEditor';
import { RagTryDialog } from './RagTryDialog';

interface Problem {
  level: 'error' | 'warning';
  message: string;
  field?: string;
}
export interface CustomMetricRow {
  id: string;
  metric: string;
  name: string;
  description: string;
  kind?: CustomMetricKind;
  version?: number;
  examples: number;
  registered: boolean;
  problems: Problem[];
}
interface ExampleResult {
  index: number;
  name?: string;
  expect: 'pass' | 'fail';
  got: 'pass' | 'fail' | 'na';
  ok: boolean;
  score?: number;
  message: string;
}

/** A `data.changed` that touched metric files (or replaced the whole workspace): the only change that alters the metric catalogue, so the lists reload for no other. */
export function metricFilesChanged(e: DataChangedEvent | undefined): boolean {
  // metric files are of the watcher's kind "other"; its paths say which (50 paths or more are cut: assume metrics among them)
  if (!touchesFiles(e, ['other'])) return false;
  if (!e?.kinds || e.kinds.includes('workspace')) return true;
  return !e.paths || e.paths.length >= 50 || e.paths.some((p) => p.startsWith('metrics/'));
}

/** The custom metrics of the workspace (metrics/*.yaml): kept as the engine reads them, listed with what is wrong with each. */
function useCustomMetrics() {
  return useRpc<{ kinds: typeof CUSTOM_METRIC_KINDS; metrics: CustomMetricRow[] }>('rag.customMetrics', undefined, { reloadOn: ['data.changed'], reloadIf: metricFilesChanged, keep: true });
}

const KIND_LABEL = Object.fromEntries(CUSTOM_METRIC_KINDS.map((k) => [k.id, k.label])) as Record<string, string>;

/** The list of the workspace's custom metrics, with New. Opening one (or New) opens the editor. */
export function CustomMetricsList({ selected, onSelect, onNew }: { selected?: string; onSelect(id: string): void; onNew(): void }) {
  const data = useCustomMetrics();
  if (!data)
    return (
      <div className="p-4 grid place-items-center">
        <Spinner />
      </div>
    );
  return (
    <div className="flex flex-col min-h-0 h-full" data-rag-metrics-list>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-line">
        <span className="text-xs font-semibold text-muted uppercase tracking-wide">Custom metrics</span>
        <Button size="sm" className="ml-auto" icon={<Plus size={12} />} onClick={onNew} data-rag-metric-new>
          New metric
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {data.metrics.map((m) => (
          <button key={m.id} className={cx('w-full text-left px-3 py-2 border-b border-line/60 text-sm', selected === m.id ? 'bg-accent-soft' : 'hover:bg-hover')} onClick={() => onSelect(m.id)} data-rag-metric-row={m.id}>
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{m.name}</span>
              {m.kind && <Badge tone={m.kind === 'judge' || m.kind === 'checklist' || m.kind === 'dag' ? 'judge' : 'ok'}>{KIND_LABEL[m.kind]}</Badge>}
              {!m.registered && <Badge tone="bad">not usable</Badge>}
            </div>
            <div className="text-xs text-muted truncate">
              custom/{m.id} · v{m.version ?? '?'} · {m.examples} example{m.examples === 1 ? '' : 's'}
            </div>
            {m.problems[0] && <div className={cx('text-xs truncate', m.problems[0].level === 'error' ? 'text-bad' : 'text-warn')}>{m.problems[0].message}</div>}
          </button>
        ))}
        {!data.metrics.length && (
          <Empty title="No custom metrics yet" actions={[{ label: 'New metric', icon: <Plus size={13} />, onClick: onNew }]}>
            A custom metric is a file in your workspace (metrics/&lt;id&gt;.yaml) that scores an answer by your rule: a criterion a judge decides, a checklist, deterministic rules, a formula over other metrics, closeness to good answers, or a small script. It appears in the metric picker beside the built-in ones.
          </Empty>
        )}
      </div>
    </div>
  );
}

/**
 * The editor of one metric file: its YAML (the file is the source; the engine checks it as you type and says what is
 * wrong), the examples it must agree with (Run examples), Try on one sample, a draft written by the AI from a description,
 * Save and Delete (which says what uses the metric). Opened from AI Lab ▸ RAG ▸ Metrics and from the metric picker.
 */
export function MetricEditor({ id: initial, kind: startKind, onClose, onSaved }: { id?: string; kind?: CustomMetricKind; onClose(): void; onSaved?(id: string): void }) {
  const env = useApp((s) => s.environment);
  const [id, setId] = useState(initial ?? '');
  const [kind, setKind] = useState<CustomMetricKind>(startKind ?? 'judge');
  const [text, setText] = useState<string>();
  const [exists, setExists] = useState(!!initial);
  const [saved, setSaved] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [results, setResults] = useState<ExampleResult[]>();
  const [running, setRunning] = useState(false);
  const [trying, setTrying] = useState(false);
  const [description, setDescription] = useState('');
  const checked = useDebounced(text, 350);
  const validId = /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
  // the text of the file, or a starting file of the chosen kind
  useEffect(() => {
    if (initial === undefined && !id) {
      setText(undefined);
      return;
    }
    if (!validId) return;
    void call<{ text: string; exists: boolean }>('rag.customMetric.get', { id, kind }).then((r) => {
      setText(r.text);
      setSaved(r.exists ? r.text : '');
      setExists(r.exists);
      setResults(undefined);
    }, toastError);
    // the text is read when the id or the kind of a NEW metric changes, not as it is edited
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, validId ? id : '', exists ? '' : kind]);
  useEffect(() => {
    if (checked === undefined || !validId) return;
    let live = true;
    void call<{ problems: Problem[] }>('rag.customMetric.check', { text: checked, id }).then((r) => live && setProblems(r.problems), () => undefined);
    return () => {
      live = false;
    };
  }, [checked, id, validId]);
  const errors = problems.filter((p) => p.level === 'error');
  const dirty = text !== undefined && text !== saved;
  const save = async () => {
    if (text === undefined) return;
    await attempt(async () => {
      await call('rag.customMetric.save', { id, text, overwrite: exists });
      setSaved(text);
      setExists(true);
      useApp.getState().toast(`Saved metrics/${id}.yaml`, 'success');
      onSaved?.(id);
    });
  };
  // a copy under another id (the file name is the id evaluations name, so a rename is a copy and a delete)
  const saveAs = async () => {
    if (text === undefined) return;
    const next = (await promptText('Save as', { message: 'Id of the copy (lower-case letters, digits, hyphens)', value: `${id}-copy`, okLabel: 'Save a copy' }))?.trim().toLowerCase();
    if (!next || next === id) return;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(next)) return void toastError(new Error(`"${next}" is not a metric id: lower-case letters, digits and hyphens`));
    await attempt(async () => {
      const copy = /^id:.*$/m.test(text) ? text.replace(/^id:.*$/m, `id: ${next}`) : `id: ${next}\n${text}`;
      await call('rag.customMetric.save', { id: next, text: copy, overwrite: false });
      useApp.getState().toast(`Saved metrics/${next}.yaml`, 'success');
      onSaved?.(next);
      onClose();
    });
  };
  const runExamples = async () => {
    if (text === undefined) return;
    // a judged metric spends judge tokens: say how many calls, and what goes to the judge, before the first one
    if (judged && !(await confirmAction({ title: 'Run the examples with your judge model?', message: `About ${plural(exampleCount || 1, 'judge call')}: one for each example${fileKind === 'checklist' ? ' and checklist item' : fileKind === 'dag' ? ' and question of the tree it visits' : ''}.`, detail: 'Each example is sent to your judge model, with secrets, tokens and personal data masked, and the model is paid for it. Rule, formula and script metrics run on this computer for free.', confirmLabel: 'Run examples' }))) return;
    setRunning(true);
    try {
      setResults((await call<{ results: ExampleResult[] }>('rag.customMetric.examples', { text, id, environment: env })).results);
    } catch (e) {
      toastError(e);
    } finally {
      setRunning(false);
    }
  };
  // Discard, Esc and the X all ask when there are unsaved edits: the YAML is gone once the editor closes
  const close = async () => {
    if (dirty && !(await confirmAction({ title: 'Discard your changes?', message: `The edits to ${id ? `metrics/${id}.yaml` : 'this new metric'} have not been saved.`, detail: 'Close the editor and lose them, or go back and Save.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true }))) return;
    onClose();
  };
  const remove = async () => {
    const used = await call<{ evaluations: string[]; formulas: string[] }>('rag.customMetric.usedBy', { id }).catch(() => ({ evaluations: [], formulas: [] }));
    // only a workspace that is a repository keeps the file's history; elsewhere the Undo of the toast is the way back
    const inRepository = await call<{ repository: boolean }>('git.status').then((s) => s.repository, () => false);
    const where = [...used.evaluations.map((n) => `evaluation “${n}”`), ...used.formulas.map((n) => `formula metric ${n}`)];
    // the registry's delete policy of a metric: it asks first (what names it is listed), then its message still offers Undo
    await confirmDelete({
      kind: 'metric',
      name: id,
      title: `Delete ${id}?`,
      message: `metrics/${id}.yaml is deleted.${where.length ? ` It is used by ${where.join(', ')}; they will not find it.` : ''}`,
      detail: inRepository ? 'The file is in git: its history keeps it. Undo puts it back right away.' : 'Undo puts it back right away; after that the file is gone for good.',
      done: false,
      run: async () => {
        const was = saved;
        await call('rag.customMetric.delete', { id });
        onSaved?.(id);
        onClose();
        if (was)
          useApp.getState().toast(`Deleted metrics/${id}.yaml`, 'info', undefined, {
            undo: async () => {
              await call('rag.customMetric.save', { id, text: was, overwrite: false });
              onSaved?.(id);
            },
            restored: `metrics/${id}.yaml is back`,
          });
      },
    });
  };
  // the kind of the file in the editor: a saved one says it in its text, a new one is the chosen kind
  const fileKind = (text !== undefined ? /^kind:\s*['"]?([a-z-]+)/m.exec(text)?.[1] : undefined) ?? kind;
  const judged = fileKind === 'judge' || fileKind === 'checklist' || fileKind === 'dag';
  // how many examples the file holds: a judged metric asks the judge once for each (a checklist: once for each item), which spends tokens
  const [exampleCount, setExampleCount] = useState(0);
  useEffect(() => {
    if (!judged || checked === undefined) return setExampleCount(0);
    let live = true;
    void import('yaml').then(({ parse }) => {
      try {
        const n = (parse(checked) as { examples?: unknown[] } | null)?.examples?.length ?? 0;
        if (live) setExampleCount(n);
      } catch {
        if (live) setExampleCount(0);
      }
    });
    return () => {
      live = false;
    };
  }, [judged, checked]);
  const failing = useMemo(() => results?.filter((r) => !r.ok).length ?? 0, [results]);
  return (
    <>
      <Modal
        title={initial ? `Metric · ${id}` : 'New custom metric'}
        onClose={() => void close()}
        onSubmit={() => void save()}
        width={900}
        footer={
          <>
            {exists && (
              <Button variant="ghost" icon={<Trash2 size={13} />} className="mr-auto" onClick={() => void remove()} data-rag-metric-delete>
                Delete
              </Button>
            )}
            {exists && (
              <Button icon={<Copy size={13} />} disabled={text === undefined || errors.length > 0} reason={errors.length ? 'Fix the errors first' : 'Nothing to copy yet'} onClick={() => void saveAs()} title="Save the file as a copy under another id; this one stays" data-rag-metric-saveas>
                Save as…
              </Button>
            )}
            <Button onClick={() => void close()}>{dirty ? 'Discard' : 'Close'}</Button>
            <Button variant="primary" disabled={!validId || text === undefined || errors.length > 0 || !dirty} reason={!validId ? 'The id needs letters, digits and dashes only' : errors.length ? 'Fix the errors first' : 'Nothing changed yet'} onClick={() => void save()} data-rag-metric-save>
              Save
            </Button>
          </>
        }
      >
        <div className="grid gap-3 text-sm" data-rag-metric-editor>
          {!initial && (
            <div className="grid grid-cols-[14rem_1fr] gap-2 [&>*]:min-w-0">
              <Field label="Id (the file name)" hint="lower-case letters, digits, hyphens">
                <Input className="mono" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="clinic-tone" autoFocus data-rag-metric-id />
              </Field>
              <Field label="Type of metric" hint={CUSTOM_METRIC_KINDS.find((k) => k.id === kind)?.summary}>
                <Select value={kind} onChange={(e) => setKind(e.target.value as CustomMetricKind)} disabled={exists} data-rag-metric-kind>
                  {CUSTOM_METRIC_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {!initial && !validId && id && <Callout tone="bad">The id is lower-case letters, digits and hyphens, starting with a letter or a digit.</Callout>}
          <div className="flex items-center gap-2 flex-wrap">
            <Input className="flex-1 min-w-56" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe what good looks like, then let the AI draft the file …" aria-label="What good looks like" data-rag-metric-describe />
            <AiAction
              label="Draft with AI"
              hint="The AI writes the file with 4 to 8 examples; TestPion checks it (a rule or script metric must agree with every example) and offers it as a proposal you review."
              request={() => ({ task: 'rag-draft-metric', title: 'Draft a custom metric', question: description || undefined, context: { kind, id: id || undefined, existing: [], file: text } })}
            />
          </div>
          {fileKind === 'dag' && text !== undefined && <DagTreeEditor text={text} onText={setText} />}
          <div className="h-80 border border-line rounded-lg overflow-hidden" data-rag-metric-yaml>
            {text === undefined ? (
              <div className="h-full grid place-items-center text-muted text-sm">{validId ? <Spinner /> : 'Give the metric an id to start from a file of its kind.'}</div>
            ) : (
              <CodeEditor language="yaml" value={text} onChange={setText} path={`metrics/${id || 'new'}.yaml`} />
            )}
          </div>
          {problems.length > 0 && (
            <ul className="text-xs grid gap-0.5" data-rag-metric-problems>
              {problems.map((p, i) => (
                <li key={i} className={p.level === 'error' ? 'text-bad' : 'text-warn'}>
                  {p.level === 'error' ? 'Error' : 'Note'}
                  {p.field ? ` · ${p.field}` : ''}: {p.message}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" icon={running ? <Spinner /> : <Play size={12} />} disabled={!validId || errors.length > 0 || text === undefined || running} reason={running ? 'Still running' : !validId ? 'The id needs letters, digits and dashes only' : 'Fix the errors first'} onClick={() => void runExamples()} data-rag-metric-examples>
              Run examples
            </Button>
            <span className="text-xs text-muted" role="status" aria-live="polite" data-rag-metric-cost>
              {judged ? `About ${plural(exampleCount || 1, 'judge call')}${fileKind === 'checklist' || fileKind === 'dag' ? ' or more' : ''}: spends tokens` : 'Runs on this computer: free'}
            </span>
            <Button size="sm" icon={<FlaskConical size={12} />} disabled={!exists || dirty} reason="Save the metric first" onClick={() => setTrying(true)} title={exists && !dirty ? 'Try the saved metric on one sample' : 'Save the metric to try it on a sample'} data-rag-metric-try>
              Try on a sample
            </Button>
            {results && (
              <span className={cx('text-xs', failing ? 'text-bad' : 'text-ok')} data-rag-metric-agree>
                agrees with {results.length - failing}/{results.length} examples
              </span>
            )}
          </div>
          {results && (
            <table className="w-full text-xs" data-rag-metric-example-results>
              <tbody>
                {results.map((r) => (
                  <tr key={r.index} className="border-t border-line/60 align-top">
                    <td className="py-1 pr-2 text-muted">#{r.index + 1}</td>
                    <td className="pr-2">{r.name ?? ''}</td>
                    <td className="pr-2 whitespace-nowrap">
                      should {r.expect} <Badge tone={r.ok ? 'ok' : 'bad'}>{r.got === 'na' ? 'no score' : r.got}</Badge>
                    </td>
                    <td className="pr-2 tabular-nums">{r.score ?? ''}</td>
                    <td className="text-muted">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Modal>
      {trying && <RagTryDialog check={{ type: `custom/${id}` }} onClose={() => setTrying(false)} />}
    </>
  );
}
