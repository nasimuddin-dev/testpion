import { Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useSticky } from '../../lib/sticky';
import { call, type NormalizedError } from '../../api';
import { useApp } from '../../store';
import type { ProviderConfig } from '../../types';
import { formatCost, formatMs, uid } from '../../lib/format';
import { CheckList } from '../../components/Results';
import { Button, Empty, IconButton, Split } from '../../components/ui';
import { ChatResult, useDraft, ModelPicker, Params, responseFormat, parseExpected, PromptEditor, ModelError, AddKeyHint, NoProviders } from './common';

export function Compare({ providers, onSetUp }: { providers: ProviderConfig[]; onSetUp(): void }) {
  const [d, set] = useDraft();
  const [running, setRunning] = useState(false);
  const [results, setResults] = useSticky<Array<ChatResult & { error?: NormalizedError }>>('ai:compare:results', []);
  const env = useApp((s) => s.environment);
  const rows = d.compare.length ? d.compare : providers.slice(0, 2).map((p) => ({ provider: p.id, name: p.defaultModel ?? '' }));
  const providerName = (id: string) => providers.find((p) => p.id === id || p.name === id)?.name ?? id;
  const run = async () => {
    setRunning(true);
    const expected = parseExpected(d.expected);
    try {
      setResults(
        await call('ai.compare', {
          requestId: uid('cmp-'),
          models: rows,
          system: d.system || undefined,
          prompt: d.prompt,
          input: d.input,
          temperature: d.temperature,
          topP: d.topP,
          maxTokens: d.maxTokens,
          seed: d.seed,
          responseFormat: responseFormat(d),
          environment: env,
          evaluators: [...d.evaluators, ...(expected !== undefined ? [{ type: 'similarity', name: 'similarity to expected' }] : [])],
          expected,
        }),
      );
    } finally {
      setRunning(false);
    }
  };
  if (!providers.length) return <NoProviders onSetUp={onSetUp} />;
  return (
    <Split id="ai-compare" initial={38}>
      <div className="h-full flex flex-col">
        <div className="p-2 border-b border-line flex flex-col gap-2">
          <div className="text-xs font-semibold text-muted">Models</div>
          {rows.map((m, i) => {
            const p = providers.find((x) => x.id === m.provider);
            return (
              <div key={i}>
                <div className="flex items-center gap-1">
                  <ModelPicker providers={providers} provider={m.provider} model={m.name} onChange={(p, name) => set({ compare: rows.map((x, j) => (j === i ? { provider: p, name } : x)) })} />
                  <IconButton label="Remove model" onClick={() => set({ compare: rows.filter((_, j) => j !== i) })}>
                    <Trash2 size={13} />
                  </IconButton>
                </div>
                {p && !p.hasKey && p.needsKey && <AddKeyHint provider={p} />}
              </div>
            );
          })}
          <div className="flex gap-2">
            <Button size="sm" icon={<Plus size={12} />} onClick={() => set({ compare: [...rows, { provider: providers[0]!.id, name: providers[0]!.defaultModel ?? '' }] })}>
              Add model
            </Button>
            <Button size="sm" variant="primary" icon={<Play size={12} />} loading={running} onClick={run} className="ml-auto">
              Run comparison
            </Button>
          </div>
          <Params d={d} set={set} />
        </div>
        <div className="flex-1 min-h-0">
          <PromptEditor d={d} set={set} />
        </div>
      </div>
      <div className="h-full overflow-auto">
        {results.length ? (
          <>
            <p className="px-3 py-2 text-xs text-muted border-b border-line">
              Measurements only — there is no universal ranking. Choose the criteria that matter for your use case and inspect the underlying outputs.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted border-b border-line">
                  <th className="px-3 py-2 w-40">Metric</th>
                  {results.map((r, i) => (
                    <th key={i} className="px-3 py-2">
                      {providerName(r.provider)} · <span className="mono">{r.model}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Latency', (r: ChatResult) => formatMs(r.timing?.totalMs), (r: ChatResult) => r.timing?.totalMs],
                    ['Time to first token', (r: ChatResult) => formatMs(r.timing?.firstTokenMs), (r: ChatResult) => r.timing?.firstTokenMs],
                    ['Input tokens', (r: ChatResult) => r.usage?.inputTokens, (r: ChatResult) => r.usage?.inputTokens],
                    ['Output tokens', (r: ChatResult) => r.usage?.outputTokens, (r: ChatResult) => r.usage?.outputTokens],
                    ['Est. cost', (r: ChatResult) => formatCost(r.costUsd), (r: ChatResult) => r.costUsd],
                    ['Valid JSON', (r: ChatResult) => (d.format === 'text' ? '–' : r.isJson ? '✓' : '✗')],
                    ['Schema valid', (r: ChatResult) => (r.schemaValid === undefined ? '–' : r.schemaValid ? '✓' : '✗')],
                    ['Checks passed', (r: ChatResult) => (r.checks ? `${r.checks.filter((c) => c.passed).length}/${r.checks.length}` : '–')],
                  ] as Array<[string, (r: ChatResult) => React.ReactNode, ((r: ChatResult) => number | undefined)?]>
                ).map(([label, fn, num], row, all) => {
                  // numeric rows get a bar per model, relative to the largest value in the row
                  const max = num ? Math.max(0, ...results.filter((r) => !r.error).map((r) => num(r) ?? 0)) : 0;
                  // the fastest and the cheapest are marked (lower is better there; for tokens it depends)
                  const values = num && LOWER_IS_BETTER[label] ? results.map((r) => (r.error ? undefined : num(r))).filter((v): v is number => v !== undefined) : [];
                  const best = values.length > 1 && new Set(values).size > 1 ? Math.min(...values) : undefined;
                  return (
                    <tr key={label} className="border-b border-line">
                      <td className="px-3 py-1.5 text-muted">{label}</td>
                      {results.map((r, i) => {
                        // a model that failed: its error once, across the measurements, with the way to fix it
                        if (r.error)
                          return row === 0 ? (
                            <td key={i} rowSpan={all.length} className="px-3 py-2 align-top">
                              <ModelError error={r.error} />
                            </td>
                          ) : null;
                        const v = num ? num(r) : undefined;
                        return (
                          <td key={i} className="px-3 py-1.5 tabular-nums">
                            {fn(r)}
                            {best !== undefined && v === best && <span className="ml-1.5 text-[0.7rem] text-ok">{LOWER_IS_BETTER[label]}</span>}
                            {v !== undefined && max > 0 && (
                              <span aria-hidden className="block h-1 mt-1 w-full max-w-40 rounded-full bg-hover/70 overflow-hidden">
                                <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(3, (v / max) * 100)}%` }} />
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr className="align-top">
                  <td className="px-3 py-2 text-muted">Output</td>
                  {results.map((r, i) => (
                    <td key={i} className="px-3 py-2">
                      {r.error ? <span className="text-muted">—</span> : <pre className="whitespace-pre-wrap text-xs mono max-h-80 overflow-auto">{r.text}</pre>}
                    </td>
                  ))}
                </tr>
                <tr className="align-top">
                  <td className="px-3 py-2 text-muted">Evaluation</td>
                  {results.map((r, i) => (
                    <td key={i} className="px-1 py-1">
                      {r.checks && <CheckList checks={r.checks} compact />}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </>
        ) : (
          <Empty
            title="Compare models side by side"
            actions={[{ label: 'Run comparison', icon: <Play size={12} />, onClick: run, loading: running }]}
          >
            Add the models on the left, then run: the same prompt goes to each, and the table compares latency, tokens, cost, structured-output validity and your evaluators; the fastest and the cheapest are marked.
          </Empty>
        )}
      </div>
    </Split>
  );
}

/** The measurements where less is better, and what the best one is called. */
const LOWER_IS_BETTER: Record<string, string> = { Latency: 'fastest', 'Time to first token': 'fastest', 'Est. cost': 'cheapest' };
