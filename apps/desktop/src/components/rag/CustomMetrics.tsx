import { FlaskConical, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CUSTOM_METRIC_KINDS, type CustomMetricKind } from '@testpion/shared';
import { call } from '../../api';
import { confirmAction, toastError, useApp } from '../../store';
import { useRpc } from '../../lib/use-rpc';
import { useDebounced } from '../ui';
import { AiAction } from '../ai/AiAction';
import { CodeEditor } from '../CodeEditor';
import { Badge, Button, Callout, Empty, Field, Input, Modal, Select, Spinner, cx } from '../ui';
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

/** The custom metrics of the workspace (metrics/*.yaml): kept as the engine reads them, listed with what is wrong with each. */
export function useCustomMetrics() {
  return useRpc<{ kinds: typeof CUSTOM_METRIC_KINDS; metrics: CustomMetricRow[] }>('rag.customMetrics', undefined, { reloadOn: ['data.changed'], keep: true });
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
          <button key={m.id} className={cx('w-full text-left px-3 py-2 border-b border-line/60 text-sm', selected === m.id ? 'bg-accent/10' : 'hover:bg-hover')} onClick={() => onSelect(m.id)} data-rag-metric-row={m.id}>
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium">{m.name}</span>
              {m.kind && <Badge tone={m.kind === 'judge' || m.kind === 'checklist' ? 'judge' : 'ok'}>{KIND_LABEL[m.kind]}</Badge>}
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
    try {
      await call('rag.customMetric.save', { id, text, overwrite: exists });
      setSaved(text);
      setExists(true);
      useApp.getState().toast(`Saved metrics/${id}.yaml`, 'success');
      onSaved?.(id);
    } catch (e) {
      toastError(e);
    }
  };
  const runExamples = async () => {
    if (text === undefined) return;
    setRunning(true);
    try {
      setResults((await call<{ results: ExampleResult[] }>('rag.customMetric.examples', { text, id, environment: env })).results);
    } catch (e) {
      toastError(e);
    } finally {
      setRunning(false);
    }
  };
  const remove = async () => {
    const used = await call<{ evaluations: string[]; formulas: string[] }>('rag.customMetric.usedBy', { id }).catch(() => ({ evaluations: [], formulas: [] }));
    const where = [...used.evaluations.map((n) => `evaluation “${n}”`), ...used.formulas.map((n) => `formula metric ${n}`)];
    const yes = await confirmAction({ title: `Delete ${id}?`, message: `metrics/${id}.yaml is deleted.${where.length ? ` It is used by ${where.join(', ')}; they will not find it.` : ''}`, detail: 'The file is in git: its history keeps it.', confirmLabel: 'Delete', danger: true });
    if (!yes) return;
    try {
      await call('rag.customMetric.delete', { id });
      onSaved?.(id);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  const judged = kind === 'judge' || kind === 'checklist';
  const failing = useMemo(() => results?.filter((r) => !r.ok).length ?? 0, [results]);
  return (
    <>
      <Modal
        title={initial ? `Metric · ${id}` : 'New custom metric'}
        onClose={onClose}
        width={900}
        footer={
          <>
            {exists && (
              <Button variant="ghost" icon={<Trash2 size={13} />} className="mr-auto" onClick={() => void remove()} data-rag-metric-delete>
                Delete
              </Button>
            )}
            <Button onClick={onClose}>{dirty ? 'Discard' : 'Close'}</Button>
            <Button variant="primary" disabled={!validId || text === undefined || errors.length > 0 || !dirty} onClick={() => void save()} data-rag-metric-save>
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
              <Field label="Kind" hint={CUSTOM_METRIC_KINDS.find((k) => k.id === kind)?.summary}>
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
            <Button size="sm" icon={running ? <Spinner /> : <Play size={12} />} disabled={!validId || errors.length > 0 || text === undefined || running} onClick={() => void runExamples()} title={judged ? 'Each example is judged by your judge model (it spends tokens)' : 'Each example runs through the metric (free)'} data-rag-metric-examples>
              Run examples
            </Button>
            <Button size="sm" icon={<FlaskConical size={12} />} disabled={!exists || dirty} onClick={() => setTrying(true)} title={exists && !dirty ? 'Try the saved metric on one sample' : 'Save the metric to try it on a sample'} data-rag-metric-try>
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
