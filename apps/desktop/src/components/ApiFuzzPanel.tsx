import { Bug, ChevronDown, ChevronRight, ExternalLink, Play, Sparkles, Square, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call, on } from '../api';
import { useApp } from '../store';
import { TreeBadge } from './CollectionTree';
import { Badge, Button, Empty, Field, Input, Toggle } from './ui';

type Verdict = 'server-error' | 'accepted-invalid' | 'rejected-valid' | 'undocumented-status' | 'not-authorized' | 'not-judged' | 'ok' | 'failed';

interface FuzzResult {
  case: { id: string; operation: string; name: string; mutation: string; expect: 'accept' | 'reject'; request: { method: string; url: string; body?: { content?: string } } & Record<string, unknown> };
  status?: number;
  durationMs?: number;
  verdict: Verdict;
  message: string;
  bodyPreview?: string;
}

interface FuzzReport {
  operations: number;
  cases: number;
  results: FuzzResult[];
  counts: Record<Verdict, number>;
  serverErrors: number;
}

const GROUPS: Array<{ verdict: Verdict; title: string; tone: 'bad' | 'warn' | 'default' }> = [
  { verdict: 'server-error', title: 'Server errors', tone: 'bad' },
  { verdict: 'accepted-invalid', title: 'Invalid input accepted', tone: 'warn' },
  { verdict: 'undocumented-status', title: 'Undocumented statuses', tone: 'default' },
  { verdict: 'not-authorized', title: 'Not authorized', tone: 'warn' },
  { verdict: 'rejected-valid', title: 'Valid example rejected', tone: 'default' },
  { verdict: 'failed', title: 'Could not send', tone: 'bad' },
];

function Row({ r }: { r: FuzzResult }) {
  const [open, setOpen] = useState(false);
  const method = r.case.operation.split(' ')[0]!;
  return (
    <li className="border-t border-line/60" data-fuzz-verdict={r.verdict}>
      <button className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-panel" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} className="shrink-0 text-muted" /> : <ChevronRight size={13} className="shrink-0 text-muted" />}
        <TreeBadge label={method} className={`method-${method}`} />
        <span className="mono text-sm shrink-0">{r.case.operation.slice(method.length + 1)}</span>
        <span className="text-sm truncate">{r.case.name}</span>
        {r.status !== undefined && (
          <span className="ml-auto shrink-0">
            <Badge tone={r.status >= 500 ? 'bad' : r.status >= 400 ? 'default' : 'ok'}>{r.status}</Badge>
          </span>
        )}
      </button>
      {open && (
        <div className="px-8 pb-3 grid gap-2 text-sm">
          <p>{r.message}</p>
          <div className="mono text-xs break-all">
            {r.case.request.method} {r.case.request.url}
          </div>
          {r.case.request.body?.content && <pre className="mono text-xs bg-panel rounded p-2 overflow-auto max-h-48">{r.case.request.body.content}</pre>}
          {r.bodyPreview && (
            <div>
              <div className="text-xs text-muted mb-1">Response</div>
              <pre className="mono text-xs bg-panel rounded p-2 overflow-auto max-h-48">{r.bodyPreview}</pre>
            </div>
          )}
          <div>
            <Button size="sm" icon={<ExternalLink size={12} />} onClick={() => useApp.getState().openIntent('rest', { request: r.case.request, name: `${r.case.operation} · ${r.case.name}` })}>
              Open as request
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Fuzzing from an API definition: the valid example of each operation, then requests that break one rule of its schema
 * at a time; server errors, invalid input accepted and undocumented statuses come back as findings.
 */
export function ApiFuzzPanel({ spec }: { spec: string }) {
  const environment = useApp((s) => s.environment);
  const [baseUrl, setBaseUrl] = useState('');
  const [includeDelete, setIncludeDelete] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [report, setReport] = useState<FuzzReport>();
  useEffect(() => on<{ done: number; total: number }>('fuzz.progress', setProgress), []);

  const run = async () => {
    setRunning(true);
    setReport(undefined);
    setProgress(undefined);
    try {
      setReport(await call<FuzzReport>('openapi.fuzz', { path: spec, environment: environment || undefined, baseUrl: baseUrl.trim() || undefined, includeDelete, allowRemote }));
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
    } finally {
      setRunning(false);
    }
  };
  const findings = report ? report.results.filter((r) => r.verdict !== 'ok' && r.verdict !== 'not-judged') : [];

  return (
    <div className="h-full flex flex-col min-h-0" data-api-fuzz>
      <div className="px-3 py-3 border-b border-line grid gap-2 shrink-0">
        <p className="text-sm text-muted">
          Each operation gets its valid example, then requests that break one rule of the schema at a time: a required field left out, a wrong type, a value outside its enum, range, length or format,
          a body that isn&apos;t JSON. These are real requests that may create or change data: fuzz a local or test copy of the API
          {environment ? ` (tokens and {{baseUrl}} come from ${environment})` : ''}.
        </p>
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Base URL" className="flex-1 min-w-[16rem]">
            <Input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="{{baseUrl}} of the environment, else the document's first server" aria-label="Base URL" />
          </Field>
          <Toggle checked={includeDelete} onChange={setIncludeDelete} label="Include DELETE" />
          <Toggle checked={allowRemote} onChange={setAllowRemote} label="Allow remote hosts" />
          {running ? (
            <Button icon={<Square size={13} />} onClick={() => void call('openapi.fuzzStop')}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<Play size={13} />} onClick={() => void run()}>
              Fuzz
            </Button>
          )}
        </div>
        {allowRemote && (
          <p className="text-xs text-warn flex items-center gap-1">
            <TriangleAlert size={12} /> Only fuzz systems you own or are authorised to test.
          </p>
        )}
        {running && progress && (
          <div className="h-1.5 bg-panel rounded overflow-hidden" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}>
            <div className="h-full bg-accent transition-all" style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {!report ? (
          <Empty icon={<Bug size={26} />} title={running ? `Sending${progress ? ` ${progress.done} of ${progress.total}` : ''}…` : 'Find the input your API mishandles'}>
            {running ? 'Requests go out four at a time.' : 'Server errors, invalid input the API accepts, and statuses the document doesn’t list.'}
          </Empty>
        ) : (
          <>
            <div className="flex items-center gap-3 px-3 py-2 text-sm border-b border-line" data-fuzz-summary>
              <span>
                {report.cases} requests to {report.operations} operations:
              </span>
              <Badge tone={report.counts['server-error'] ? 'bad' : 'ok'}>{report.counts['server-error']} server errors</Badge>
              <Badge tone={report.counts['accepted-invalid'] ? 'warn' : 'ok'}>{report.counts['accepted-invalid']} accepted</Badge>
              <Badge>{report.counts['undocumented-status']} undocumented</Badge>
              {findings.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  icon={<Sparkles size={12} />}
                  onClick={() =>
                    useApp.getState().set({
                      assistant: {
                        task: 'explain-fuzz',
                        title: `Fuzzing · ${spec.replace(/^specs\//, '')}`,
                        context: {
                          document: spec,
                          findings: findings
                            .slice(0, 60)
                            .map((r) => ({
                              operation: r.case.operation,
                              case: r.case.name,
                              verdict: r.verdict,
                              status: r.status,
                              message: r.message,
                              request: { url: r.case.request.url, body: r.case.request.body?.content?.slice(0, 500) },
                              response: r.bodyPreview?.slice(0, 300),
                            })),
                        },
                      },
                    })
                  }
                >
                  Explain and fix (AI)
                </Button>
              )}
            </div>
            {!findings.length ? (
              <Empty title="Nothing found">Every invalid request was rejected with a documented 4xx, and the valid examples were accepted.</Empty>
            ) : (
              GROUPS.map((g) => {
                const rows = report.results.filter((r) => r.verdict === g.verdict);
                if (!rows.length) return null;
                return (
                  <section key={g.verdict} className="px-1 py-2">
                    <h3 className="px-2 text-sm font-semibold flex items-center gap-2">
                      {g.title} <Badge tone={g.tone}>{rows.length}</Badge>
                    </h3>
                    <ul className="mt-1">
                      {rows.map((r) => (
                        <Row key={r.case.id} r={r} />
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}
