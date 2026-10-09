import { ArrowDown, ArrowUp, Check, Pencil, Plus, Play, Scale, Trash2, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { confirmAction, promptText, toastError } from '../store';
import { Badge, Button, cx, Empty, Field, Input, Menu, Modal, Select, Toggle, type MenuItem, Textarea } from './ui';
import { CompareView, type Compared } from './ResponseHistory';

/**
 * The HTTP Debugger's rules (planning/http-debugger.md, DBG-3): the Rules tab (profiles, the list, presets, a URL to
 * test against them), the rule editor, the breakpoint dialog (an exchange held for editing) and the compare dialog.
 */

export type RuleKind = 'ignore' | 'only' | 'highlight' | 'modify' | 'reply' | 'redirect' | 'breakpoint';
export type RuleColumn = 'status' | 'url' | 'method' | 'host' | 'application' | 'user' | 'type' | 'version' | 'ip' | 'duration' | 'size';
export type RuleOperator = 'equals' | 'not-equals' | 'contains' | 'starts-with' | 'ends-with' | 'between' | 'greater-than' | 'less-than' | 'matches';
export interface RuleCondition {
  column: RuleColumn;
  op: RuleOperator;
  value: string;
  value2?: string;
  regex?: boolean;
}
export interface HeaderEdit {
  op: 'set' | 'remove';
  name: string;
  value?: string;
}
export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  kind: RuleKind;
  match: { host?: string; url?: string; method?: string; application?: string; status?: string | number; minMs?: number; minBytes?: number; where?: RuleCondition };
  color?: string;
  style?: { dark?: string; light?: string; bold?: boolean; row?: boolean };
  requestHeaders?: HeaderEdit[];
  responseHeaders?: HeaderEdit[];
  requestBody?: string;
  responseBody?: string;
  delayMs?: number;
  reply?: { status: number; headers?: Record<string, string>; body?: string; delayMs?: number };
  redirect?: { host: string; scheme?: 'http' | 'https' };
  breakpoint?: 'request' | 'response';
  summary?: string;
}
export interface RulesState {
  active: string;
  profiles: string[];
  rules: Rule[];
  activeCount: number;
  filterPresets: Array<{ name: string; filter: Record<string, unknown> }>;
  /** How many requests each rule acted on in this capture, by rule id. */
  hits?: Record<string, number>;
}
export interface HeldBreakpoint {
  id: string;
  phase: 'request' | 'response';
  since: string;
  exchange: { id: string; method: string; url: string; requestHeaders: Record<string, string>; requestBody?: string; status?: number; responseHeaders?: Record<string, string>; responseBody?: string };
}

const KIND_TONE: Record<RuleKind, 'default' | 'ok' | 'bad' | 'warn' | 'accent'> = { ignore: 'default', only: 'ok', highlight: 'accent', modify: 'warn', reply: 'bad', redirect: 'warn', breakpoint: 'bad' };
export const HIGHLIGHT_CLASS: Record<string, string> = {
  red: 'border-l-2 border-l-bad bg-bad/10',
  orange: 'border-l-2 border-l-warn bg-warn/10',
  yellow: 'border-l-2 border-l-warn bg-warn/5',
  green: 'border-l-2 border-l-ok bg-ok/10',
  blue: 'border-l-2 border-l-accent bg-accent/10',
  purple: 'border-l-2 border-l-accent bg-accent/15',
  grey: 'border-l-2 border-l-muted bg-hover',
};

export async function loadRules(): Promise<RulesState | undefined> {
  try {
    return await call<RulesState>('debug.rules');
  } catch (e) {
    toastError(e);
    return undefined;
  }
}

/** The Rules tab. */
export function RulesPanel({ state, onChange, host }: { state?: RulesState; onChange(s: RulesState): void; host?: string }) {
  const [editing, setEditing] = useState<Partial<Rule> | null>(null);
  const [presets, setPresets] = useState<Array<{ id: string; label: string; summary: string }>>([]);
  const [check, setCheck] = useState({ url: host ? `http://${host}/` : 'http://', result: '' });
  useEffect(() => {
    void call<typeof presets>('debug.rulePresets', { host }).then(setPresets, () => undefined);
  }, [host]);
  const act = async (method: string, params: unknown) => {
    try {
      onChange(await call<RulesState>(method, params));
    } catch (e) {
      toastError(e);
    }
  };
  const profileItems: MenuItem[] = [
    {
      label: 'New profile…',
      icon: <Plus size={14} />,
      onSelect: async () =>
        void (await promptText('New profile', { message: 'A set of rules switched as one (Offline, Slow network, Mock payments…). It starts with the default highlights.', placeholder: 'Name' }).then(
          (n) => void (n && act('debug.profile', { action: 'create', name: n })),
        )),
    },
    {
      label: 'Copy this profile…',
      icon: <Plus size={14} />,
      onSelect: async () =>
        void (await promptText('Copy profile', { message: `A copy of ${state?.active ?? ''} to change on its own.`, placeholder: 'Name' }).then(
          (n) => void (n && act('debug.profile', { action: 'create', name: n, from: state?.active })),
        )),
    },
    {
      label: 'Rename…',
      icon: <Pencil size={14} />,
      onSelect: async () => void (await promptText('Rename profile', { value: state?.active ?? '' }).then((n) => void (n && act('debug.profile', { action: 'rename', name: n, from: state?.active })))),
    },
    {
      label: 'Delete this profile',
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: (state?.profiles.length ?? 0) <= 1,
      onSelect: async () =>
        (await confirmAction({ title: `Delete ${state?.active ?? ''}`, message: 'Its rules go with it.', confirmLabel: 'Delete', danger: true })) &&
        void act('debug.profile', { action: 'delete', name: state?.active }),
    },
  ];
  const testUrl = async () => {
    try {
      const r = await call<{ applied: string[]; ignore: boolean; highlight?: string; reply?: number; redirect?: string; breakpoint?: string; delayMs: number }>('debug.ruleCheck', { url: check.url });
      const parts = [
        r.ignore && 'not listed (filtered out, or outside Capture only)',
        r.highlight && `highlighted ${r.highlight}`,
        r.reply && `answered with ${r.reply} by a rule`,
        r.redirect && `redirected to ${r.redirect}`,
        r.breakpoint && `paused at the ${r.breakpoint}`,
        r.delayMs && `delayed ${r.delayMs} ms`,
      ].filter(Boolean);
      setCheck({ ...check, result: r.applied.length ? `${r.applied.join(', ')}: ${parts.join(', ') || 'headers changed'}` : 'No rule matches' });
    } catch (e) {
      setCheck({ ...check, result: asError(e).message });
    }
  };
  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 grid gap-4 content-start max-w-5xl">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted">Profile</span>
        <Select aria-label="Rules profile" value={state?.active ?? ''} onChange={(e) => void act('debug.profile', { action: 'use', name: e.target.value })}>
          {(state?.profiles ?? []).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </Select>
        <Menu items={profileItems} trigger={<Button size="sm">Profiles…</Button>} />
        <span className="flex-1" />
        <Menu
          width={320}
          items={presets.map<MenuItem>((p) => ({ label: p.label, icon: <Zap size={14} />, onSelect: () => void act('debug.addPreset', { preset: p.id, host }) }))}
          trigger={
            <Button size="sm" icon={<Zap size={13} />} title={host ? `Presets for ${host}` : 'Ready-made rules'}>
              Presets{host ? ` for ${host}` : ''}
            </Button>
          }
        />
        <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setEditing({ kind: 'modify', enabled: true, match: host ? { host } : {} })}>
          New rule
        </Button>
      </div>
      <p className="text-xs text-muted">
        Rules act on the traffic that matches them, in this order: <b>capture only</b> lists just what one of them matches, <b>filter out</b> hides it, <b>highlight</b> colours the row, <b>modify</b> changes headers, bodies or adds a delay, <b>reply</b> answers
        without the server, <b>redirect</b> sends it to another host, <b>breakpoint</b> pauses it for editing. Globs (<span className="mono">*.example.com</span>) or /regular expressions/ match hosts
        and URLs. The profile is saved in <span className="mono">debugger/rules.json</span>, committed with the workspace.
      </p>
      {!state?.rules.length ? (
        <Empty icon={<Scale size={26} />} title="No rules in this profile">
          Add a preset or a new rule.
        </Empty>
      ) : (
        <table className="text-sm w-full">
          <tbody>
            {state.rules.map((r, i) => (
              <tr key={r.id} className={cx('border-t border-line', !r.enabled && 'opacity-60')} data-rule={r.id}>
                <td className="py-1 pr-2 w-10">
                  <Toggle checked={r.enabled} onChange={(v) => void act('debug.setRuleEnabled', { id: r.id, enabled: v })} label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`} />
                </td>
                <td className="py-1 pr-2 w-24">
                  <Badge tone={KIND_TONE[r.kind]}>{r.kind}</Badge>
                </td>
                <td className="py-1 pr-3 font-medium whitespace-nowrap">{r.name}</td>
                <td className="py-1 pr-3 text-muted truncate max-w-xl" title={r.summary}>
                  {r.summary}
                </td>
                <td className="py-1 whitespace-nowrap text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ArrowUp size={12} />}
                    disabled={i === 0}
                    onClick={() => void act('debug.moveRule', { id: r.id, to: i - 1 })}
                    title="Earlier (the first matching reply, redirect or breakpoint wins)"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ArrowDown size={12} />}
                    disabled={i === state.rules.length - 1}
                    onClick={() => void act('debug.moveRule', { id: r.id, to: i + 1 })}
                    title="Later"
                  />
                  <Button size="sm" variant="ghost" icon={<Pencil size={12} />} onClick={() => setEditing(r)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void act('debug.deleteRule', { id: r.id })} title="Remove the rule" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <section className="grid gap-1">
        <div className="text-xs font-semibold text-muted uppercase tracking-wide">What would happen to a URL</div>
        <div className="flex gap-2">
          <Input
            className="flex-1 mono"
            aria-label="URL to test against the rules"
            value={check.url}
            onChange={(e) => setCheck({ ...check, url: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void testUrl()}
          />
          <Button size="sm" icon={<Play size={12} />} onClick={() => void testUrl()}>
            Test
          </Button>
        </div>
        {check.result && <div className="text-sm">{check.result}</div>}
      </section>
      {editing && (
        <RuleDialog
          rule={editing}
          onClose={() => setEditing(null)}
          onSave={async (rule) => {
            await act('debug.saveRule', { rule });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const headersText = (h?: Record<string, string>) =>
  Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
const parseHeaders = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes(':'))
      .map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]),
  );
/** Header edits as lines: "Name: value" sets, "-Name" removes. */
const editsText = (edits?: HeaderEdit[]) => (edits ?? []).map((e) => (e.op === 'remove' ? `-${e.name}` : `${e.name}: ${e.value ?? ''}`)).join('\n');
const parseEdits = (text: string): HeaderEdit[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) =>
      l.startsWith('-')
        ? { op: 'remove' as const, name: l.slice(1).trim() }
        : { op: 'set' as const, name: l.slice(0, l.indexOf(':') < 0 ? l.length : l.indexOf(':')).trim(), value: l.indexOf(':') < 0 ? '' : l.slice(l.indexOf(':') + 1).trim() },
    );

/** The rule editor. */
export function RuleDialog({ rule, onClose, onSave }: { rule: Partial<Rule>; onClose(): void; onSave(rule: Partial<Rule>): Promise<void> }) {
  const [r, setR] = useState<Partial<Rule>>({ ...rule, match: { ...(rule.match ?? {}) } });
  const [reqEdits, setReqEdits] = useState(editsText(rule.requestHeaders));
  const [resEdits, setResEdits] = useState(editsText(rule.responseHeaders));
  const [replyHeaders, setReplyHeaders] = useState(headersText(rule.reply?.headers));
  const set = (patch: Partial<Rule>) => setR({ ...r, ...patch });
  const match = (patch: Partial<Rule['match']>) => setR({ ...r, match: { ...(r.match ?? {}), ...patch } });
  const kind = r.kind ?? 'modify';
  const save = () =>
    onSave({
      ...r,
      kind,
      requestHeaders: kind === 'modify' ? parseEdits(reqEdits) : undefined,
      responseHeaders: kind === 'modify' ? parseEdits(resEdits) : undefined,
      reply: kind === 'reply' ? { status: Number(r.reply?.status) || 200, headers: parseHeaders(replyHeaders), body: r.reply?.body ?? '', delayMs: r.reply?.delayMs } : undefined,
      redirect: kind === 'redirect' ? r.redirect : undefined,
      breakpoint: kind === 'breakpoint' ? (r.breakpoint ?? 'request') : undefined,
      color: kind === 'highlight' ? (r.color ?? 'yellow') : undefined,
    });
  const area = (value: string, onChange: (v: string) => void, placeholder: string, rows = 3) => (
    <Textarea className="field mono text-xs w-full" rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
  );
  return (
    <Modal
      title={rule.id ? 'Edit rule' : 'New rule'}
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Check size={13} />} onClick={() => void save()}>
            Save rule
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={r.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="What it does" />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => set({ kind: e.target.value as RuleKind })}>
              <option value="ignore">Filter out (hide from the list)</option>
              <option value="only">Capture only (list just what matches)</option>
              <option value="highlight">Highlight the row</option>
              <option value="modify">Modify headers, bodies, delay</option>
              <option value="reply">Reply without the server</option>
              <option value="redirect">Redirect to another host</option>
              <option value="breakpoint">Breakpoint (pause for editing)</option>
            </Select>
          </Field>
        </div>
        <div className="text-xs font-semibold text-muted uppercase tracking-wide">Matches</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Host" hint="Glob: api.test, *.example.com; empty: any">
            <Input className="mono" value={r.match?.host ?? ''} onChange={(e) => match({ host: e.target.value || undefined })} placeholder="*.example.com" />
          </Field>
          <Field label="URL" hint="Glob or /regex/">
            <Input className="mono" value={r.match?.url ?? ''} onChange={(e) => match({ url: e.target.value || undefined })} placeholder="*/orders/*" />
          </Field>
          <Field label="Methods" hint="GET, POST …; empty: any">
            <Input className="mono" value={r.match?.method ?? ''} onChange={(e) => match({ method: e.target.value || undefined })} placeholder="GET, POST" />
          </Field>
          <Field label="Program" hint="Glob on the sender's name">
            <Input className="mono" value={r.match?.application ?? ''} onChange={(e) => match({ application: e.target.value || undefined })} placeholder="chrome" />
          </Field>
        </div>
        {kind === 'highlight' && (
          <div className="grid grid-cols-4 gap-3">
            <Field label="Colour">
              <Select value={r.color ?? 'yellow'} onChange={(e) => set({ color: e.target.value })}>
                {['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={String(r.match?.status ?? '')} onChange={(e) => match({ status: e.target.value ? (/^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value) : undefined })}>
                <option value="">any</option>
                <option value="ok">2xx</option>
                <option value="redirect">3xx</option>
                <option value="client-error">4xx</option>
                <option value="server-error">5xx</option>
                <option value="error">errors</option>
              </Select>
            </Field>
            <Field label="Slower than (ms)">
              <Input type="number" value={r.match?.minMs ?? ''} onChange={(e) => match({ minMs: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
            <Field label="Larger than (bytes)">
              <Input type="number" value={r.match?.minBytes ?? ''} onChange={(e) => match({ minBytes: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
          </div>
        )}
        {kind === 'modify' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Request headers" hint="Name: value sets; -Name removes">
                {area(reqEdits, setReqEdits, 'X-Debug: 1\n-Cookie')}
              </Field>
              <Field label="Response headers" hint="Name: value sets; -Name removes">
                {area(resEdits, setResEdits, 'Access-Control-Allow-Origin: *\n-ETag')}
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Replace the request body" hint="Empty: leave it">
                {area(r.requestBody ?? '', (v) => set({ requestBody: v || undefined }), '')}
              </Field>
              <Field label="Replace the response body" hint="Empty: leave it">
                {area(r.responseBody ?? '', (v) => set({ responseBody: v || undefined }), '')}
              </Field>
            </div>
            <Field label="Delay before forwarding (ms)" className="w-48">
              <Input type="number" value={r.delayMs ?? ''} onChange={(e) => set({ delayMs: e.target.value ? Number(e.target.value) : undefined })} />
            </Field>
          </>
        )}
        {kind === 'reply' && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Status">
                <Input type="number" value={r.reply?.status ?? 200} onChange={(e) => set({ reply: { ...(r.reply ?? { status: 200 }), status: Number(e.target.value) } })} />
              </Field>
              <Field label="Delay (ms)">
                <Input
                  type="number"
                  value={r.reply?.delayMs ?? ''}
                  onChange={(e) => set({ reply: { ...(r.reply ?? { status: 200 }), delayMs: e.target.value ? Number(e.target.value) : undefined } })}
                />
              </Field>
            </div>
            <Field label="Headers" hint="Name: value per line">
              {area(replyHeaders, setReplyHeaders, 'content-type: application/json', 2)}
            </Field>
            <Field label="Body">{area(r.reply?.body ?? '', (v) => set({ reply: { ...(r.reply ?? { status: 200 }), body: v } }), '{"ok":true}', 5)}</Field>
          </>
        )}
        {kind === 'redirect' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="To host" hint="host:port; the path stays">
              <Input className="mono" value={r.redirect?.host ?? ''} onChange={(e) => set({ redirect: { ...(r.redirect ?? { host: '' }), host: e.target.value } })} placeholder="localhost:3000" />
            </Field>
            <Field label="Scheme">
              <Select value={r.redirect?.scheme ?? ''} onChange={(e) => set({ redirect: { ...(r.redirect ?? { host: '' }), scheme: (e.target.value || undefined) as 'http' | 'https' | undefined } })}>
                <option value="">as the request</option>
                <option value="http">http</option>
                <option value="https">https</option>
              </Select>
            </Field>
          </div>
        )}
        {kind === 'breakpoint' && (
          <Field label="Pause" className="w-64">
            <Select value={r.breakpoint ?? 'request'} onChange={(e) => set({ breakpoint: e.target.value as 'request' | 'response' })}>
              <option value="request">the request, before the server</option>
              <option value="response">the response, before the program</option>
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

/** An exchange held at a breakpoint: edit it, let it go on, or abort it. */
export function BreakpointDialog({ bp, onDone }: { bp: HeldBreakpoint; onDone(): void }) {
  const e = bp.exchange;
  const req = bp.phase === 'request';
  const [method, setMethod] = useState(e.method);
  const [url, setUrl] = useState(e.url);
  const [status, setStatus] = useState(String(e.status ?? 200));
  const [headers, setHeaders] = useState(headersText(req ? e.requestHeaders : e.responseHeaders));
  const [body, setBody] = useState((req ? e.requestBody : e.responseBody) ?? '');
  const resume = async (edits?: Record<string, unknown>, abort?: boolean) => {
    try {
      await call('debug.resumeBreakpoint', { id: bp.id, edits, abort });
    } catch (err) {
      toastError(err);
    }
    onDone();
  };
  return (
    <Modal
      title={`Breakpoint: the ${bp.phase} of ${e.method} ${e.url}`}
      onClose={() => void resume()}
      width={720}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={() => void resume(undefined, true)} title="The program gets a 502">
            Abort
          </Button>
          <Button onClick={() => void resume()} title="On it goes, unchanged">
            Continue as is
          </Button>
          <Button
            variant="primary"
            icon={<Play size={13} />}
            onClick={() => void resume(req ? { method, url, headers: parseHeaders(headers), body } : { status: Number(status) || undefined, headers: parseHeaders(headers), body })}
          >
            Continue with changes
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted">
          {req ? 'Held before the server sees it: change the method, URL, headers or body, then continue.' : 'Held before the program sees it: change the status, headers or body, then continue.'} It
          goes on by itself after two minutes.
        </p>
        {req ? (
          <div className="flex gap-2">
            <Input className="w-28 mono" aria-label="Method" value={method} onChange={(ev) => setMethod(ev.target.value.toUpperCase())} />
            <Input className="flex-1 mono" aria-label="URL" value={url} onChange={(ev) => setUrl(ev.target.value)} />
          </div>
        ) : (
          <Field label="Status" className="w-32">
            <Input type="number" value={status} onChange={(ev) => setStatus(ev.target.value)} />
          </Field>
        )}
        <Field label="Headers" hint="Name: value per line">
          <Textarea className="field mono text-xs w-full" rows={6} value={headers} onChange={(ev) => setHeaders(ev.target.value)} />
        </Field>
        <Field label="Body">
          <Textarea className="field mono text-xs w-full" rows={8} value={body} onChange={(ev) => setBody(ev.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Two exchanges side by side: status, headers, body (the History view's compare, reused). */
export function CompareExchangesDialog({ a, b, onClose }: { a: string; b: string; onClose(): void }) {
  const [c, setC] = useState<(Compared & { before: { label?: string }; after: { label?: string } }) | undefined>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void call<typeof c>('debug.compare', { a, b }).then(setC, (e) => setError(asError(e).message));
  }, [a, b]);
  return (
    <Modal title="Compare two exchanges" onClose={onClose} width={960}>
      <div className="h-[60vh] min-h-0">
        {error ? <p className="p-3 text-sm text-bad">{error}</p> : c ? <CompareView c={c} labels={[c.before.label ?? 'A', c.after.label ?? 'B']} /> : <Empty title="Comparing…" />}
      </div>
    </Modal>
  );
}
