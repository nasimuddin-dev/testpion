import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TrySample, Trace } from '@testpion/core';
import { call } from '../../api';
import { attempt } from '../../store';
import { useRpc } from '../../lib/use-rpc';
import type { CheckResult, TestResult } from '../../types';
import { CheckList } from '../Results';
import { AiAction } from '../ai/AiAction';
import { TraceView } from '../TraceView';
import { Badge, Button, cx, Modal, Spinner } from '../ui';
import { RagLabelControl } from './RagLabelControl';
import { ChunkImage } from './ChunkImage';
import { RagTryDialog } from './RagTryDialog';

interface Sample {
  result: TestResult;
  sample: (TrySample & { warnings?: string[] }) | null;
}
type Item = { text: string; ok: boolean; evidence?: string; rating?: number };

const itemsOf = (c: CheckResult | undefined): Item[] => ((c?.metadata as { items?: Item[] } | undefined)?.items ?? []).filter((i) => typeof i.text === 'string');

/**
 * One sample of a RAG run, seen through one metric (a click on a cell of the matrix): the question, the answer, the lane of
 * retrieved contexts (rank, id, score, this metric's verdict on each chunk, and the gold chunks that were never retrieved),
 * the claims of the answer with the document each was found in, then the card of every metric with its evidence, judge and
 * prompt version, and "Try again with another judge". The review (good / bad) sits here too.
 */
export function RagSampleDetail({ runId, resultId, focus, target, judge, onClose }: { runId: string; resultId: string; focus?: string; target?: string; judge?: { provider?: string; model?: string }; onClose(): void }) {
  const data = useRpc<Sample>('rag.sample', { runId, resultId });
  const [mark, setMark] = useState<string>();
  const [tryCheck, setTryCheck] = useState<CheckResult>();
  const [doc, setDoc] = useState<string>();
  const [showTrace, setShowTrace] = useState(false);
  const [trace, setTrace] = useState<Trace | null>();
  const traceId = data?.result.traceId;
  // the raw exchange with the RAG system: the trace of the call (the request, the response, the streamed events), fetched when asked for
  useEffect(() => {
    if (showTrace && traceId && trace === undefined) void call<Trace | null>('traces.get', { id: traceId }).then((t) => setTrace(t ?? null), () => setTrace(null));
  }, [showTrace, traceId, trace]);
  if (!data)
    return (
      <Modal title="Sample" onClose={onClose}>
        <Spinner />
      </Modal>
    );
  const { result, sample } = data;
  const checks = [...result.checks].sort((a, b) => Number((b.name || b.type) === focus) - Number((a.name || a.type) === focus));
  const focused = result.checks.find((c) => (c.name || c.type) === focus);
  const verdicts = new Map(itemsOf(focused).map((i) => [i.text, i]));
  const gold = new Set(sample?.referenceIds ?? []);
  const got = new Set((sample?.contexts ?? []).map((c) => c.id));
  const missed = [...gold].filter((g) => !got.has(g));
  const failure = (result.metadata?.rag as { failure?: { class: string; reason: string } } | undefined)?.failure;
  // the claims the focused metric judged, each with the document its evidence names
  const claims = itemsOf(focused).filter((i) => !(sample?.contexts ?? []).some((c) => c.id === i.text));
  const review = async (rating: 'good' | 'bad') => {
    await attempt(async () => {
      await call('runs.review', { runId, resultId, rating });
      setMark(rating);
    });
  };
  return (
    <>
      <Modal
        title={
          <span className="flex items-center gap-2">
            {result.name}
            <Badge tone={result.status === 'passed' ? 'ok' : 'bad'}>{result.status}</Badge>
            {failure && (
              <Badge tone="warn" title={failure.reason}>
                {failure.class}
              </Badge>
            )}
          </span>
        }
        onClose={onClose}
        width={980}
        footer={
          <>
            <AiAction
              className="mr-auto"
              label="Explain this sample"
              hint="The AI reads the question, the answer, the retrieved documents and what each metric said, and tells you which part failed (the retriever, the generator or a metric) and what to change first. It proposes nothing."
              request={() => ({
                task: 'rag-explain-sample',
                title: 'Explain this sample',
                context: {
                  question: sample?.question,
                  answer: sample?.answer,
                  reference: sample?.reference,
                  referenceIds: sample?.referenceIds,
                  contexts: (sample?.contexts ?? []).map((c, i) => ({ rank: i + 1, id: c.id, score: c.score, text: c.text.slice(0, 1200) })),
                  failure,
                  metrics: result.checks.map((c) => ({ name: c.name || c.type, score: c.score, passed: c.passed, message: c.message.slice(0, 300), items: itemsOf(c).slice(0, 12) })),
                },
              })}
            />
            <span className="text-xs text-muted">Review this result</span>
            <Button size="sm" icon={<ThumbsUp size={12} />} variant={mark === 'good' ? 'primary' : undefined} onClick={() => void review('good')} data-rag-review="good">
              Good
            </Button>
            <Button size="sm" icon={<ThumbsDown size={12} />} variant={mark === 'bad' ? 'primary' : undefined} onClick={() => void review('bad')} data-rag-review="bad">
              Bad
            </Button>
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <div className="grid gap-3 text-sm" data-rag-detail>
          {failure && <div className="text-xs text-muted">Why it scored low: {failure.reason}</div>}
          {sample ? (
            <>
              <div>
                <div className="text-xs text-muted">Question</div>
                <div data-rag-detail-question>{sample.question}</div>
              </div>
              <div>
                <div className="text-xs text-muted">Answer{sample.reference ? ' · reference below' : ''}</div>
                <div data-rag-detail-answer>{sample.answer}</div>
                {sample.reference && <div className="text-xs text-muted mt-1">Reference: {sample.reference}</div>}
              </div>
              {(sample.record?.turns?.length ?? 0) > 0 && (
                <div data-rag-transcript>
                  <div className="text-xs text-muted">The conversation ({sample.record!.turns!.filter((t) => t.role === 'assistant').length} answers from your system)</div>
                  <ol className="mt-1 space-y-1">
                    {sample.record!.turns!.map((t, i) => (
                      <li key={i} className={cx('rounded px-2 py-1 border-l-2', t.role === 'user' ? 'border-line bg-surface/40' : 'border-accent/60')}>
                        <span className="text-xs text-muted mr-2">{t.role === 'user' ? 'User' : t.role === 'tool' ? 'Tool' : 'System'}</span>
                        {t.content}
                        {(t.toolCalls?.length ?? 0) > 0 && <div className="text-xs mono text-muted mt-0.5">called {t.toolCalls!.map((c) => `${c.name}(${JSON.stringify(c.arguments)})`).join(', ')}</div>}
                        {(t.contexts?.length ?? 0) > 0 && <div className="text-xs text-muted">retrieved {t.contexts!.map((c) => c.id).join(', ')}</div>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {(sample.toolCalls ?? sample.record?.toolCalls ?? []).length > 0 && !(sample.record?.turns?.length ?? 0) && (
                <div data-rag-toolcalls>
                  <div className="text-xs text-muted">Tool calls the system made</div>
                  <ol className="mt-1 text-xs mono">
                    {(sample.toolCalls ?? sample.record?.toolCalls ?? []).map((c, i) => (
                      <li key={i}>
                        {i + 1}. {c.name}({JSON.stringify(c.arguments)})
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {claims.length > 0 && (
                <div data-rag-claims>
                  <div className="text-xs text-muted">What {focus} judged in the answer</div>
                  <ul className="mt-1 space-y-1">
                    {claims.map((c, i) => {
                      const ref = /\[([^\]]+)\]/.exec(c.evidence ?? '')?.[1];
                      return (
                        <li key={i} className={cx('flex items-start gap-2 rounded px-2 py-1', c.ok ? 'bg-ok/5' : 'bg-bad/5')}>
                          <Badge tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'ok' : 'not'}</Badge>
                          <span className="flex-1">
                            {c.text}
                            {c.evidence && <span className="text-muted"> — {c.evidence.replace(/\[[^\]]+\]\s*/, '')}</span>}
                          </span>
                          {ref && (
                            <button className="text-xs mono text-accent hover:underline" onClick={() => setDoc(ref)} data-rag-claim-doc={ref}>
                              {ref}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              <div>
                <div className="text-xs text-muted">Retrieved contexts ({sample.contexts?.length ?? 0}){gold.size ? ` · gold: ${[...gold].join(', ')}` : ''}</div>
                <table className="w-full text-xs mt-1" data-rag-lane>
                  <tbody>
                    {(sample.contexts ?? []).map((c, i) => {
                      const cid = c.id ?? `doc-${i + 1}`;
                      const v = verdicts.get(cid);
                      return (
                        <tr key={cid} className={cx('border-t border-line/60 align-top', doc === cid && 'bg-accent/10')} data-rag-chunk={cid}>
                          <td className="py-1 pr-2 text-muted tabular-nums">{i + 1}</td>
                          <td className="pr-2 mono whitespace-nowrap">{cid}</td>
                          <td className="pr-2 text-muted tabular-nums">{c.score ?? ''}</td>
                          <td className="pr-2 whitespace-nowrap">
                            {gold.has(cid) && <Badge tone="ok">gold</Badge>} {v && <Badge tone={v.ok ? 'ok' : 'bad'}>{v.rating !== undefined ? `rated ${v.rating}` : v.ok ? 'useful' : 'not useful'}</Badge>}
                          </td>
                          <td>
                            {c.text.length > 220 ? `${c.text.slice(0, 219)}…` : c.text}
                            {c.image && <ChunkImage image={c.image} />}
                          </td>
                        </tr>
                      );
                    })}
                    {missed.map((id) => (
                      <tr key={id} className="border-t border-line/60 text-bad" data-rag-missed={id}>
                        <td className="py-1 pr-2">—</td>
                        <td className="pr-2 mono">{id}</td>
                        <td colSpan={3}>gold chunk that was not retrieved</td>
                      </tr>
                    ))}
                    {!sample.contexts?.length && missed.length === 0 && (
                      <tr>
                        <td className="text-muted py-1">Nothing was retrieved.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="text-muted">This result holds no stored sample (the system did not answer).{result.error ? ` ${result.error.message}` : ''}</div>
          )}
          <div className="border border-line rounded-lg" data-rag-cards>
            <CheckList
              checks={checks}
              compact
              actions={(c) => (
                <>
                  {c.score !== undefined && <RagLabelControl runId={runId} resultId={resultId} metric={c.name || c.type} />}
                  {((c.name || c.type) === focus || c.source === 'ai-judge') && (
                    <Button size="sm" className="ml-auto" onClick={() => setTryCheck(c)} data-rag-tryagain>
                      Try again with another judge
                    </Button>
                  )}
                </>
              )}
            />
          </div>
          {traceId && (
            <details className="text-xs" onToggle={(e) => e.currentTarget.open && setShowTrace(true)} data-rag-trace>
              <summary className="cursor-pointer text-muted">The call to your RAG system: request, response, events and timing</summary>
              <div className="h-80 mt-1 border border-line rounded-lg overflow-hidden">{trace ? <TraceView trace={trace} /> : trace === null ? <div className="p-3 text-muted">No trace was stored for this call.</div> : <Spinner />}</div>
            </details>
          )}
          {sample && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">The sample as stored</summary>
              <pre className="mono p-2 max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify({ ...sample, warnings: sample.warnings }, null, 2)}</pre>
            </details>
          )}
        </div>
      </Modal>
      {tryCheck && sample && <RagTryDialog check={{ type: tryCheck.type, ...((tryCheck.metadata as { mode?: string } | undefined)?.mode ? { mode: (tryCheck.metadata as { mode: string }).mode } : {}) }} target={target} initial={sample} judge={judge} onClose={() => setTryCheck(undefined)} />}
    </>
  );
}
