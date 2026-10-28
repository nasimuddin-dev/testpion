import { Check, Plus, PlugZap, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { Button, Callout, Field, IconButton, Input, Modal, SectionTitle, Segmented, Spinner } from '../ui';

interface ClientCert {
  id: string;
  host: string;
  certFile: string;
  keyFile: string;
  passphraseSet?: boolean;
}
interface GatewayConfig {
  mode: 'none' | 'system' | 'manual';
  url?: string;
  bypass?: string;
  username?: string;
  caFiles?: string[];
  clientCerts?: ClientCert[];
}
interface GatewayView {
  config: GatewayConfig;
  passwordSet: boolean;
  summary: string;
  problems: string[];
  app: { mode: string; url?: string };
  running: boolean;
}
interface Probe {
  via: string;
  ok: boolean;
  ms: number;
  message: string;
}

/** A callout with a heading: the shared Callout has none. */
export function Note({ tone, title, children }: { tone: 'ok' | 'bad' | 'warn' | 'accent'; title: string; children: ReactNode }) {
  return (
    <Callout tone={tone} block>
      <div className="font-medium">{title}</div>
      <div className="text-xs">{children}</div>
    </Callout>
  );
}

/**
 * Capture ▸ Connections… (FG-9): how the Debugger reaches the servers. A corporate gateway (an upstream proxy) with a bypass list,
 * extra certificate authorities to trust (a corporate root), and client certificates for servers that ask for one. The proxy
 * password and each key's passphrase go to the secret store, never to a settings file; a key stays in its own file.
 */
export function ConnectionsDialog({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<GatewayView>();
  const [config, setConfig] = useState<GatewayConfig>({ mode: 'none' });
  const [password, setPassword] = useState('');
  const [passphrases, setPassphrases] = useState<Record<string, string>>({});
  const [probe, setProbe] = useState<Probe>();
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    call<GatewayView>('debug.gateway').then(
      (v) => {
        if (!live) return;
        setView(v);
        setConfig(v.config);
      },
      (e) => live && setError((e as Error).message),
    );
    return () => void (live = false);
  }, []);

  const patch = (p: Partial<GatewayConfig>) => setConfig((c) => ({ ...c, ...p }));
  const certs = config.clientCerts ?? [];
  const setCert = (i: number, p: Partial<ClientCert>) => patch({ clientCerts: certs.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const cas = config.caFiles ?? [];

  const toSend = (): GatewayConfig => ({
    ...config,
    clientCerts: certs.filter((c) => c.host.trim() || c.certFile.trim() || c.keyFile.trim()).map(({ passphraseSet: _p, ...c }) => c),
    caFiles: cas.map((f) => f.trim()).filter(Boolean),
  });
  const incomplete =
    config.mode === 'manual' && !config.url?.trim()
      ? 'Give the gateway address'
      : toSend().clientCerts!.some((c) => !c.host.trim() || !c.certFile.trim() || !c.keyFile.trim())
        ? 'A client certificate needs the host, the certificate file and the key file'
        : undefined;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const body: Record<string, unknown> = { config: toSend() };
      if (config.mode === 'manual' && config.username && password) body.password = password;
      if (config.mode !== 'manual' || !config.username) body.password = null;
      const pp: Record<string, string | null> = {};
      for (const [id, v] of Object.entries(passphrases)) if (v) pp[id] = v;
      if (Object.keys(pp).length) body.passphrases = pp;
      const v = await call<GatewayView>('debug.setGateway', body);
      setView(v);
      useApp.getState().toast(v.running ? 'Connection settings saved and applied to the running proxy' : 'Connection settings saved', 'success');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      toastError(e);
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setProbing(true);
    setProbe(undefined);
    try {
      // the saved settings are tested: save first, so the test is of what will run
      await call('debug.setGateway', { config: toSend(), ...(config.mode === 'manual' && config.username && password ? { password } : {}) });
      setProbe(await call<Probe>('debug.testGateway', {}));
    } catch (e) {
      setProbe({ via: '', ok: false, ms: 0, message: (e as Error).message });
    } finally {
      setProbing(false);
    }
  };

  return (
    <Modal
      title="Connections"
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            Cancel
          </Button>
          <Button icon={<PlugZap size={13} />} disabled={config.mode === 'none' || !!incomplete || probing} reason={config.mode === 'none' ? 'There is no gateway to test: choose one first' : (incomplete ?? 'Testing')} onClick={() => void test()}>
            Save and test the gateway
          </Button>
          <Button variant="primary" icon={<Check size={13} />} disabled={!view || saving || !!incomplete} reason={!view ? 'Loading' : (incomplete ?? 'Saving')} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {!view && !error ? (
        <Spinner />
      ) : (
        <div className="grid gap-4" data-connections>
          <p className="text-xs text-muted">How the Debugger reaches the servers. On a corporate network programs reach the internet through a gateway; the Debugger needs the same road. Settings apply to the running proxy at once.</p>
          {error && <Note tone="bad" title="Could not save">{error}</Note>}
          <div className="grid gap-2">
            <SectionTitle size="sm">Gateway (upstream proxy)</SectionTitle>
            <Segmented
              label="Gateway"
              value={config.mode}
              onChange={(mode) => patch({ mode })}
              options={[
                { value: 'none', label: 'Connect directly' },
                { value: 'system', label: 'Follow the system settings', title: `The environment's HTTP_PROXY / HTTPS_PROXY / NO_PROXY, or Settings ▸ Network${view?.app.mode === 'custom' ? ` (${view.app.url})` : ''}` },
                { value: 'manual', label: 'This address' },
              ]}
            />
            {config.mode === 'manual' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Address" hint="http://host:port">
                  <Input value={config.url ?? ''} onChange={(e) => patch({ url: e.target.value })} placeholder="http://proxy.corp.example:3128" data-gateway-url />
                </Field>
                <Field label="Go direct for" hint="Comma separated; loopback always goes direct">
                  <Input value={config.bypass ?? ''} onChange={(e) => patch({ bypass: e.target.value })} placeholder=".corp.example, 10.0.0.1, <local>" />
                </Field>
                <Field label="User name" hint="Leave empty when the gateway needs none">
                  <Input value={config.username ?? ''} onChange={(e) => patch({ username: e.target.value })} autoComplete="off" />
                </Field>
                <Field label="Password" hint={view?.passwordSet ? 'Saved in the secret store; type to replace it' : 'Kept in the secret store, never in a file'}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!config.username} title={config.username ? undefined : 'Give a user name first'} autoComplete="new-password" placeholder={view?.passwordSet ? '••••••••' : ''} />
                </Field>
              </div>
            )}
            {config.mode === 'system' && (
              <Field label="Go direct for" hint="Added to the system's own list; loopback always goes direct">
                <Input value={config.bypass ?? ''} onChange={(e) => patch({ bypass: e.target.value })} placeholder=".corp.example, <local>" />
              </Field>
            )}
            {probe && (
              <Note tone={probe.ok ? 'ok' : 'bad'} title={probe.ok ? 'The gateway works' : 'The gateway did not work'}>
                {probe.message} {probe.ms ? `(${probe.ms} ms)` : ''}
              </Note>
            )}
          </div>

          <div className="grid gap-2">
            <SectionTitle size="sm" right={<Button size="sm" icon={<Plus size={13} />} onClick={() => patch({ caFiles: [...cas, ''] })}>Add a file</Button>}>
              Extra certificate authorities
            </SectionTitle>
            <p className="text-xs text-muted">A corporate network often re-signs HTTPS with its own root. Servers whose certificate chains to one of these files are trusted, besides the usual authorities.</p>
            {cas.length === 0 && <p className="text-xs text-muted">None. Add the PEM file your IT department gave you if the Debugger reports an untrusted certificate.</p>}
            {cas.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="flex-1" value={f} onChange={(e) => patch({ caFiles: cas.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="C:\certs\corp-root.pem" aria-label={`Certificate file ${i + 1}`} />
                <IconButton label="Remove this certificate file" onClick={() => patch({ caFiles: cas.filter((_, j) => j !== i) })}><Trash2 size={13} /></IconButton>
              </div>
            ))}
          </div>

          <div className="grid gap-2">
            <SectionTitle size="sm" right={<Button size="sm" icon={<Plus size={13} />} onClick={() => patch({ clientCerts: [...certs, { id: '', host: '', certFile: '', keyFile: '' }] })}>Add a certificate</Button>}>
              Client certificates
            </SectionTitle>
            <p className="text-xs text-muted">For servers that ask who you are (mutual TLS). The key stays in its file; only its passphrase is saved, in the secret store.</p>
            {certs.length === 0 && <p className="text-xs text-muted">None. Add one when a server answers with a TLS handshake error that asks for a certificate.</p>}
            {certs.map((c, i) => (
              <div key={c.id || i} className="grid grid-cols-[1fr_1fr_1fr_9rem_auto] gap-2 items-end" data-client-cert>
                <Field label="Servers" hint="host or *.host">
                  <Input value={c.host} onChange={(e) => setCert(i, { host: e.target.value })} placeholder="mtls.corp.example" />
                </Field>
                <Field label="Certificate file">
                  <Input value={c.certFile} onChange={(e) => setCert(i, { certFile: e.target.value })} placeholder="client.pem" />
                </Field>
                <Field label="Key file">
                  <Input value={c.keyFile} onChange={(e) => setCert(i, { keyFile: e.target.value })} placeholder="client.key" />
                </Field>
                <Field label="Passphrase">
                  <Input type="password" value={passphrases[c.id] ?? ''} onChange={(e) => setPassphrases((p) => ({ ...p, [c.id]: e.target.value }))} disabled={!c.id} title={c.id ? undefined : 'Save the certificate first, then set its passphrase'} placeholder={c.passphraseSet ? '••••••••' : 'none'} autoComplete="new-password" />
                </Field>
                <IconButton label="Remove this client certificate" onClick={() => patch({ clientCerts: certs.filter((_, j) => j !== i) })}><Trash2 size={13} /></IconButton>
              </div>
            ))}
          </div>

          {view && view.problems.length > 0 && (
            <Note tone="warn" title="Check these files">
              <ul className="list-disc pl-4 text-xs">
                {view.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Note>
          )}
        </div>
      )}
    </Modal>
  );
}
