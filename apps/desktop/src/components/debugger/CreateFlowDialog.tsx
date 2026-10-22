import { ArrowRight, KeyRound, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../../api';
import { selectEnvironments, toastError, useApp } from '../../store';
import { openRef } from '../../lib/open-ref';
import { Badge, Button, Callout, Field, Input, Modal, Select, Spinner, statusTone, useDebounced } from '../ui';
import { plural } from '../../lib/format';

interface Preview {
  file: string;
  path: string;
  exists: boolean;
  text: string;
  steps: Array<{ id: string; name: string; method: string; url: string; exchangeId: string; status?: number; dependsOn: string[]; extract: Record<string, string>; uses: string[] }>;
  links: Array<{ variable: string; from: string; fromIndex: number; to: string; toIndex: number; source: string; target: string }>;
  variables: Array<{ name: string; kind: 'origin' | 'secret'; value?: string; fromEnvironment?: boolean; usedBy: string[]; what?: string }>;
  secrets: string[];
  dropped: Array<{ id: string; method: string; url: string; reason: string }>;
  notes: string[];
}

const defaultName = () => `recorded-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`;

/**
 * Create a flow from Debugger exchanges (the selected rows, or everything recorded since "Record a flow…" started):
 * the steps that will be made with the values found to flow between them, a tick to leave a step out, the file name
 * and the environment whose variables are offered. Create writes tests/recorded/<name>.yaml and opens it in the
 * Tests view's Flow tab (the designer).
 */
export function CreateFlowDialog({ ids, since, onClose }: { ids?: string[]; since?: string; onClose(): void }) {
  // the stored list (the same one while no workspace is open: a new [] per read renders forever), filtered once per change
  const all = useApp(selectEnvironments);
  const environments = useMemo(() => all.filter((e) => !e.problem), [all]);
  const [environment, setEnvironment] = useState<string>(() => useApp.getState().environment ?? '');
  const [name, setName] = useState(defaultName);
  const [drop, setDrop] = useState<string[]>([]);
  const [keepNoise, setKeepNoise] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const debouncedName = useDebounced(name, 300);
  const params = { ids, since, name: debouncedName.trim() || undefined, environment: environment || undefined, drop, keepNoise };

  useEffect(() => {
    let live = true;
    call<Preview>('debug.createFlow', { ...params, dryRun: true }).then(
      (p) => live && (setPreview(p), setError(undefined)),
      (e) => live && (setPreview(undefined), setError((e as Error).message)),
    );
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedName, environment, drop, keepNoise, ids, since]);

  const create = async () => {
    setBusy(true);
    try {
      const r = await call<Preview & { written: boolean }>('debug.createFlow', { ...params, name: name.trim() || undefined });
      useApp.getState().toast(`Created ${r.file}: ${plural(r.steps.length, 'step')}${r.secrets.length ? `; set ${r.secrets.join(', ')} in an environment` : ''}`, 'success');
      onClose();
      void openRef({ kind: 'flow', path: r.path });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const leftOut = preview?.dropped.filter((d) => drop.includes(d.id)) ?? [];
  const noise = preview?.dropped.filter((d) => !drop.includes(d.id)) ?? [];

  return (
    <Modal
      title="Create a flow from the exchanges"
      onClose={onClose}
      width={760}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Workflow size={13} />} disabled={!preview || busy} loading={busy} onClick={() => void create()} data-create-flow>
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-create-flow-dialog>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="File name"
            hint={preview ? <span className="mono">{preview.exists ? `${preview.file} (replaces nothing: a free name is used)` : preview.file}</span> : 'tests/recorded/<name>.yaml'}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Flow file name" />
          </Field>
          <Field label="Environment" hint="Its variables are offered: an address or a secret it already holds is used by name.">
            <Select value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label="Environment to propose variables for">
              <option value="">No environment</option>
              {environments.map((e) => (
                <option key={e.id} value={e.name}>
                  {e.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error && <Callout tone="bad">{error}</Callout>}
        {!preview && !error && (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Looking for values that flow between the requests…
          </div>
        )}
        {preview && (
          <>
            <div>
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Steps ({preview.steps.length})</div>
              <div className="border border-line rounded-lg divide-y divide-line max-h-[34vh] overflow-auto" data-flow-steps>
                {preview.steps.map((s, i) => (
                  <label key={s.id} className="flex items-start gap-2 px-2 py-1.5 hover:bg-hover cursor-pointer" data-flow-step={s.id}>
                    <input type="checkbox" className="mt-1" checked aria-label={`Keep step ${i + 1}`} onChange={() => setDrop((d) => [...d, s.exchangeId])} />
                    <span className="w-5 text-right text-muted tabular-nums">{i + 1}</span>
                    <span className={`mono text-xs w-14 shrink-0 mt-0.5 method-${s.method}`}>{s.method}</span>
                    <span className="flex-1 min-w-0">
                      <span className="mono text-xs break-all">{s.url}</span>
                      <span className="block text-xs text-muted">
                        {s.dependsOn.length ? `waits for ${s.dependsOn.map((d) => preview.steps.findIndex((x) => x.id === d) + 1).join(', ')}` : 'first step'}
                        {Object.keys(s.extract).length ? ` · extracts ${Object.keys(s.extract).join(', ')}` : ''}
                      </span>
                    </span>
                    {s.status !== undefined && <Badge tone={statusTone(s.status)}>{s.status}</Badge>}
                  </label>
                ))}
                {leftOut.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 text-muted hover:bg-hover cursor-pointer" data-flow-left-out={d.id}>
                    <input type="checkbox" aria-label={`Put back ${d.method} ${d.url}`} checked={false} onChange={() => setDrop((x) => x.filter((id) => id !== d.id))} />
                    <span className="w-5" />
                    <span className="mono text-xs w-14 shrink-0">{d.method}</span>
                    <span className="mono text-xs truncate flex-1 line-through">{d.url}</span>
                    <span className="text-xs">left out</span>
                  </label>
                ))}
              </div>
            </div>
            <div data-flow-links>
              <div className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">Values passed between steps ({preview.links.length})</div>
              {preview.links.length ? (
                <ul className="grid gap-0.5 text-xs">
                  {preview.links.map((l, i) => (
                    <li key={i} className="flex items-center gap-1.5 flex-wrap" data-flow-link>
                      <span className="mono text-accent">{l.source === 'cookie jar' ? l.variable : `{{${l.variable}}}`}</span>
                      <span className="text-muted">from step {l.fromIndex}</span>
                      <span className="mono text-muted">({l.source})</span>
                      <ArrowRight size={11} className="text-muted" />
                      <span>
                        {l.target} in step {l.toIndex}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">None found: each step waits for the one before it.</p>
              )}
            </div>
            {preview.variables.length > 0 && (
              <div className="grid gap-1 text-xs" data-flow-variables>
                <div className="text-xs font-semibold text-muted uppercase tracking-wide">Variables</div>
                {preview.variables.map((v) => (
                  <div key={v.name} className="flex items-center gap-2">
                    {v.kind === 'secret' ? <KeyRound size={12} className="text-warn" /> : <span className="w-3" />}
                    <span className="mono">{`{{${v.name}}}`}</span>
                    <span className="text-muted">
                      {v.fromEnvironment
                        ? `from ${environment || 'the environment'}`
                        : v.kind === 'origin'
                          ? `${v.value} (written in the file's defaults)`
                          : `${v.what ?? 'a secret'}: set it in an environment (no value is written)`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {noise.length > 0 && (
              <details className="text-xs" data-flow-dropped>
                <summary className="cursor-pointer text-muted">
                  {plural(noise.length, 'exchange')} left out as noise ({[...new Set(noise.map((d) => d.reason))].join(', ')})
                </summary>
                <ul className="mt-1 grid gap-0.5 max-h-32 overflow-auto">
                  {noise.map((d) => (
                    <li key={d.id} className="mono truncate text-muted">
                      {d.method} {d.url} · {d.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={keepNoise} onChange={(e) => setKeepNoise(e.target.checked)} /> Keep static assets, preflights and analytics requests
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
