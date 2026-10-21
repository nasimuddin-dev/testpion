import { useEffect, useMemo, useState } from 'react';
import type { CaptureResult } from '@testpion/core';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { Badge, Button, Callout, Field, Input, Modal, Select, Spinner, Toggle } from '../ui';

type From = 'history' | 'debugger' | 'har' | 'run' | 'exchanges' | 'messages';

interface Sources {
  targets: Array<{ id: string; name: string; protocol: string; mapped: string; problems: string[] }>;
  sessions: string[];
  hars: string[];
  messages?: string[];
  runs: Array<{ id: string; name: string; startedAt: string; total: number }>;
  debuggerExchanges: number;
}

/** What the dialog starts from: the calls a view already chose (History's entries, the Debugger's selection). */
export interface CaptureInitial {
  from?: From;
  history?: string[];
  exchanges?: string[];
  session?: string;
  run?: string;
  har?: string;
  messages?: string;
  /** In words: "12 History entries". */
  label?: string;
}

const FROM_LABEL: Record<From, string> = { history: 'Recent History entries', debugger: 'A saved Debugger session', har: 'A HAR file of the workspace', messages: 'A WebSocket message log of the workspace', run: 'An evaluation run (its answered samples)', exchanges: 'Exchanges of the Debugger' };

/**
 * Create a RAG dataset from real calls (History, a saved Debugger session, a HAR file, a WebSocket message log, an evaluation run, the Debugger's
 * exchanges): choose the RAG target the calls went to (its request says where the question is, its mapping reads the answer and
 * the retrieved contexts), preview what the dataset would hold and what was left out and why, then create it. Personal data
 * and secrets are masked before anything is written; nothing is sent to a model. One dialog for every place that offers it.
 */
export function RagCaptureDialog({ onClose, onCreated, initial }: { onClose(): void; onCreated?(dataset: string): void; initial?: CaptureInitial }) {
  const [sources, setSources] = useState<Sources>();
  const [from, setFrom] = useState<From>(initial?.from ?? 'history');
  const [target, setTarget] = useState('');
  const [pick, setPick] = useState({ session: initial?.session ?? '', har: initial?.har ?? '', messages: initial?.messages ?? '', run: initial?.run ?? '' });
  const [name, setName] = useState('');
  const [dedupe, setDedupe] = useState(true);
  const [success, setSuccess] = useState(true);
  const [maskPii, setMaskPii] = useState(true);
  const [questionsOnly, setQuestionsOnly] = useState(false);
  const [limit, setLimit] = useState('');
  const [sample, setSample] = useState('');
  const [questionPath, setQuestionPath] = useState('');
  const [result, setResult] = useState<CaptureResult>();
  const [busy, setBusy] = useState<'preview' | 'create'>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void call<Sources>('rag.capture.sources').then((s) => {
      setSources(s);
      setTarget((t) => t || s.targets.find((x) => !x.problems.length)?.id || s.targets[0]?.id || '');
      setPick((p) => ({ session: p.session || s.sessions[0] || '', har: p.har || s.hars[0] || '', messages: p.messages || s.messages?.[0] || '', run: p.run || s.runs[0]?.id || '' }));
    }, toastError);
  }, []);
  const fixed = !!(initial?.history || initial?.exchanges);
  const params = useMemo(() => {
    const n = (s: string) => (/^\d+$/.test(s.trim()) && Number(s) > 0 ? Number(s) : undefined);
    return {
      from,
      target: from === 'run' ? undefined : target || undefined,
      history: initial?.history,
      exchanges: initial?.exchanges,
      session: pick.session || undefined,
      har: pick.har || undefined,
      messages: from === 'messages' ? pick.messages || undefined : undefined,
      run: pick.run || undefined,
      name: name.trim() || undefined,
      dedupe: dedupe ? ('newest' as const) : false,
      limit: n(limit),
      sample: n(sample),
      onlySuccess: success,
      maskPii,
      asQuestions: questionsOnly,
      questionPath: questionPath.trim() || undefined,
    };
  }, [from, target, initial, pick, name, dedupe, limit, sample, success, maskPii, questionsOnly, questionPath]);
  // a change of the choices makes the preview stale
  useEffect(() => setResult(undefined), [params]);
  const needsTarget = from !== 'run';
  const ready = !needsTarget || !!target;
  const run = async (what: 'preview' | 'create') => {
    setBusy(what);
    setError(undefined);
    try {
      const r = await call<CaptureResult>(what === 'preview' ? 'rag.capture.preview' : 'rag.capture.create', params);
      setResult(r);
      if (what === 'create' && r.written) {
        useApp.getState().toast(`Created ${r.written.path} with ${r.written.rows} records`, 'success');
        onCreated?.(r.written.path);
        onClose();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const rep = result?.report;
  return (
    <Modal
      title="Create dataset from captured calls"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={!ready || !!busy} icon={busy === 'preview' ? <Spinner /> : undefined} onClick={() => void run('preview')} data-rag-capture-preview>
            Preview
          </Button>
          <Button variant="primary" disabled={!ready || !!busy || !result || !rep?.records} icon={busy === 'create' ? <Spinner /> : undefined} onClick={() => void run('create')} data-rag-capture-create>
            Create dataset
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-rag-capture-dialog>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Calls from" hint={fixed ? initial?.label : undefined}>
            {fixed ? (
              <div className="h-8 flex items-center text-muted">{initial?.label ?? FROM_LABEL[from]}</div>
            ) : (
              <Select value={from} onChange={(e) => setFrom(e.target.value as From)} aria-label="Source of the calls" data-rag-capture-from>
                {(['history', 'debugger', 'har', 'messages', 'run'] as const).map((f) => (
                  <option key={f} value={f}>
                    {FROM_LABEL[f]}
                  </option>
                ))}
                {!!sources?.debuggerExchanges && <option value="exchanges">{FROM_LABEL.exchanges} ({sources.debuggerExchanges})</option>}
              </Select>
            )}
          </Field>
          {needsTarget && (
            <Field label="RAG target the calls went to" hint="Its request says where the question is; its mapping reads the answer and the retrieved contexts">
              <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="RAG target" data-rag-capture-target>
                {!sources?.targets.length && <option value="">No RAG target yet</option>}
                {sources?.targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.problems.length ? ' (needs fixing)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!fixed && from === 'debugger' && (
            <Field label="Saved session">
              <Select value={pick.session} onChange={(e) => setPick({ ...pick, session: e.target.value })} aria-label="Saved session">
                {!sources?.sessions.length && <option value="">No saved session (Debugger ▸ Save session)</option>}
                {sources?.sessions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!fixed && from === 'har' && (
            <Field label="HAR file">
              <Select value={pick.har} onChange={(e) => setPick({ ...pick, har: e.target.value })} aria-label="HAR file">
                {!sources?.hars.length && <option value="">No .har file in datasets/, imports/ or har/</option>}
                {sources?.hars.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!fixed && from === 'messages' && (
            <Field label="Message log" hint="Saved from the message log of a WebSocket tab (the down arrow, JSON Lines) into messages/ of the workspace">
              <Select value={pick.messages} onChange={(e) => setPick({ ...pick, messages: e.target.value })} aria-label="Message log" data-rag-capture-messages>
                {!sources?.messages?.length && <option value="">No message log in messages/, imports/ or har/</option>}
                {sources?.messages?.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!fixed && from === 'run' && (
            <Field label="Run">
              <Select value={pick.run} onChange={(e) => setPick({ ...pick, run: e.target.value })} aria-label="Run">
                {sources?.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {new Date(r.startedAt).toLocaleString()} · {r.total}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Dataset name" hint="datasets/<name>.jsonl; empty: captured-<date>">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="captured" aria-label="Dataset name" data-rag-capture-name />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <Toggle checked={maskPii} onChange={setMaskPii} label="Mask personal data (emails, phones, card and ID numbers)" title="Secrets and tokens are always masked, whatever this says" />
          <Toggle checked={dedupe} onChange={setDedupe} label="One record per question (the newest)" />
          <Toggle checked={success} onChange={setSuccess} label="Only calls that answered 2xx" />
          <Toggle checked={questionsOnly} onChange={setQuestionsOnly} label="Questions only (the target answers them again)" title="Leaves out the captured answers and contexts, so running the dataset calls the target" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="At most (newest)">
            <Input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" placeholder="all" aria-label="At most" />
          </Field>
          <Field label="Random sample of">
            <Input value={sample} onChange={(e) => setSample(e.target.value)} inputMode="numeric" placeholder="no sampling" aria-label="Random sample" />
          </Field>
          <Field label="Question path" hint="Only if the target does not say: $.input.q or query:q">
            <Input value={questionPath} onChange={(e) => setQuestionPath(e.target.value)} placeholder="from the target" aria-label="Question path" />
          </Field>
        </div>
        {error && <Callout tone="bad">{error}</Callout>}
        {rep && (
          <div className="grid gap-2" data-rag-capture-report>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge tone={rep.records ? 'ok' : 'bad'}>{rep.records} records</Badge>
              <span className="text-muted">
                {rep.read} calls read · {rep.matched} matched{rep.questionAt ? ` · question read from the ${rep.questionAt}` : ''}
              </span>
              {rep.masked.strings > 0 && <Badge title={Object.entries(rep.masked.kinds).map(([k, c]) => `${k} ${c}`).join(', ')}>{rep.masked.strings} texts masked</Badge>}
              {rep.deduped > 0 && <Badge>{rep.deduped} repeated questions merged</Badge>}
              {rep.sampled > 0 && <Badge>{rep.sampled} left out by the limit or sample</Badge>}
            </div>
            {rep.skipped.map((s) => (
              <div key={s.reason} className="text-xs text-muted">
                Skipped {s.count} × {s.reason}
                {s.examples.length ? ` (${s.examples.join(', ')})` : ''}
              </div>
            ))}
            {rep.warnings.map((w) => (
              <Callout key={w} tone="warn">
                {w}
              </Callout>
            ))}
            {!!result?.preview.length && (
              <div className="max-h-56 overflow-auto border border-line rounded-lg">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-panel text-left text-muted">
                    <tr>
                      <th className="p-1.5 font-medium">Question</th>
                      <th className="p-1.5 font-medium">Answer</th>
                      <th className="p-1.5 font-medium w-16">Contexts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.preview.map((r) => (
                      <tr key={r.id} className="border-t border-line align-top">
                        <td className="p-1.5 max-w-64 truncate" title={r.question}>
                          {r.question}
                        </td>
                        <td className="p-1.5 max-w-72 truncate text-muted" title={r.answer}>
                          {r.answer ?? '—'}
                        </td>
                        <td className="p-1.5">{r.contexts?.length ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <p className="text-xs text-muted">Nothing is sent to a model. Secrets are always masked and request headers and cookies are never kept; the dataset holds the question, the answer and the retrieved contexts.</p>
      </div>
    </Modal>
  );
}
