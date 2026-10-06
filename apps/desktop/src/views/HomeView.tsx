import { Activity as ActivityIcon, AlarmClock, BookOpen, Bug, Gauge, FileDown, Bot, LockKeyhole, ShieldCheck, FolderPlus, FolderTree, GitBranch, History, KeyRound, Network, Play, Plug, Sparkles, Upload, ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { asError, call, modKey } from '../api';
import { finishSave, type SaveResult } from '../lib/files';
import { promptText, useApp } from '../store';
import { runMenuCommand } from '../menu-commands';
import type { Collection, CollectionNode, HttpRequestSpec } from '../types';
import { timeAgo, uid, plural } from '../lib/format';
import { LinkButton, Badge, cx, Empty, Kbd, statusTone } from '../components/ui';
import { ActivityCharts, type Activity } from '../components/ActivityCharts';
import { AttentionCard } from '../components/AttentionCard';
import { RecentRuns } from '../components/charts';

interface HistoryItem {
  id: string;
  timestamp: string;
  kind: string;
  name: string;
  method?: string;
  url?: string;
  status?: number | string;
  request?: unknown;
}

const DOCS = 'https://nasimuddin-dev.github.io/testpion/';

/** Hue per quick action so the grid is easy to scan. */
const HUES = { blue: 'oklch(0.62 0.19 255)', violet: 'oklch(0.6 0.22 295)', teal: 'oklch(0.66 0.13 190)', green: 'oklch(0.64 0.16 150)', orange: 'oklch(0.7 0.16 55)', pink: 'oklch(0.64 0.21 350)', indigo: 'oklch(0.58 0.2 270)', slate: 'oklch(0.6 0.03 260)', red: 'oklch(0.62 0.2 25)', amber: 'oklch(0.74 0.15 75)' };

function Action({ icon, title, text, onClick, hue }: { icon: ReactNode; title: string; text: string; onClick(): void; hue: keyof typeof HUES }) {
  const c = HUES[hue];
  return (
    <button
      onClick={onClick}
      style={{ '--hue': c } as React.CSSProperties}
      className="group text-left rounded-2xl border border-line bg-bg p-4 shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-[color-mix(in_oklch,var(--hue)_45%,var(--line))] active:translate-y-0"
    >
      <div className="flex items-center gap-3">
        <span className="grid place-items-center h-9 w-9 rounded-xl text-[var(--hue)] bg-[color-mix(in_oklch,var(--hue)_14%,transparent)] ring-1 ring-[color-mix(in_oklch,var(--hue)_22%,transparent)] transition-transform duration-200 group-hover:scale-105">{icon}</span>
        <span className="font-medium">{title}</span>
      </div>
      <p className="text-xs text-muted mt-2.5 leading-relaxed">{text}</p>
    </button>
  );
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

function Card({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg shadow-sm flex flex-col min-h-0">
      <header className="flex items-center gap-2 px-4 h-12 border-b border-line text-sm font-semibold">
        <span className="grid place-items-center h-7 w-7 rounded-lg bg-panel2 text-muted">{icon}</span>
        {title}
        <span className="ml-auto">{action}</span>
      </header>
      <div className="p-2 overflow-auto">{children}</div>
    </section>
  );
}

const count = (nodes: CollectionNode[]): number => nodes.reduce((a, n) => a + (n.kind === 'folder' ? count(n.items) : 1), 0);

/** Postman-style home: quick actions, recent requests, collections and environments of the workspace. */
/** Id of the examples workspace that ships with the app (examples/public-workspace). */
const EXAMPLES_ID = 'ws-testpion-examples';

interface HomeMonitor {
  id: string;
  name: string;
  enabled: boolean;
  recent?: string[];
  lastResult?: { status: 'passed' | 'failed' | 'error'; passed: number; failed: number; errors: number; total: number; startedAt: string; reason?: string };
}
interface HomeRun {
  id: string;
  name: string;
  startedAt: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

export function HomeView() {
  const ws = useApp((s) => s.workspace);
  const env = useApp((s) => s.environment);
  const [cols, setCols] = useState<Collection[]>([]);
  // saved gRPC calls and connections belong to collections too (they are kept in the library)
  const [saved, setSaved] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<HistoryItem[]>([]);
  const [monitors, setMonitors] = useState<HomeMonitor[]>([]);
  const [runs, setRuns] = useState<HomeRun[]>([]);
  const [health, setHealth] = useState<Record<string, { sent: number; failing: number }>>({});
  const [certs, setCerts] = useState<Array<{ host: string; issuer?: string; validTo?: string; daysLeft?: number; lastSeen: string }>>([]);
  const [activity, setActivity] = useState<Activity>();
  // the dashboard's period, remembered
  const [days, setDays] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('aps.homeDays')) || 14;
    } catch {
      return 14;
    }
  });
  // the reload on returning to Home runs from a subscription made once: read the period from a ref
  const daysRef = useRef(days);
  daysRef.current = days;
  const loadActivity = (n = daysRef.current) => void call<Activity>('stats.activity', { days: n, tzOffsetMin: new Date().getTimezoneOffset() }).then(setActivity, () => setActivity(undefined));
  const pickDays = (n: number) => {
    setDays(n);
    loadActivity(n);
    try {
      localStorage.setItem('aps.homeDays', String(n));
    } catch {
      /* storage unavailable */
    }
  };
  const open = useApp((s) => s.openIntent);
  const setView = useApp((s) => s.setView);

  const load = () => {
    void call<Collection[]>('col.list').then(setCols);
    void Promise.all(['grpc', 'websocket'].map((kind) => call<{ items: Array<{ collectionId?: string }> }>('lib.get', { kind }).catch(() => ({ items: [] }))))
      .then((libs) => {
        const n: Record<string, number> = {};
        for (const i of libs.flatMap((l) => l.items)) if (i.collectionId) n[i.collectionId] = (n[i.collectionId] ?? 0) + 1;
        setSaved(n);
      });
    void call<{ items: HistoryItem[] }>('history.list', { limit: 8 }).then((r) => setRecent(r.items));
    void call<HomeMonitor[]>('monitor.list').then(setMonitors, () => setMonitors([]));
    void call<{ items: HomeRun[] }>('runs.list', { limit: 6 }).then((r) => setRuns(r.items), () => setRuns([]));
    void call<typeof certs>('certificates.list').then(setCerts, () => setCerts([]));
    void call<typeof health>('stats.collectionsHealth').then(setHealth, () => setHealth({}));
    loadActivity();
  };
  useEffect(() => {
    load();
    return useApp.subscribe((s, p) => s.view === 'home' && p.view !== 'home' && load());
  }, []);

  const newCollection = async () => {
    const name = await promptText('New collection', { message: 'Collection name', placeholder: 'My API', okLabel: 'Create' });
    if (!name) return;
    const id = uid('col-');
    await call('col.save', { schemaVersion: '1.0', id, name, version: 0, variables: [], items: [], updatedAt: '' });
    open('collections', { collectionId: id });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-[1400px] mx-auto px-8 py-8 flex flex-col gap-6">
        <div className="relative overflow-hidden rounded-3xl border border-line bg-panel px-7 py-6 shadow-sm">
          <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 h-64 w-64 rounded-full bg-[image:var(--brand-gradient)] opacity-20 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-28 left-1/3 h-56 w-56 rounded-full bg-[var(--brand-from)] opacity-10 blur-3xl" />
          <p className="relative text-sm font-medium text-accent">{greeting()} 👋</p>
          <h1 className="relative text-[1.75rem] font-semibold tracking-tight mt-1">{ws ? ws.name : 'Welcome to TestPion'}</h1>
          <p className="relative text-sm text-muted mt-1.5 max-w-2xl">Build, test and debug REST, GraphQL, gRPC, WebSocket, MCP and AI APIs. Everything stays on this computer.</p>
          {ws?.id === EXAMPLES_ID ? (
            <p className="relative text-sm mt-3 max-w-3xl">
              These examples use free public APIs. Open a collection and press <b>Send</b>, run a whole collection, or run the <b>All examples</b> and <b>Offline</b> suites in{' '}
              <LinkButton  icon={<ArrowRight size={12} />} onClick={() => setView('tests')}>
                Tests
              </LinkButton>
              . New to API testing? Start with <b>Public REST APIs (playground)</b>: logins, tokens and whole create, read, update and delete flows. GraphQL, SOAP, gRPC, WebSocket, MQTT, SSE and MCP servers each have public services to try, and AI Lab has prompts that run on an offline demo model.
            </p>
          ) : (
            <LinkButton className="relative block mt-3 text-sm" onClick={() => void runMenuCommand('open-examples')}>
              Explore the examples workspace: REST, GraphQL, gRPC, WebSocket, MCP and AI against public APIs →
            </LinkButton>
          )}
          {env && (
            <p className="relative mt-4 inline-flex items-center gap-2 rounded-full border border-line bg-bg/70 px-3 py-1 text-xs text-muted">
              <span className="w-2 h-2 rounded-full" style={{ background: ws?.environments.find((e) => e.name === env)?.color ?? 'var(--ok)' }} />
              Active environment: <span className="text-fg font-medium">{env}</span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
          <Action icon={<Network size={16} />} hue="blue" title="New HTTP request" text="Send a request, paste cURL or fetch from the browser, write tp.* scripts (Postman's pm.* works too)." onClick={() => open('rest', { newTab: true })} />
          <Action icon={<GitBranch size={16} />} hue="pink" title="New GraphQL query" text="Explore a schema with autocomplete and run queries." onClick={() => open('graphql', { reset: true })} />
          <Action icon={<Upload size={16} />} hue="teal" title="Import" text="Postman, Insomnia, Bruno or Hoppscotch collections, OpenAPI, HAR or cURL." onClick={() => open('collections', { import: true })} />
          <Action icon={<FolderPlus size={16} />} hue="orange" title="New collection" text="Group requests, share auth and scripts, run and mock them." onClick={() => void newCollection()} />
          <Action icon={<Bug size={16} />} hue="red" title="Debug HTTP traffic" text="See what a browser or an app sends: capture through a proxy, inspect, change with rules, replay." onClick={() => setView('debugger')} />
          <Action icon={<Gauge size={16} />} hue="amber" title="Load test an API" text="Virtual users, ramp-up, latency percentiles and errors, live." onClick={() => setView('load')} />
          <Action icon={<Plug size={16} />} hue="green" title="Test an MCP server" text="Connect over stdio or HTTP and call tools with generated forms." onClick={() => setView('mcp')} />
          <Action icon={<Sparkles size={16} />} hue="violet" title="Try an AI prompt" text="Compare models, check structured output, track tokens and cost." onClick={() => open('ai', { reset: true })} />
          <Action icon={<Bot size={16} />} hue="indigo" title="Ask the assistant" text="Explain an error, draft tests or ask how to do something." onClick={() => useApp.getState().set({ assistant: { task: 'free', title: 'Ask the assistant', context: {} } })} />
          <Action icon={<BookOpen size={16} />} hue="slate" title="Read the docs" text="Guides for requests, scripts, the runner, mocks and the CLI." onClick={() => window.open(DOCS, '_blank', 'noopener')} />
        </div>

        <AttentionCard />

        {activity && (
          <section aria-label="Activity" className="rounded-2xl border border-line bg-bg shadow-sm p-4 flex flex-col gap-3">
            <header className="flex items-center gap-2 text-sm font-semibold">
              <span className="grid place-items-center h-7 w-7 rounded-lg bg-panel2 text-muted">
                <ActivityIcon size={15} />
              </span>
              Activity
              <button
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-xs font-normal text-muted hover:text-fg hover:bg-hover"
                title="Save this dashboard, the collections' health, monitors and latest runs as one HTML file to share"
                onClick={() =>
                  void call<SaveResult>('report.workspace', { days, tzOffsetMin: new Date().getTimezoneOffset() }).then(
                    (r) => finishSave(r, 'Workspace report'),
                    (e) => useApp.getState().toast(asError(e).message, 'error'),
                  )
                }
              >
                <FileDown size={13} />
                Share report
              </button>
              <div role="radiogroup" aria-label="Period" className="flex rounded-lg border border-line p-0.5 text-xs font-normal">
                {[7, 14, 30].map((n) => (
                  <button key={n} role="radio" aria-checked={days === n} className={cx('px-2.5 py-1 rounded-md', days === n ? 'bg-accent/15 text-accent font-medium' : 'text-muted hover:text-fg')} onClick={() => pickDays(n)}>
                    {n} days
                  </button>
                ))}
              </div>
            </header>
            <ActivityCharts activity={activity} />
          </section>
        )}

        <div className="grid lg:grid-cols-3 gap-4">
          <Card title="Recent requests" icon={<History size={15} />} action={<LinkButton className="text-xs" onClick={() => setView('history')}>All history</LinkButton>}>
            {recent.length ? (
              recent.map((h) => (
                <button
                  key={h.id}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-hover"
                  onClick={() => (h.kind === 'http' && h.request ? open('rest', { request: h.request as HttpRequestSpec, name: h.name }) : open('history', { historyId: h.id }))}
                >
                  <span className={cx('mono method-badge text-[0.64rem] font-bold w-14 shrink-0', h.method && `method-${h.method}`)}>{h.method ?? h.kind}</span>
                  <span className="truncate flex-1">{h.url ?? h.name}</span>
                  {h.status !== undefined && <Badge tone={statusTone(h.status)}>{h.status}</Badge>}
                  <span className="text-xs text-muted shrink-0 w-16 text-right">{timeAgo(h.timestamp)}</span>
                </button>
              ))
            ) : (
              <Empty title="Nothing sent yet">Requests you send appear here.</Empty>
            )}
          </Card>
          <Card title="Collections" icon={<FolderTree size={15} />} action={<LinkButton className="text-xs" onClick={() => void newCollection()}>New</LinkButton>}>
            {cols.length ? (
              cols.map((c) => (
                <div key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-hover group">
                  <button className="flex-1 flex items-center gap-2 text-left min-w-0" onClick={() => open('collections', { collectionId: c.id })}>
                    <FolderTree size={13} className="text-muted shrink-0" />
                    <span className="truncate">{c.name}</span>
                    <span className="text-xs text-muted ml-2">{plural(count(c.items) + (saved[c.id] ?? 0), 'request')}</span>
                  </button>
                  {health[c.id]?.failing ? (
                    <Badge tone="bad" title={`${health[c.id]!.failing} of ${health[c.id]!.sent} sent requests: the latest response failed`}>
                      {health[c.id]!.failing} failing
                    </Badge>
                  ) : health[c.id]?.sent ? (
                    <span className="w-2 h-2 rounded-full bg-ok shrink-0" title={`${health[c.id]!.sent} sent requests, all passing`} aria-label="all sent requests passing" />
                  ) : null}
                  <button className="opacity-0 group-hover:opacity-100 text-muted hover:text-accent" title="Run collection" aria-label={`Run ${c.name}`} onClick={() => open('collections', { collectionId: c.id, run: true })}>
                    <Play size={13} />
                  </button>
                </div>
              ))
            ) : (
              <Empty title="No collections yet">Create one, or import from Postman or OpenAPI.</Empty>
            )}
          </Card>
          <Card title="Environments" icon={<KeyRound size={15} />} action={<LinkButton className="text-xs" icon={<ArrowRight size={12} />} onClick={() => setView('environments')}>Manage</LinkButton>}>
            {ws?.environments.length ? (
              ws.environments.map((e) => (
                <button key={e.id} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-hover" onClick={() => useApp.getState().setEnvironment(e.name)} title="Make this the active environment">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: e.color ?? (e.isProduction ? 'var(--bad)' : 'var(--ok)') }} />
                  <span className="truncate flex-1">{e.name}</span>
                  {e.isProduction && <Badge tone="bad">prod</Badge>}
                  {e.name === env && <Badge tone="accent">active</Badge>}
                </button>
              ))
            ) : (
              <Empty title="No environments">Environments hold variables like baseUrl and tokens.</Empty>
            )}
          </Card>
        </div>

        {(monitors.length > 0 || runs.length > 0) && (
          <div className="grid lg:grid-cols-2 gap-4">
            {monitors.length > 0 && (
              <Card title="Monitors" icon={<AlarmClock size={15} />} action={<LinkButton className="text-xs" icon={<ArrowRight size={12} />} onClick={() => setView('monitors')}>All monitors</LinkButton>}>
                {monitors.slice(0, 6).map((m) => {
                  const r = m.lastResult;
                  return (
                    <button key={m.id} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-hover" onClick={() => setView('monitors')}>
                      <span className={cx('w-2 h-2 rounded-full shrink-0', !r ? 'bg-muted/50' : r.status === 'passed' ? 'bg-ok' : 'bg-bad')} />
                      <span className="truncate flex-1">{m.name}</span>
                      {m.enabled && <RecentRuns statuses={m.recent ?? []} className="hidden sm:inline-flex" />}
                      {!m.enabled ? <Badge>paused</Badge> : r ? <Badge tone={r.status === 'passed' ? 'ok' : 'bad'}>{r.status === 'passed' ? `${r.passed}/${r.total}` : r.status === 'failed' ? (r.failed + r.errors ? `${r.failed + r.errors} failed` : r.reason?.startsWith('p95') ? 'too slow' : 'attention') : 'error'}</Badge> : <span className="text-xs text-muted">not run yet</span>}
                      <span className="text-xs text-muted shrink-0 w-16 text-right">{r ? timeAgo(r.startedAt) : ''}</span>
                    </button>
                  );
                })}
              </Card>
            )}
            {runs.length > 0 && (
              <Card title="Recent test runs" icon={<ShieldCheck size={15} />} action={<LinkButton className="text-xs" icon={<ArrowRight size={12} />} onClick={() => setView('tests')}>Tests</LinkButton>}>
                {runs.map((r) => {
                  const bad = r.failed + r.errors;
                  return (
                    <button key={r.id} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left hover:bg-hover" onClick={() => open('tests', { runId: r.id })}>
                      <span className={cx('w-2 h-2 rounded-full shrink-0', bad ? 'bg-bad' : 'bg-ok')} />
                      <span className="truncate flex-1">{r.name}</span>
                      <Badge tone={bad ? 'bad' : 'ok'}>{bad ? `${bad} failed` : `${r.passed}/${r.total} passed`}</Badge>
                      <span className="text-xs text-muted shrink-0 w-16 text-right">{timeAgo(r.startedAt)}</span>
                    </button>
                  );
                })}
              </Card>
            )}
          </div>
        )}

        {certs.length > 0 && (
          // HTTPS hosts called from here (app, runs, monitors, agents): the certificates that expire first
          <Card title="Certificates" icon={<LockKeyhole size={15} />} action={<span className="text-xs text-muted">{plural(certs.length, 'host')}</span>}>
            {certs.slice(0, 6).map((c) => (
              <div key={c.host} className="flex items-center gap-2 px-2 py-1.5 text-sm" title={`${c.host}: valid until ${c.validTo ? new Date(c.validTo).toLocaleDateString() : '?'}${c.issuer ? `, issued by ${c.issuer}` : ''} · last seen ${timeAgo(c.lastSeen)}`}>
                <span className={cx('w-2 h-2 rounded-full shrink-0', c.daysLeft === undefined ? 'bg-muted/50' : c.daysLeft < 14 ? 'bg-bad' : c.daysLeft < 30 ? 'bg-warn' : 'bg-ok')} />
                <span className="truncate mono text-xs flex-1">{c.host}</span>
                <span className="text-xs text-muted truncate max-w-[40%] hidden sm:inline">{c.issuer}</span>
                <Badge tone={c.daysLeft === undefined ? 'default' : c.daysLeft < 14 ? 'bad' : c.daysLeft < 30 ? 'warn' : 'ok'}>{c.daysLeft === undefined ? '?' : c.daysLeft < 0 ? 'expired' : `${c.daysLeft} days`}</Badge>
                <button
                  className="text-xs text-accent hover:underline shrink-0"
                  title={`Connect to ${c.host} now and read its certificate (trust, days left)`}
                  onClick={() =>
                    void call<{ daysLeft?: number; trusted: boolean; trustError?: string }>('certificates.check', { host: c.host }).then(
                      (r) => {
                        useApp.getState().toast(`${c.host}: ${r.daysLeft ?? '?'} days left${r.trusted ? '' : `, not trusted (${r.trustError})`}`, r.trusted && (r.daysLeft ?? 0) >= 14 ? 'success' : 'error');
                        void call<typeof certs>('certificates.list').then(setCerts, () => undefined);
                      },
                      (e) => useApp.getState().toast(`${c.host}: ${asError(e).message}`, 'error'),
                    )
                  }
                >
                  Check now
                </button>
              </div>
            ))}
            {certs.length > 6 && <div className="px-2 pt-1 text-xs text-muted">and {certs.length - 6} more: testpion certificates</div>}
          </Card>
        )}

        <div className="text-xs text-muted flex flex-wrap gap-x-5 gap-y-1">
          <span>
            <Kbd>{modKey}+K</Kbd> commands
          </span>
          <span>
            <Kbd>{modKey}+Shift+F</Kbd> search
          </span>
          <span>
            <Kbd>{modKey}+Enter</Kbd> send
          </span>
          <span>
            <Kbd>{modKey}+S</Kbd> save
          </span>
          <span>
            <Kbd>{modKey}+Alt+C</Kbd> console
          </span>
        </div>
      </div>
    </div>
  );
}
