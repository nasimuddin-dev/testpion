import { ArrowLeftRight, Check, Download, FileDown, HardDrive, Package, Play, PlugZap, Upload, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { deliverSave, pickBinaryFile, pickTextFile, type SaveResult } from '../../lib/files';
import { plural } from '../../lib/format';
import { Badge, Button, Empty, Field, Input, Modal, Select, Tabs, Textarea, Toggle, VirtualList, type MenuItem } from '../ui';
import { ConnectionsDialog, Note } from './ConnectionsDialog';

/**
 * The Debugger's corporate-network and sharing actions (FG-9, 14, 22, 23, 24, 28), as menu items and the dialogs they open: the
 * Capture menu gets Connections…, Launch a program… and the large-session switch; the Session menu gets Export as Fiddler session,
 * Import Fiddler rules, Compare with…, Share a bundle… and Open a bundle…. DebuggerView only spreads the items and renders `dialogs`.
 */
export interface EnterpriseInput {
  sessions: Array<{ name: string; autosave?: boolean }>;
  running: boolean;
  /** Exchanges on screen. */
  count: number;
  /** Exchanges kept on disk beyond the ones on screen (large-session mode). */
  spilled: number;
  startThen(fn: () => void): void;
  /** The list reloads after a session was opened. */
  reload(): void;
}

type Which = 'connections' | 'launch' | 'compare' | 'share' | 'farx' | 'bundle' | undefined;

interface LargeState {
  on: boolean;
  spilled: number;
}

export function useDebuggerEnterprise(o: EnterpriseInput): { captureItems: MenuItem[]; sessionItems: MenuItem[]; dialogs: ReactNode } {
  const [which, setWhich] = useState<Which>();
  const [farx, setFarx] = useState<FarxReport & { text: string }>();
  const [opened, setOpened] = useState<OpenedBundle & { base64: string }>();
  const [large, setLarge] = useState<LargeState>();
  useEffect(() => void call<LargeState>('debug.largeSession').then(setLarge, () => undefined), [o.spilled]);
  const toast = useApp.getState().toast;
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      toastError(e);
      return undefined;
    }
  };

  const exportSaz = () =>
    void run(async () => {
      const r = await call<SaveResult & { exchanges: number }>('debug.exportSaz', { name: 'testpion-session' });
      if (deliverSave(r)) toast(`Exported ${plural(r.exchanges, 'exchange')} as a Fiddler session (secrets masked)`, 'success');
    });
  const pickFarx = () =>
    void run(async () => {
      const f = await pickTextFile('.farx,.xml');
      if (!f) return;
      const r = await call<FarxReport>('debug.importFarx', { text: f.text, dryRun: true });
      setFarx({ ...r, text: f.text });
      setWhich('farx');
    });
  const pickBundle = () =>
    void run(async () => {
      const f = await pickBinaryFile('.tpbundle');
      if (!f) return;
      const r = await call<OpenedBundle>('debug.openBundle', { base64: f.base64, append: o.count > 0 });
      o.reload();
      setOpened({ ...r, base64: f.base64 });
      setWhich('bundle');
    });
  const toggleLarge = () =>
    void run(async () => {
      const r = await call<LargeState>('debug.largeSession', { on: !large?.on });
      setLarge(r);
      toast(r.on ? 'Large sessions: older exchanges are kept on disk instead of being forgotten' : 'Large sessions are off: past 5,000 exchanges the oldest are forgotten', 'success');
    });

  const captureItems: MenuItem[] = [
    { label: 'Connections… (gateway, certificates)', icon: <PlugZap size={14} />, separator: true, title: 'Send the traffic through a corporate gateway, trust extra certificate authorities, present a client certificate', onSelect: () => setWhich('connections') },
    { label: 'A program: start it through the proxy…', icon: <Play size={14} />, title: 'Start a program with the proxy variables and switches its runtime reads (Java, .NET, Node, Python, curl, browsers)', onSelect: () => o.startThen(() => setWhich('launch')) },
    { label: `${large?.on ? '✓ ' : '  '}Keep the whole session (large sessions)`, icon: <HardDrive size={14} />, title: 'Past 5,000 exchanges the older ones are written to a file instead of being forgotten; Save session and the exports include them. Turning it off forgets what is on disk.', onSelect: toggleLarge },
  ];
  const sessionItems: MenuItem[] = [
    { label: 'Export as a Fiddler session (.saz)…', icon: <Download size={14} />, disabled: !o.count && !o.spilled, reason: 'Nothing captured yet', title: 'Secrets are masked in the file', onSelect: exportSaz },
    { label: 'Import Fiddler rules (.farx)…', icon: <Upload size={14} />, title: 'Best effort: you see what was imported and what was not', onSelect: pickFarx },
    { label: 'Compare with an earlier session…', icon: <ArrowLeftRight size={14} />, disabled: !o.count || !o.sessions.length, reason: !o.count ? 'Nothing captured yet' : 'Save an earlier session first (Save session)', title: 'Which requests were added, removed, or changed status or timing', onSelect: () => setWhich('compare') },
    { label: 'Share as a bundle (.tpbundle)…', icon: <Package size={14} />, disabled: !o.count && !o.spilled, reason: 'Nothing captured yet', title: 'One file with the masked session, the active rules, the environment and your notes', onSelect: () => setWhich('share') },
    { label: 'Open a bundle (.tpbundle)…', icon: <FileDown size={14} />, onSelect: pickBundle },
  ];

  const close = () => setWhich(undefined);
  const dialogs = (
    <>
      {which === 'connections' && <ConnectionsDialog onClose={close} />}
      {which === 'launch' && <LaunchDialog running={o.running} onClose={close} />}
      {which === 'compare' && <CompareDialog sessions={o.sessions} onClose={close} />}
      {which === 'share' && <ShareDialog onClose={close} />}
      {which === 'farx' && farx && <FarxDialog report={farx} onClose={close} onImported={o.reload} />}
      {which === 'bundle' && opened && <BundleDialog bundle={opened} onClose={close} onRules={o.reload} />}
    </>
  );
  return { captureItems, sessionItems, dialogs };
}

/* ------------------------------------------------------------------ Launch a program (FG-14) */

interface LaunchView {
  kind: string;
  command: string;
  args: string[];
  env: string[];
  notes: string[];
  detected: string;
  started: boolean;
  pid?: number;
}

const KINDS = ['node', 'python', 'java', 'dotnet', 'curl', 'chromium', 'firefox', 'other'];

function LaunchDialog({ running, onClose }: { running: boolean; onClose(): void }) {
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [kind, setKind] = useState('');
  const [view, setView] = useState<LaunchView>();
  const [busy, setBusy] = useState(false);
  const params = { command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [], kind: kind || undefined };
  const go = async (preview: boolean) => {
    setBusy(true);
    try {
      const r = await call<LaunchView>('debug.launch', { ...params, preview });
      setView(r);
      if (!preview) useApp.getState().toast(`Started ${r.command} (process ${r.pid}); its traffic shows in the list`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const why = !running ? 'Start capturing first' : !command.trim() ? 'Name the program to start' : undefined;
  return (
    <Modal
      title="Start a program through the proxy"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            Close
          </Button>
          <Button disabled={!!why || busy} reason={why} onClick={() => void go(true)}>
            Show what will be set
          </Button>
          <Button variant="primary" icon={<Play size={13} />} disabled={!!why || busy} reason={why} onClick={() => void go(false)}>
            Start it
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted">For a program that does not follow the system proxy: it is started with the variables and switches its runtime reads. A program that ignores every proxy setting is still not captured.</p>
        <Field label="Program" hint="A file name on the PATH, or the full path">
          <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="java, dotnet, node, python, curl, chrome…" data-launch-command />
        </Field>
        <Field label="Arguments" hint="Separated by spaces">
          <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-jar app.jar" />
        </Field>
        <Field label="Runtime" hint="Leave on Detect unless the file name does not say">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Detect from the name</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </Field>
        {view && (
          <Note tone={view.started ? 'ok' : 'accent'} title={view.started ? `Started as ${view.kind} (process ${view.pid})` : `Would start as ${view.kind}`}>
            <div className="grid gap-1 text-xs">
              <div>
                Variables set: <span className="font-mono">{view.env.join(', ')}</span>
              </div>
              {view.args.length > 0 && (
                <div>
                  Arguments: <span className="font-mono">{view.args.join(' ')}</span>
                </div>
              )}
              {view.notes.map((n) => (
                <div key={n}>{n}</div>
              ))}
            </div>
          </Note>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Compare two captures (FG-23) */

interface DiffSide {
  id: string;
  status?: number;
  error?: string;
  ms?: number;
  bytes: number;
}
interface DiffEntry {
  method: string;
  url: string;
  a?: DiffSide;
  b?: DiffSide;
  changes?: string[];
}
interface DiffResult {
  summary: string;
  baseline: string;
  unchanged: number;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  truncated: boolean;
}

function CompareDialog({ sessions, onClose }: { sessions: Array<{ name: string; autosave?: boolean }>; onClose(): void }) {
  const [name, setName] = useState(sessions.find((s) => !s.autosave)?.name ?? sessions[0]?.name ?? '');
  const [ignoreQuery, setIgnoreQuery] = useState(false);
  const [includeSize, setIncludeSize] = useState(false);
  const [result, setResult] = useState<DiffResult>();
  const [tab, setTab] = useState<'changed' | 'added' | 'removed'>('changed');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await call<DiffResult>('debug.diff', { with: name, ignoreQuery, includeSize });
      setResult(r);
      setTab(r.changed.length ? 'changed' : r.added.length ? 'added' : 'removed');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const list = result ? result[tab] : [];
  return (
    <Modal
      title="Compare with an earlier session"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon={<Check size={13} />} disabled={!name || busy} reason={!name ? 'Choose a saved session' : 'Comparing'} onClick={() => void run()}>
            Compare
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted">The session on screen against an earlier one, matching requests by method and address. Added and removed are relative to the earlier session.</p>
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <Field label="Earlier session">
            <Select value={name} onChange={(e) => setName(e.target.value)} data-compare-with>
              {sessions.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                  {s.autosave ? ' (AutoSave)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-1.5 pb-1">
            <Toggle checked={ignoreQuery} onChange={setIgnoreQuery} label="Ignore the query string" />
            <Toggle checked={includeSize} onChange={setIncludeSize} label="Count a different size" />
          </div>
        </div>
        {result && (
          <>
            <div className="text-sm" data-compare-summary>
              {result.summary}
            </div>
            <Tabs
              label="Differences"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'changed', label: 'Changed', badge: result.changed.length },
                { id: 'added', label: 'Added', badge: result.added.length },
                { id: 'removed', label: 'Removed', badge: result.removed.length },
              ]}
            />
            {list.length ? (
              <div className="h-64 border border-line rounded-md overflow-hidden">
                <VirtualList
                  items={list}
                  rowHeight={28}
                  name="Session differences"
                  keyOf={(x, i) => `${i}-${x.method}-${x.url}`}
                  render={(x) => (
                    <div className="flex items-center gap-2 px-2 h-7 text-xs min-w-0" data-diff-row>
                      <span className="font-mono w-14 shrink-0 text-muted">{x.method}</span>
                      <span className="truncate flex-1 font-mono" title={x.url}>
                        {x.url}
                      </span>
                      {x.changes ? (
                        <span className="shrink-0 text-muted">
                          {x.changes.includes('status') ? `${x.a?.status ?? '-'} to ${x.b?.status ?? '-'}` : ''} {x.changes.includes('timing') ? `${x.a?.ms ?? '-'} to ${x.b?.ms ?? '-'} ms` : ''}
                        </span>
                      ) : (
                        <Badge tone={(x.b ?? x.a)?.status && (x.b ?? x.a)!.status! < 400 ? 'ok' : 'bad'}>{(x.b ?? x.a)?.status ?? '-'}</Badge>
                      )}
                    </div>
                  )}
                />
              </div>
            ) : (
              <Empty title={`Nothing ${tab === 'changed' ? 'changed' : tab}`}>
                {tab === 'changed' ? 'Every request in both sessions has the same status and a similar time.' : 'Try the other tabs, or Ignore the query string if the requests carry changing values.'}
              </Empty>
            )}
            {result.truncated && <p className="text-xs text-muted">The lists are cut at 2,000 entries each.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Share a bundle (FG-24) */

function ShareDialog({ onClose }: { onClose(): void }) {
  const [name, setName] = useState(`session-${new Date().toISOString().slice(0, 10)}`);
  const [notes, setNotes] = useState('');
  const [withRules, setWithRules] = useState(true);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await call<SaveResult & { rules: number }>('debug.shareBundle', { name: name.trim(), notes: notes.trim() || undefined, withRules });
      if (deliverSave(r)) {
        useApp.getState().toast(`Bundle created (secrets masked)${r.rules ? `, with ${plural(r.rules, 'rule')}` : ''}`, 'success');
        onClose();
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Share as a bundle"
      onClose={onClose}
      onSubmit={() => void create()}
      width={520}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Package size={13} />} disabled={!name.trim() || busy} reason={!name.trim() ? 'Give the bundle a name' : 'Creating the bundle'} onClick={() => void create()}>
            Create the bundle…
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted">One file for a colleague or support: the session with credentials and tokens masked, the environment (TestPion version, system, proxy settings; no passwords or paths) and your notes. They open it with Session ▸ Open a bundle.</p>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} data-bundle-name />
        </Field>
        <Field label="Notes" hint="What happened, what you expected, how to reproduce it">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
        </Field>
        <Toggle checked={withRules} onChange={setWithRules} label="Include the active rules (their header values and bodies are masked)" />
      </div>
    </Modal>
  );
}

interface OpenedBundle {
  bundle: { name: string; createdAt: string; app: string; exchanges: number; rules: number; rulesAdded: number };
  environment?: { app: string; platform: string; osRelease: string; debugger: { gateway?: string; decrypt?: boolean; networkSpeed?: string } };
  notes?: string;
  loaded?: number;
}

function BundleDialog({ bundle, onClose, onRules }: { bundle: OpenedBundle & { base64: string }; onClose(): void; onRules(): void }) {
  const [added, setAdded] = useState(bundle.bundle.rulesAdded);
  const b = bundle.bundle;
  const addRules = async () => {
    try {
      await call('debug.openBundle', { base64: bundle.base64, append: true, withRules: true, rulesOnly: true });
      setAdded(b.rules);
      onRules();
      useApp.getState().toast(`Added ${plural(b.rules, 'rule')}, switched off: turn on the ones you want`, 'success');
    } catch (e) {
      toastError(e);
    }
  };
  const env = bundle.environment;
  return (
    <Modal
      title={`Bundle: ${b.name}`}
      onClose={onClose}
      width={560}
      footer={
        <Button variant="primary" icon={<Check size={13} />} onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="grid gap-3 text-sm">
        <div>
          {plural(b.exchanges, 'exchange')} opened in the list. Made {new Date(b.createdAt).toLocaleString()} with TestPion {b.app}; secrets were masked when it was made.
        </div>
        {env && (
          <div className="text-xs text-muted" data-bundle-environment>
            {env.app} on {env.platform} {env.osRelease}. {env.debugger.gateway ?? 'Direct connections'}
            {env.debugger.decrypt ? '; HTTPS was decrypted' : ''}
            {env.debugger.networkSpeed ? `; network speed ${env.debugger.networkSpeed}` : ''}
          </div>
        )}
        {bundle.notes && (
          <Note tone="accent" title="Notes from the sender">
            <div className="whitespace-pre-wrap text-xs">{bundle.notes}</div>
          </Note>
        )}
        {b.rules > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">The bundle carries {plural(b.rules, 'rule')}.</span>
            <Button size="sm" disabled={added > 0} reason="Its rules were added" onClick={() => void addRules()}>
              Add them, switched off
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ Fiddler rules (FG-22) */

interface FarxReport {
  summary: string;
  partial: boolean;
  applied: boolean;
  autoResponderEnabled?: boolean;
  items: Array<{ match: string; action: string; result: 'imported' | 'off' | 'skipped'; note?: string }>;
}

function FarxDialog({ report, onClose, onImported }: { report: FarxReport & { text: string }; onClose(): void; onImported(): void }) {
  const [done, setDone] = useState(false);
  const usable = report.items.filter((i) => i.result !== 'skipped').length;
  const apply = async () => {
    try {
      const r = await call<FarxReport>('debug.importFarx', { text: report.text, dryRun: false });
      setDone(true);
      onImported();
      useApp.getState().toast(`Imported ${plural(usable, 'rule')} from Fiddler (partial import)`, 'success');
      void r;
    } catch (e) {
      toastError(e);
    }
  };
  const tone = (r: string) => (r === 'imported' ? 'ok' : r === 'off' ? 'warn' : 'bad');
  return (
    <Modal
      title="Import Fiddler rules (partial import)"
      onClose={onClose}
      width={720}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" icon={<Upload size={13} />} disabled={!usable || done} reason={done ? 'Already imported' : 'None of the rules could be mapped'} onClick={() => void apply()}>
            Import {plural(usable, 'rule')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted">{report.summary}. Fiddler&apos;s file format is not published, so this is a best effort: a rule that has no equivalent is listed, never guessed. Nothing is written back to Fiddler.</p>
        {report.autoResponderEnabled === false && <Note tone="warn" title="The AutoResponder was switched off in Fiddler">Its rules are imported as they were; check which are enabled.</Note>}
        <div className="h-72 border border-line rounded-md overflow-hidden">
          <VirtualList
            items={report.items}
            rowHeight={34}
            name="Fiddler rules"
            keyOf={(x, i) => `${i}-${x.match}`}
            render={(x) => (
              <div className="flex items-center gap-2 px-2 h-[34px] text-xs min-w-0" data-farx-row>
                <Badge tone={tone(x.result)}>{x.result === 'off' ? 'imported off' : x.result}</Badge>
                <span className="font-mono truncate w-56 shrink-0" title={x.match}>
                  {x.match}
                </span>
                <span className="truncate flex-1 text-muted" title={`${x.action}${x.note ? `: ${x.note}` : ''}`}>
                  {x.action}
                  {x.note ? `: ${x.note}` : ''}
                </span>
              </div>
            )}
          />
        </div>
      </div>
    </Modal>
  );
}
