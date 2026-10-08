import { Download, ScanSearch, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { type AssistantApplied, toastError, useApp } from '../store';
import { parseYaml } from '../lib/yaml';
import { SidePicker, type Side } from './OpenApiDiffDialog';
import { Badge, Button, cx, Field, Input, Metric, MetricGrid, ModalOrPanel, Select, Toggle } from './ui';
import { BarRow, ChartCard, Swatch } from './charts';
import { downloadContent } from '../lib/files';

interface OperationCoverage {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  deprecated: boolean;
  calls: number;
  statuses: Record<string, number>;
  documentedStatuses: string[];
  testedStatuses: string[];
  untestedStatuses: string[];
  undocumentedStatuses: string[];
  covered: boolean;
  examples: string[];
}
interface CoverageResult {
  report: {
    title?: string;
    version?: string;
    summary: { operations: number; covered: number; operationPct: number; documentedStatuses: number; testedStatuses: number; statusPct: number; observations: number; unmatched: number };
    operations: OperationCoverage[];
    unmatched: Array<{ method: string; path: string; count: number; statuses: number[] }>;
  };
  sources: { runs: Array<{ id: string; name: string; startedAt: string }>; historyEntries: number };
  markdown: string;
}

type Filter = 'all' | 'gaps' | 'uncovered';

/**
 * API coverage (same engine as `testpion coverage` and the api_coverage MCP tool): which operations
 * and documented responses of an OpenAPI document the test runs and request history exercised.
 */
/** Tests written by the assistant for the coverage gaps, saved as tests/coverage/<api>-gaps.yaml (a free name). */
async function saveGapTests(api: string, code: string): Promise<AssistantApplied> {
  let parsed: unknown;
  try {
    parsed = parseYaml(code);
  } catch {
    return 'it is not valid YAML';
  }
  const tests = Array.isArray(parsed) ? parsed : (parsed as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(tests) || !tests.length) return 'it has no tests';
  const slug = api.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'api';
  let path = `coverage/${slug}-gaps.yaml`;
  for (let i = 2; i < 100; i++) {
    const taken = await call('tests.read', { path }).then(
      () => true,
      () => false,
    );
    if (!taken) break;
    path = `coverage/${slug}-gaps-${i}.yaml`;
  }
  await call('tests.write', { path, content: code.endsWith('\n') ? code : `${code}\n` });
  return { done: `Saved tests/${path}`, action: { label: 'Open', onClick: () => useApp.getState().openIntent('tests', { path }) } };
}

export function ApiCoverageDialog({ runId, spec: initialSpec, onClose, inline }: { runId?: string; spec?: string; onClose(): void; /** In an API definition's tab: that document, no dialog. */ inline?: boolean }) {
  const [specs, setSpecs] = useState<string[]>([]);
  const [spec, setSpec] = useState<Side>({ path: undefined });
  const [useRun, setUseRun] = useState(true);
  const [history, setHistory] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CoverageResult>();
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    void call<string[]>('openapi.specs').then((s) => {
      setSpecs(s);
      setSpec(initialSpec && s.includes(initialSpec) ? { path: initialSpec } : s.length ? { path: s[0] } : { url: '' });
    });
  }, []);
  const ready = !!(spec.path || spec.url?.trim() || spec.text) && (useRun || history);

  const analyse = async () => {
    setBusy(true);
    try {
      setResult(
        await call<CoverageResult>('openapi.coverage', {
          spec,
          runs: useRun && runId ? [runId] : undefined,
          history: history ? 1000 : undefined,
          baseUrl,
        }),
      );
    } catch (e) {
      setResult(undefined);
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => {
    const ops = result?.report.operations ?? [];
    if (filter === 'uncovered') return ops.filter((o) => !o.covered);
    if (filter === 'gaps') return ops.filter((o) => !o.covered || o.untestedStatuses.length || o.undocumentedStatuses.length);
    return ops;
  }, [result, filter]);

  const suggest = () => {
    if (!result) return;
    const gaps = result.report.operations
      .filter((o) => !o.covered || o.untestedStatuses.length)
      .slice(0, 40)
      .map((o) => ({ method: o.method, path: o.path, operationId: o.operationId, summary: o.summary, called: o.covered, untestedStatuses: o.untestedStatuses }));
    const api = result.report.title;
    useApp.getState().set({ assistant: { task: 'suggest-coverage-tests', title: 'Tests for the coverage gaps', context: { api, gaps }, apply: { label: 'Save as a test file', run: (code) => saveGapTests(api ?? 'api', code) } } });
    onClose();
  };

  const s = result?.report.summary;
  const tone = (p: number) => (p >= 80 ? 'ok' : p >= 50 ? 'warn' : 'bad');
  return (
    <ModalOrPanel
      inline={inline}
      title="API coverage"
      onClose={onClose}
      width={880}
      footer={
        <>
          {result && (
            <>
              <Button icon={<Download size={13} />} onClick={() => downloadContent(`api-coverage${result.report.title ? `-${result.report.title.replace(/[^\w-]+/g, '-')}` : ''}.md`, result.markdown, { type: 'text/markdown' })}>
                Markdown
              </Button>
              <Button icon={<Sparkles size={13} />} disabled={!result.report.operations.some((o) => !o.covered || o.untestedStatuses.length)} onClick={suggest}>
                Suggest tests with AI
              </Button>
            </>
          )}
          <Button variant="primary" icon={<ScanSearch size={13} />} loading={busy} disabled={!ready} onClick={() => void analyse()}>
            Analyse
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Which operations and documented responses of an OpenAPI document your tests and requests exercised, and which they never did. In CI: <span className="mono">testpion coverage specs/api.yaml --min 80</span>.
        </p>
        {!(inline && initialSpec) && <SidePicker label="OpenAPI document" specs={specs} value={spec} onChange={setSpec} />}
        <div className="flex flex-wrap items-end gap-4">
          <Toggle checked={useRun} onChange={setUseRun} label={runId ? 'This run' : 'Latest run'} />
          <Toggle checked={history} onChange={setHistory} label="Request history (last 1,000)" />
          <Field label="Only requests under (optional)" className="flex-1 min-w-60">
            <Input className="mono" placeholder="http://localhost:4010" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
        </div>
        {result && s && (
          <div className="flex flex-col gap-3 min-h-0">
            <MetricGrid compact>
              <Metric label="Operations covered" value={`${s.operationPct}%`} tone={tone(s.operationPct)} sub={`${s.covered} of ${s.operations}`} />
              <Metric label="Documented responses seen" value={`${s.statusPct}%`} tone={tone(s.statusPct)} sub={`${s.testedStatuses} of ${s.documentedStatuses}`} />
              <Metric label="Requests analysed" value={s.observations} sub={s.unmatched ? `${s.unmatched} not in the document` : 'all in the document'} />
            </MetricGrid>
            <CoverageByTag operations={result.report.operations} />
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="truncate">
                From {[result.sources.runs.map((r) => r.name).join(', '), result.sources.historyEntries ? `${result.sources.historyEntries} history entries` : ''].filter(Boolean).join(' + ') || 'no requests'}
              </span>
              <Select className="ml-auto h-7 w-44" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Show">
                <option value="all">All operations</option>
                <option value="gaps">Gaps only</option>
                <option value="uncovered">Never called</option>
              </Select>
            </div>
            <div className={cx('overflow-auto rounded-lg border border-line', !inline && 'max-h-[42vh]')}>
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-panel text-xs text-muted text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium">Operation</th>
                    <th className="px-3 py-2 font-medium w-16 text-right">Calls</th>
                    <th className="px-3 py-2 font-medium">Responses seen</th>
                    <th className="px-3 py-2 font-medium">Not seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={`${o.method} ${o.path}`} className="border-t border-line/60 align-top">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cx('w-2 h-2 rounded-full shrink-0', !o.covered ? 'bg-bad' : o.untestedStatuses.length ? 'bg-warn' : 'bg-ok')} title={!o.covered ? 'Never called' : o.untestedStatuses.length ? 'Some documented responses not seen' : 'Covered'} />
                          <span className={cx('mono text-[0.72rem] font-bold w-14 shrink-0', `method-${o.method}`)}>{o.method}</span>
                          <span className="mono text-xs truncate">{o.path}</span>
                          {o.deprecated && <Badge tone="warn">deprecated</Badge>}
                        </div>
                        {(o.summary || o.examples.length > 0) && (
                          <div className="text-xs text-muted pl-[5.25rem] truncate">
                            {o.summary}
                            {o.examples.length > 0 && <span>{o.summary ? ' · ' : ''}by {o.examples.join(', ')}</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{o.calls || '–'}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(o.statuses).map(([code, n]) => (
                            <Badge key={code} tone={o.undocumentedStatuses.includes(code) ? 'warn' : 'ok'} title={o.undocumentedStatuses.includes(code) ? 'Not documented for this operation' : undefined}>
                              {code} ×{n}
                            </Badge>
                          ))}
                          {!Object.keys(o.statuses).length && <span className="text-muted">–</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {o.untestedStatuses.map((code) => (
                            <Badge key={code}>{code}</Badge>
                          ))}
                          {!o.untestedStatuses.length && <span className="text-muted">–</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-muted">
                        Nothing to show with this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {result.report.unmatched.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">{s.unmatched} request(s) to paths the document doesn't describe</summary>
                <ul className="mt-1 flex flex-col gap-0.5 mono text-xs">
                  {result.report.unmatched.map((u) => (
                    <li key={`${u.method} ${u.path}`}>
                      {u.method} {u.path} ×{u.count}
                      {u.statuses.length ? ` (${u.statuses.join(', ')})` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </ModalOrPanel>
  );
}

/** Operations covered per tag (the first tag of each operation), as a proportional bar per tag, least covered first. */
function CoverageByTag({ operations }: { operations: OperationCoverage[] }) {
  const tags = new Map<string, { covered: number; total: number }>();
  for (const o of operations) {
    const t = o.tags[0] ?? 'untagged';
    const e = tags.get(t) ?? tags.set(t, { covered: 0, total: 0 }).get(t)!;
    e.total++;
    if (o.covered) e.covered++;
  }
  if (tags.size < 2) return null;
  const rows = [...tags].sort((a, b) => a[1].covered / a[1].total - b[1].covered / b[1].total || b[1].total - a[1].total);
  return (
    <ChartCard title="By tag" aside="operations covered" legend={<><Swatch color="var(--ok)" label="Called" /><Swatch color="var(--bad)" label="Never called" /></>}>
      <div className="flex flex-col gap-1.5">
        {rows.map(([t, v]) => (
          <BarRow
            key={t}
            label={t}
            labelClass="w-32"
            segments={[
              { value: v.covered, color: 'var(--ok)' },
              { value: v.total - v.covered, color: 'var(--bad)' },
            ]}
            of={v.total}
            right={`${v.covered}/${v.total}`}
            title={`${t}: ${v.covered} of ${v.total} operations called`}
          />
        ))}
      </div>
    </ChartCard>
  );
}
