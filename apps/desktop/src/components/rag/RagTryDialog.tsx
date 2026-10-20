import { Eye, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { TryResult, TrySample } from '@testpion/core';
import { asError, call } from '../../api';
import { toastError, useApp } from '../../store';
import { formatCost } from '../../lib/format';
import type { CheckConfig, ProviderConfig } from '../../types';
import { AiPreviewDialog } from '../ai/AiPreviewDialog';
import { EvidenceList } from '../Results';
import { Badge, Button, Callout, Field, Input, Modal, Segmented, Select, Spinner, Textarea } from '../ui';

type Source = 'probe' | 'type';

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/**
 * "Try on one sample": ONE metric on ONE sample, here and now. The inputs it reads are listed with the ones the sample
 * lacks; the exact judge prompts it would send are shown before anything is sent ("What will be sent", the shared preview
 * dialog); then Run scores the sample and shows the score against the pass mark, the items with their evidence, the
 * judge and what it cost. The sample is asked of the evaluation's RAG target, typed in, or the one a result holds
 * (`initial`, from the matrix: "Try again with another judge"). One dialog for the picker, the matrix and the Connect dialog.
 */
export function RagTryDialog({
  check,
  target,
  question,
  initial,
  judge,
  onClose,
}: {
  /** The metric as a check config: { type, threshold?, mode? … }. */
  check: CheckConfig;
  /** The RAG target (library id) to ask. */
  target?: string;
  /** A question to start with (the first record of the dataset). */
  question?: string;
  /** A sample to start with (a stored result's). */
  initial?: TrySample;
  /** The evaluation's judge, started with and changeable here. */
  judge?: { provider?: string; model?: string };
  onClose(): void;
}) {
  const env = useApp((s) => s.environment);
  const [source, setSource] = useState<Source>(initial || !target ? 'type' : 'probe');
  const [q, setQ] = useState(initial?.question ?? question ?? '');
  const [sample, setSample] = useState<TrySample>(initial ?? {});
  const [contexts, setContexts] = useState((initial?.contexts ?? []).map((c) => c.text).join('\n'));
  const [ids, setIds] = useState((initial?.referenceIds ?? []).join(', '));
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [j, setJ] = useState(judge ?? {});
  const [busy, setBusy] = useState<'probe' | 'run' | undefined>();
  const [dry, setDry] = useState<TryResult>();
  const [dryError, setDryError] = useState<string>();
  const [result, setResult] = useState<TryResult>();
  const [shown, setShown] = useState<number>();
  useEffect(() => {
    void call<ProviderConfig[]>('ai.providers').then(setProviders, () => undefined);
  }, []);

  // the sample as typed (contexts one per line, gold ids separated by commas)
  const effective: TrySample = useMemo(
    () =>
      source === 'probe'
        ? sample
        : { ...sample, question: q || undefined, contexts: lines(contexts).map((text) => ({ text })), referenceIds: ids.split(',').map((x) => x.trim()).filter(Boolean) },
    [source, sample, q, contexts, ids],
  );
  const judgeParam = j.provider || j.model ? j : undefined;
  const metric = String(check.type);

  // what the metric reads and what it would send, whenever the sample changes (nothing is sent)
  useEffect(() => {
    if (!effective.answer && !effective.question) return;
    let live = true;
    const t = setTimeout(() => {
      call<TryResult>('rag.metric.try', { metric, options: { ...check, type: undefined }, sample: effective, judge: judgeParam, dryRun: true, environment: env }).then(
        (r) => live && (setDry(r), setDryError(undefined)),
        (e) => live && (setDry(undefined), setDryError(asError(e).message)),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(effective), metric, JSON.stringify(judgeParam), JSON.stringify(check)]);

  const probe = async () => {
    if (!target || !q.trim()) return;
    setBusy('probe');
    setResult(undefined);
    try {
      const r = await call<TryResult & { sample: TrySample }>('rag.metric.try', { metric, options: { ...check, type: undefined }, target, question: q, judge: judgeParam, dryRun: true, environment: env });
      setSample({ ...r.sample, question: q });
      setDry(r);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const run = async () => {
    setBusy('run');
    try {
      setResult(await call<TryResult>('rag.metric.try', { metric, options: { ...check, type: undefined }, sample: effective, judge: judgeParam, environment: env }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(undefined);
    }
  };

  const judged = (dry?.metric.kind ?? 'judged') !== 'deterministic' && (dry?.willSend?.length ?? 0) > 0;
  const res = result?.result;
  const items = (res?.metadata as { items?: unknown[] } | undefined)?.items;
  return (
    <>
      <Modal
        title={
          <span className="flex items-center gap-2">
            Try on one sample · <span className="mono">{metric}</span>
            {dry && <Badge tone={dry.metric.kind === 'judged' ? 'judge' : 'default'}>{dry.metric.kind === 'deterministic' ? 'no model' : dry.metric.kind}</Badge>}
          </span>
        }
        onClose={onClose}
        width={900}
        footer={
          <>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" icon={busy === 'run' ? <Spinner /> : <Play size={13} />} disabled={busy !== undefined || !effective.answer} onClick={() => void run()} data-rag-try-run>
              {judged ? 'Run (asks the judge)' : 'Run'}
            </Button>
          </>
        }
      >
        <div className="grid gap-3 text-sm" data-rag-try-dialog>
          <div className="flex items-center gap-2 flex-wrap">
            <Segmented
              label="Sample"
              size="xs"
              value={source}
              onChange={(v) => setSource(v)}
              options={[
                { value: 'probe', label: 'Ask the RAG target', title: target ? undefined : 'Choose a RAG target for the evaluation first' },
                { value: 'type', label: 'Type a sample' },
              ]}
            />
            {judged && (
              <>
                <span className="text-xs text-muted ml-auto">Judge</span>
                <Select className="h-7 min-h-7 py-0 text-xs max-w-44" aria-label="Judge for this try" value={j.provider ?? ''} onChange={(e) => setJ({ provider: e.target.value || undefined, model: providers.find((p) => p.id === e.target.value)?.defaultModel || undefined })}>
                  <option value="">{judge?.provider ? 'The evaluation’s judge' : 'The AI settings’ large model'}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </div>
          {source === 'probe' ? (
            <div className="grid gap-2">
              <div className="flex gap-2">
                <Input className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A question for your RAG system" aria-label="Question to ask" data-rag-try-question onKeyDown={(e) => e.key === 'Enter' && void probe()} />
                <Button icon={busy === 'probe' ? <Spinner /> : undefined} disabled={!target || !q.trim() || busy !== undefined} onClick={() => void probe()} data-rag-try-probe>
                  Ask
                </Button>
              </div>
              {sample.answer !== undefined && (
                <div className="rounded-lg border border-line p-2 text-xs max-h-40 overflow-auto" data-rag-try-sample>
                  <div>
                    <span className="text-muted">Answer </span>
                    {sample.answer}
                  </div>
                  <div className="text-muted mt-1">{sample.contexts?.length ?? 0} retrieved contexts</div>
                </div>
              )}
              <Field label="Reference answer (optional)">
                <Input value={sample.reference ?? ''} onChange={(e) => setSample({ ...sample, reference: e.target.value || undefined })} aria-label="Reference answer" />
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 [&>*]:min-w-0">
              <Field label="Question">
                <Input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Sample question" data-rag-try-qtext />
              </Field>
              <Field label="Reference answer">
                <Input value={sample.reference ?? ''} onChange={(e) => setSample({ ...sample, reference: e.target.value || undefined })} aria-label="Reference answer" />
              </Field>
              <Field label="Answer">
                <Textarea rows={3} value={sample.answer ?? ''} onChange={(e) => setSample({ ...sample, answer: e.target.value })} aria-label="Sample answer" data-rag-try-answer />
              </Field>
              <Field label="Retrieved contexts (one per line)">
                <Textarea rows={3} value={contexts} onChange={(e) => setContexts(e.target.value)} aria-label="Sample contexts" data-rag-try-contexts />
              </Field>
              <Field label="Gold chunk ids (comma separated)">
                <Input value={ids} onChange={(e) => setIds(e.target.value)} aria-label="Gold ids" />
              </Field>
            </div>
          )}
          {dryError && <Callout tone="bad">{dryError}</Callout>}
          {dry && dry.missing.length > 0 && (
            <Callout tone="warn" data-rag-try-missing>
              {dry.missing.map((m) => m.message).join('; ')}.
            </Callout>
          )}
          {dry?.willSend && dry.willSend.length > 0 && (
            <div className="rounded-lg border border-line p-2 grid gap-1" data-rag-try-willsend>
              <div className="text-xs text-muted">What will be sent to the judge · nothing has been sent</div>
              {dry.willSend.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="mono">{c.version}</span>
                  <span className="text-muted">
                    ≈ {c.preview.estimate.inputTokens.toLocaleString()} tokens in{c.preview.estimate.priceKnown ? `, up to ${formatCost(c.preview.estimate.maxCostUsd ?? 0)}` : ''}
                  </span>
                  {c.cached && <Badge tone="ok">verdict cached: no call</Badge>}
                  <Button size="sm" className="ml-auto" icon={<Eye size={12} />} onClick={() => setShown(i)} data-rag-try-show>
                    Show the prompt
                  </Button>
                </div>
              ))}
            </div>
          )}
          {res && (
            <div className="rounded-lg border border-line p-3 grid gap-2" data-rag-try-result>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone={res.passed ? 'ok' : 'bad'}>{res.passed ? 'passed' : 'failed'}</Badge>
                {res.score !== undefined && (
                  <span className="font-semibold tabular-nums" data-rag-try-score>
                    {res.score}
                  </span>
                )}
                {result?.metric.threshold !== undefined && <span className="text-xs text-muted">pass mark {(res.metadata as { threshold?: number } | undefined)?.threshold ?? result.metric.threshold}</span>}
                {result?.usage && (
                  <span className="text-xs text-muted ml-auto">
                    judge: {result.usage.calls} call(s), {(result.usage.inputTokens + result.usage.outputTokens).toLocaleString()} tokens, {formatCost(result.usage.costUsd)}
                    {result.usage.cached ? ' (cached)' : ''}
                  </span>
                )}
              </div>
              <div>{res.message}</div>
              {res.explanation && <div className="text-xs border-l-2 border-judge/50 pl-2 text-muted">{res.explanation}</div>}
              {items && <EvidenceList check={res} />}
            </div>
          )}
        </div>
      </Modal>
      {shown !== undefined && dry?.willSend?.[shown] && <AiPreviewDialog request={{ title: `${dry.metric.name} (${dry.willSend[shown]!.version})` }} load={() => Promise.resolve(dry.willSend![shown]!.preview)} onClose={() => setShown(undefined)} />}
    </>
  );
}
