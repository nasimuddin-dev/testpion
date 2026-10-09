import { StoragePanel } from '../components/StoragePanel';
import { AgentsPanel } from '../components/AgentsPanel';
import { Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { pickTextFile } from '../lib/files';
import { toastError, useApp } from '../store';
import { useIntent } from '../hooks';
import type { AppSettings, PriceEntry, ProviderConfig } from '../types';
import { checkForUpdates } from '../updates';
import { Badge, Button, Field, IconButton, Input, Select, Tabs, Toggle } from '../components/ui';

type Tab = 'appearance' | 'requests' | 'git' | 'proxy' | 'certificates' | 'privacy' | 'pricing' | 'load' | 'storage' | 'assistant' | 'about' | 'agents';

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const ws = useApp((s) => s.workspace);
  const [s, setS] = useState<AppSettings | undefined>(settings);
  const [tab, setTab] = useState<Tab>('appearance');
  // other views open a tab directly, e.g. the assistant's "Set up" button; AI Lab's "Set a price…" adds a row for its model
  useIntent(
    'settings',
    (p?: { tab?: Tab; addPrice?: { provider: string; model: string } }) => {
      if (p?.tab) setTab(p.tab);
      const add = p?.addPrice;
      if (add)
        setS((cur) =>
          cur && !cur.pricing.some((x) => x.provider === add.provider && x.model === add.model)
            ? { ...cur, pricing: [...cur.pricing, { provider: add.provider, model: add.model, inputPerMillion: 0, outputPerMillion: 0, version: new Date().toISOString().slice(0, 10) }] }
            : cur,
        );
    },
    'settings-tab',
  );
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  useEffect(() => setS(settings), [settings]);
  useEffect(() => {
    void call<ProviderConfig[]>('ai.providers').then(setProviders);
  }, []);
  if (!s) return null;
  const set = (p: Partial<AppSettings>) => setS({ ...s, ...p });
  const save = () =>
    useApp
      .getState()
      .saveSettings(s)
      .then(
        () => useApp.getState().toast('Settings saved', 'success'),
        (e) => toastError(e),
      );
  const setPrice = (i: number, p: Partial<PriceEntry>) => set({ pricing: s.pricing.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  return (
    <div className="h-full flex flex-col">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'appearance', label: 'Appearance' },
          { id: 'requests', label: 'Requests' },
          { id: 'git', label: 'Git' },
          { id: 'proxy', label: 'Proxy' },
          { id: 'certificates', label: 'Certificates' },
          { id: 'privacy', label: 'Privacy & security' },
          { id: 'pricing', label: 'Model pricing' },
          { id: 'load', label: 'Load testing' },
          { id: 'storage', label: 'Storage' },
          { id: 'assistant', label: 'AI assistant' },
          { id: 'agents', label: 'AI agents (MCP)' },
          { id: 'about', label: 'About' },
        ]}
        right={
          tab !== 'storage' && tab !== 'agents' && (
            <Button size="sm" variant="primary" icon={<Save size={12} />} onClick={save}>
              Save settings
            </Button>
          )
        }
      />
      <div className="flex-1 overflow-auto p-5">
        <div className="max-w-3xl flex flex-col gap-4">
          {tab === 'appearance' && (
            <>
              <Field label="Theme">
                <Select value={s.theme} onChange={(e) => set({ theme: e.target.value as AppSettings['theme'] })}>
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </Select>
              </Field>
              <Field label="Response layout" hint="Where the response goes in the HTTP, GraphQL, gRPC and MCP editors. Auto puts it beside the request when there is room. Also: the layout button at the right of the tabs.">
                <Select value={s.responseLayout ?? 'auto'} onChange={(e) => set({ responseLayout: e.target.value as AppSettings['responseLayout'] })}>
                  <option value="auto">Auto (side by side when there is room)</option>
                  <option value="side">Side by side</option>
                  <option value="below">Response below</option>
                </Select>
              </Field>
              <Field label={`Font size (${s.fontSize}px)`}>
                <input type="range" min={11} max={20} value={s.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
              </Field>
              <Toggle checked={s.reducedMotion} onChange={(reducedMotion) => set({ reducedMotion })} label="Reduce motion" />
              <Toggle checked={s.notifyRunFinished !== false} onChange={(notifyRunFinished) => set({ notifyRunFinished })} label="Notify me when a run finishes while TestPion is in the background" />
              <p className="text-xs text-muted">
                Keyboard: Ctrl/Cmd+K commands · Ctrl/Cmd+Shift+F search · Ctrl/Cmd+Enter send/run · Ctrl/Cmd+S save · Ctrl/Cmd+Alt+1…9 switch views · Ctrl/Cmd+, settings.
              </p>
            </>
          )}
          {tab === 'requests' && (
            <>
              <Field label="Default timeout (ms)">
                <Input type="number" value={s.defaultTimeoutMs} onChange={(e) => set({ defaultTimeoutMs: Number(e.target.value) })} />
              </Field>
              <Field label="Maximum response preview (MB)" hint="Larger bodies are streamed to disk and truncated in the viewer; use “Save response” for the full payload.">
                <Input type="number" step="0.5" value={s.maxPreviewBytes / 1024 / 1024} onChange={(e) => set({ maxPreviewBytes: Math.max(0.1, Number(e.target.value)) * 1024 * 1024 })} />
              </Field>
              <Field label="Log level" hint="Secrets are redacted at every level, so DEBUG/TRACE are safe to enable.">
                <Select value={s.logLevel} onChange={(e) => set({ logLevel: e.target.value as AppSettings['logLevel'] })}>
                  {['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          {tab === 'git' && (
            <Field label="Fetch in the background every (minutes)" hint="While a workspace in git with a remote is open, TestPion fetches quietly (it never asks you to sign in) and the Git view shows when your team pushed commits, so you pull before pushing. 0 turns it off.">
              <Input type="number" min={0} max={1440} aria-label="Background fetch minutes" value={s.git?.autoFetchMinutes ?? 5} onChange={(e) => set({ git: { ...s.git, autoFetchMinutes: Math.max(0, Math.round(Number(e.target.value) || 0)) } })} />
            </Field>
          )}
          {tab === 'proxy' && <ProxySettings value={s.proxy ?? { mode: 'env' }} onChange={(proxy) => set({ proxy })} />}
          {tab === 'certificates' && <CertificateSettings value={s.tls ?? {}} onChange={(tls) => set({ tls })} />}
          {tab === 'privacy' && (
            <>
              <Field label="Always-redacted field names" hint="Matched case-insensitively (and as suffixes, e.g. accessToken) in logs, traces, history, reports and exports.">
                <textarea className="field mono min-h-28" value={s.redactFields.join('\n')} onChange={(e) => set({ redactFields: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
              </Field>
              <Field
                label="OS environment variables requests may read"
                hint="One name per line. {{$env.NAME}} works only for these: a collection someone shares with you, or one you import, could otherwise read any variable of this computer (cloud keys, tokens) and send it anywhere when run. The CLI reads all of them, as CI pipelines expect."
              >
                <textarea className="field mono min-h-20" placeholder={'e.g.\nAPI_BASE_URL\nSTAGING_TOKEN'} value={(s.envVariables ?? []).join('\n')} onChange={(e) => set({ envVariables: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
              </Field>
              <div className="rounded-md border border-line p-3 text-sm flex flex-col gap-1">
                <div className="font-medium">Telemetry</div>
                <p className="text-muted">
                  Telemetry is <b>disabled</b> and not implemented in this build. TestPion never transmits request bodies, prompts, responses or credentials anywhere except to the endpoints and providers you
                  explicitly call.
                </p>
              </div>
              <div className="rounded-md border border-line p-3 text-sm flex flex-col gap-1">
                <div className="font-medium">Secret storage</div>
                <p className="text-muted">
                  Secrets are stored using <b>{info?.secretBackend}</b>. Workspace files only contain references, so workspaces are safe to commit to git.
                </p>
              </div>
              <div className="rounded-md border border-line p-3 text-sm flex flex-col gap-1">
                <div className="font-medium">Script sandbox</div>
                <p className="text-muted">Pre-request and test scripts run in an isolated QuickJS (WebAssembly) interpreter with time and memory limits and no filesystem, network or process access.</p>
              </div>
            </>
          )}
          {tab === 'pricing' && (
            <>
              <p className="text-sm text-muted">
                Estimated cost = input tokens × input price + output tokens × output price. Prices change — enter the current prices from your provider and bump the version when they change. Reports record which price
                version was used. No prices are built in. A price for a model (<span className="mono">gpt-4o-mini</span>) also applies to its dated versions (
                <span className="mono">gpt-4o-mini-2024-07-18</span>); then press <b>Save</b>.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1">Provider (kind/id or *)</th>
                    <th>Model (glob)</th>
                    <th>Input $/1M</th>
                    <th>Output $/1M</th>
                    <th>Version</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {s.pricing.map((p, i) => (
                    <tr key={i}>
                      <td className="pr-1 py-0.5">
                        <Input className="w-full" value={p.provider} onChange={(e) => setPrice(i, { provider: e.target.value })} />
                      </td>
                      <td className="pr-1">
                        <Input className="w-full mono" value={p.model} onChange={(e) => setPrice(i, { model: e.target.value })} />
                      </td>
                      <td className="pr-1">
                        <Input className="w-24" type="number" step="0.01" value={p.inputPerMillion} onChange={(e) => setPrice(i, { inputPerMillion: Number(e.target.value) })} />
                      </td>
                      <td className="pr-1">
                        <Input className="w-24" type="number" step="0.01" value={p.outputPerMillion} onChange={(e) => setPrice(i, { outputPerMillion: Number(e.target.value) })} />
                      </td>
                      <td className="pr-1">
                        <Input className="w-28" value={p.version} onChange={(e) => setPrice(i, { version: e.target.value })} />
                      </td>
                      <td>
                        <IconButton label="Remove" onClick={() => set({ pricing: s.pricing.filter((_, j) => j !== i) })}>
                          <Trash2 size={13} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div>
                <Button size="sm" icon={<Plus size={12} />} onClick={() => set({ pricing: [...s.pricing, { provider: '*', model: '*', inputPerMillion: 0, outputPerMillion: 0, version: new Date().toISOString().slice(0, 10) }] })}>
                  Add price
                </Button>
              </div>
            </>
          )}
          {tab === 'storage' && <StoragePanel />}
          {tab === 'agents' && <AgentsPanel />}
          {tab === 'load' && (
            <>
              <Toggle checked={s.loadTesting.allowRemoteHosts} onChange={(allowRemoteHosts) => set({ loadTesting: { ...s.loadTesting, allowRemoteHosts } })} label="Allow load tests against remote (non-local) hosts by default" />
              <Field label="Maximum virtual users">
                <Input type="number" value={s.loadTesting.maxVirtualUsers} onChange={(e) => set({ loadTesting: { ...s.loadTesting, maxVirtualUsers: Number(e.target.value) } })} />
              </Field>
              <p className="text-xs text-muted">Environments marked as production always require an explicit per-run opt-in.</p>
            </>
          )}
          {tab === 'assistant' && <AssistantSettings s={s} set={set} providers={providers} />}
          {tab === 'about' && (
            <div className="text-sm flex flex-col gap-2">
              <div className="text-lg font-semibold">TestPion {info?.appVersion}</div>
              <div className="flex items-center gap-3 flex-wrap">
                <Toggle checked={s.checkForUpdates !== false} onChange={(checkForUpdates) => set({ checkForUpdates })} label="Check for updates when the app starts" />
                <Button size="sm" onClick={() => void checkForUpdates({ manual: true })}>
                  Check now
                </Button>
              </div>
              <p className="text-xs text-muted">
                {info?.canUpdateInPlace
                  ? 'Updates are downloaded from GitHub, verified and installed in place; the app restarts.'
                  : 'New versions are announced at startup and link to the download page (in-place updates need the Windows installer or the Linux AppImage).'}{' '}
                Remember to save settings after changing the toggle.
              </p>
              <div>
                Engine <Badge>{info?.version}</Badge> {info?.electron && <Badge>Electron {info.electron}</Badge>} {info?.node && <Badge>Node {info.node}</Badge>}
              </div>
              <div>Workspace: <span className="mono">{ws?.path}</span></div>
              <div>Metadata store: {info?.metaBackend}</div>
              <div>Secret storage: {info?.secretBackend}</div>
              {!!ws?.migrations.length && <div>Migrations applied on open: {ws.migrations.join(', ')}</div>}
              <div className="text-muted">Available check types: {info?.checkTypes.join(', ')}</div>
              <div>
                <Button
                  size="sm"
                  title="Versions, platform and storage backends, for a bug report (your home folder is replaced with ~)"
                  onClick={() => {
                    const home = (ws?.path ?? '').match(/^([A-Za-z]:\\Users\\[^\\]+|\/(?:home|Users)\/[^/]+)/)?.[1];
                    const text = [
                      `TestPion ${info?.appVersion ?? '?'} (engine ${info?.version ?? '?'})`,
                      `Electron ${info?.electron ?? '-'} · Node ${info?.node ?? '-'} · ${navigator.platform}`,
                      `Metadata store: ${info?.metaBackend ?? '?'} · Secret storage: ${info?.secretBackend ?? '?'}`,
                      `Workspace: ${home ? (ws?.path ?? '').replace(home, '~') : (ws?.path ?? '-')}`,
                      `Theme: ${s.theme} · Proxy: ${s.proxy?.mode ?? 'env'}`,
                    ].join('\n');
                    void navigator.clipboard.writeText(text).then(
                      () => useApp.getState().toast('Diagnostics copied', 'success'),
                      () => useApp.getState().toast('Could not copy to the clipboard', 'error'),
                    );
                  }}
                >
                  Copy diagnostics
                </Button>
                <Button size="sm" className="ml-2" onClick={() => useApp.getState().set({ feedback: {} })}>
                  Send feedback or report a problem
                </Button>
                <span className="text-xs text-muted ml-2">From a terminal: testpion doctor</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface ProxyInfo {
  passwordSet: boolean;
  env: { HTTP_PROXY?: string; HTTPS_PROXY?: string; NO_PROXY?: string };
}

/** Outbound proxy: the environment variables (default), a custom proxy, or none. The password goes to the secret store. */
function ProxySettings({ value, onChange }: { value: NonNullable<AppSettings['proxy']>; onChange(v: NonNullable<AppSettings['proxy']>): void }) {
  const [info, setInfo] = useState<ProxyInfo>();
  const [password, setPassword] = useState('');
  const load = () => void call<ProxyInfo>('settings.proxyInfo').then(setInfo);
  useEffect(load, []);
  const savePassword = async (pw: string) => {
    await call('settings.setProxyPassword', { password: pw });
    setPassword('');
    load();
    useApp.getState().toast(pw ? 'Proxy password saved in the secret store' : 'Proxy password removed', 'success');
  };
  const env = info?.env ?? {};
  const envSet = !!(env.HTTP_PROXY || env.HTTPS_PROXY);
  const option = (mode: typeof value.mode, title: string, text: string) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="radio" className="mt-1" checked={value.mode === mode} onChange={() => onChange({ ...value, mode })} />
      <span>
        <span className="font-medium">{title}</span>
        <span className="block text-sm text-muted">{text}</span>
      </span>
    </label>
  );
  return (
    <>
      <div className="flex flex-col gap-3">
        {option('env', 'Use the environment variables', envSet ? `HTTP_PROXY / HTTPS_PROXY are set on this computer: ${env.HTTPS_PROXY ?? env.HTTP_PROXY}${env.NO_PROXY ? `, except ${env.NO_PROXY}` : ''}.` : 'HTTP_PROXY, HTTPS_PROXY and NO_PROXY, like curl. None are set on this computer, so requests go direct.')}
        {option('custom', 'Use this proxy', 'For requests, OAuth token calls, AI providers, MCP over HTTP, WebSocket and datasets.')}
        {option('off', "Don't use a proxy", 'Connect directly, even when the environment variables are set.')}
      </div>
      {value.mode === 'custom' && (
        <div className="flex flex-col gap-3 pl-6">
          <Field label="Proxy URL">
            <Input className="mono" placeholder="http://proxy.example.com:8080" value={value.url ?? ''} onChange={(e) => onChange({ ...value, url: e.target.value })} />
          </Field>
          <Field label="Bypass the proxy for" hint="Comma separated, like NO_PROXY: host names (subdomains included), .domain suffixes, host:port, IP addresses, or * for everything.">
            <Input className="mono" placeholder="localhost, 127.0.0.1, .internal.example.com" value={value.bypass ?? ''} onChange={(e) => onChange({ ...value, bypass: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="User name (optional)">
              <Input value={value.username ?? ''} autoComplete="off" onChange={(e) => onChange({ ...value, username: e.target.value || undefined })} />
            </Field>
            <Field label="Password" hint={info?.passwordSet ? 'A password is saved in the secret store.' : 'Saved in the OS secret store, never in settings.'}>
              <div className="flex gap-2">
                <Input type="password" autoComplete="new-password" value={password} placeholder={info?.passwordSet ? '••••••••' : ''} onChange={(e) => setPassword(e.target.value)} />
                <Button disabled={!password} onClick={() => void savePassword(password)}>
                  Save
                </Button>
                {info?.passwordSet && (
                  <Button variant="ghost" onClick={() => void savePassword('')}>
                    Remove
                  </Button>
                )}
              </div>
            </Field>
          </div>
        </div>
      )}
      <p className="text-xs text-muted">A request's own proxy (request Settings) wins over this. WebSocket and Socket.IO connections use it too; gRPC reads the environment variables itself. The CLI always uses the environment variables (set TESTPION_NO_PROXY=1 to turn that off).</p>
    </>
  );
}

interface CertInfo {
  subject: string;
  issuer: string;
  validTo: string;
  expired: boolean;
  ca: boolean;
}

/** Certificate authorities HTTPS trusts besides the built-in list (corporate roots, private CAs). */
function CertificateSettings({ value, onChange }: { value: NonNullable<AppSettings['tls']>; onChange(v: NonNullable<AppSettings['tls']>): void }) {
  const [certs, setCerts] = useState<CertInfo[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const t = setTimeout(() => {
      if (!value.extraCa?.trim()) return (setCerts([]), setError(undefined));
      call<CertInfo[]>('settings.describeCertificates', { pem: value.extraCa }).then(
        (c) => (setCerts(c), setError(c.length ? undefined : 'No "-----BEGIN CERTIFICATE-----" block found.')),
        (e) => (setCerts([]), setError(asError(e).message)),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [value.extraCa]);
  const load = async () => {
    const f = await pickTextFile('.pem,.crt,.cer');
    if (f) onChange({ ...value, extraCa: [value.extraCa?.trim(), f.text.trim()].filter(Boolean).join('\n') });
  };
  return (
    <>
      <p className="text-sm text-muted">
        HTTPS connections trust the usual public certificate authorities. If your company inspects TLS traffic, or an API uses a private CA, requests fail with a certificate error until TestPion trusts that CA too.
      </p>
      <Toggle checked={!!value.systemCa} onChange={(systemCa) => onChange({ ...value, systemCa })} label="Trust the certificates installed in the operating system (Windows certificate store, macOS keychain, Linux CA bundle)" />
      <Field label="Extra CA certificates (PEM)" hint="One or more -----BEGIN CERTIFICATE----- blocks. Public certificates only: never paste a private key here.">
        <textarea className="field mono text-xs min-h-36" spellCheck={false} placeholder={'-----BEGIN CERTIFICATE-----\nMIID…\n-----END CERTIFICATE-----'} value={value.extraCa ?? ''} onChange={(e) => onChange({ ...value, extraCa: e.target.value || undefined })} />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void load()}>
          Add from file…
        </Button>
        {value.extraCa && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...value, extraCa: undefined })}>
            Remove all
          </Button>
        )}
      </div>
      {error && <div className="text-sm text-bad">{error}</div>}
      {certs.length > 0 && (
        <ul className="text-sm flex flex-col gap-1">
          {certs.map((c, i) => (
            <li key={i} className="flex items-center gap-2">
              <Badge tone={c.expired ? 'bad' : c.ca ? 'ok' : 'warn'}>{c.expired ? 'expired' : c.ca ? 'CA' : 'not a CA'}</Badge>
              <span className="font-medium">{c.subject}</span>
              <span className="text-muted text-xs">issued by {c.issuer} · valid until {new Date(c.validTo).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">Applies to requests, OAuth, AI providers, MCP over HTTP, WebSocket and datasets. A request that turns off TLS verification (its Settings tab) ignores this. From the terminal: TESTPION_USE_SYSTEM_CA=1 and TESTPION_CA_FILE=path, or Node's NODE_EXTRA_CA_CERTS.</p>
    </>
  );
}

const CLAUDE_ID = 'claude-app';

/**
 * The AI assistant (explain errors and responses, generate requests, tests and assertions): Claude with
 * the user's own Anthropic API key (checked, then kept in the OS secret store), or a provider of the
 * workspace (e.g. a local model). The key also appears in AI Lab as "Claude (your API key)".
 */
function AssistantSettings({ s, set, providers }: { s: AppSettings; set(p: Partial<AppSettings>): void; providers: ProviderConfig[] }) {
  const [status, setStatus] = useState<{ hasKey: boolean; keyStorage: string; models: Array<{ id: string; name: string }> }>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => void call<NonNullable<typeof status>>('ai.appKeyStatus').then(setStatus);
  useEffect(load, []);
  const on = !!s.assistantProvider;
  const source: 'claude' | 'workspace' = !s.assistantProvider || s.assistantProvider === CLAUDE_ID ? 'claude' : 'workspace';
  const workspaceProviders = providers.filter((p) => p.id !== CLAUDE_ID);
  const saveKey = async (value: string | null) => {
    setBusy(true);
    try {
      const r = await call<{ hasKey: boolean; settings: AppSettings }>('ai.setAppKey', { key: value });
      setKey('');
      // saving the first key turns the assistant on with Claude
      if (value && !s.assistantProvider) set({ assistantProvider: r.settings.assistantProvider, assistantModel: r.settings.assistantModel });
      useApp.getState().set({ settings: { ...useApp.getState().settings!, assistantProvider: r.settings.assistantProvider, assistantModel: r.settings.assistantModel } });
      useApp.getState().toast(value ? 'API key checked and saved in the secret store' : 'API key removed', 'success');
      load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const radio = (value: typeof source, title: string, text: string) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="radio"
        className="mt-1"
        checked={source === value}
        onChange={() => set(value === 'claude' ? { assistantProvider: CLAUDE_ID, assistantModel: status?.models[0]?.id } : { assistantProvider: workspaceProviders[0]?.id, assistantModel: workspaceProviders[0]?.defaultModel })}
      />
      <span>
        <span className="font-medium">{title}</span>
        <span className="block text-sm text-muted">{text}</span>
      </span>
    </label>
  );
  return (
    <>
      <Toggle
        checked={on}
        onChange={(v) => set(v ? { assistantProvider: CLAUDE_ID, assistantModel: s.assistantModel ?? status?.models[0]?.id } : { assistantProvider: undefined, assistantModel: undefined })}
        label="Turn on the AI assistant"
      />
      <p className="text-sm text-muted">
        The assistant explains errors and responses, and drafts requests, GraphQL queries, MCP arguments, assertions and tests. Its answers are always labelled as AI suggestions. Text is sent only when you use an
        AI action, straight to the provider you choose.
      </p>
      {on && (
        <>
          {radio('claude', 'Claude (Anthropic), with your API key', 'Anthropic bills your account for what you use. The key also appears in AI Lab and evaluations as "Claude (your API key)".')}
          {radio('workspace', 'A provider of this workspace', 'A provider set up in AI Lab ▸ Providers, for example a local Ollama model that works offline.')}
          {source === 'claude' ? (
            <div className="flex flex-col gap-3 pl-6">
              {status?.hasKey ? (
                <p className="text-sm flex items-center gap-2 flex-wrap">
                  <Badge tone="ok">key saved</Badge> in {status.keyStorage}, never in settings or workspace files.
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void saveKey(null)}>
                    Remove key
                  </Button>
                </p>
              ) : (
                <Field label="Anthropic API key" hint="Create one at console.anthropic.com ▸ API keys. TestPion checks it with Anthropic, then keeps it in the OS secret store.">
                  <div className="flex gap-2">
                    <Input type="password" autoComplete="off" spellCheck={false} className="mono flex-1 min-w-[22rem]" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void saveKey(key)} />
                    <Button variant="primary" loading={busy} disabled={!key.trim()} onClick={() => void saveKey(key)}>
                      {busy ? 'Checking…' : 'Save key'}
                    </Button>
                  </div>
                </Field>
              )}
              <Field label="Model">
                <Select value={s.assistantModel ?? status?.models[0]?.id ?? ''} onChange={(e) => set({ assistantModel: e.target.value })}>
                  {(status?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 pl-6">
              <Field label="Provider">
                <Select value={s.assistantProvider ?? ''} onChange={(e) => set({ assistantProvider: e.target.value, assistantModel: workspaceProviders.find((p) => p.id === e.target.value)?.defaultModel })}>
                  {workspaceProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Model">
                <Input className="mono" value={s.assistantModel ?? ''} onChange={(e) => set({ assistantModel: e.target.value || undefined })} />
              </Field>
            </div>
          )}
          <p className="text-xs text-muted">Save settings to keep the choice of source and model (the API key is saved on its own).</p>
        </>
      )}
    </>
  );
}

