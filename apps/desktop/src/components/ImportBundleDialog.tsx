import { Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { KIND_INFO, type ItemRef, type KindId } from '@testpion/shared';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Badge, Button, Callout, Modal, Select, Spinner } from './ui';
import type { ImportRequest } from '../lib/transfer';
import { BUNDLE_HINT } from '../lib/vocabulary';
import { openImport } from './ImportHost';

type Choice = 'keep-both' | 'replace' | 'skip';
interface Row {
  kind: string;
  id: string;
  name: string;
  action: 'create' | 'identical' | 'conflict' | 'invalid' | 'reference';
  existing?: { id: string; name: string };
  proposed?: { id: string; name: string };
  why?: string;
}
interface Preview {
  planId: string;
  fileName: string;
  preview: {
    title: string;
    createdBy: { app: string; version: string };
    createdAt: string;
    items: Row[];
    totals: { create: number; identical: number; conflict: number; invalid: number; reference: number };
    requires: { secrets: Array<{ name: string; where: string; defined: boolean }>; osEnv: string[] };
    review: string[];
    warnings: string[];
    notes: string[];
    missing: Array<{ to: string; reason: string }>;
  };
}
interface Outcome {
  importId: string;
  created: Array<{ kind: string; name: string }>;
  replaced: Array<{ kind: string; name: string }>;
  skipped: unknown[];
  open?: ItemRef;
  requires: Preview['preview']['requires'];
  title: string;
}

const key = (r: Pick<Row, 'kind' | 'id'>) => `${r.kind}:${r.id}`;
const kindLabel = (kind: string) => KIND_INFO[kind as KindId]?.label ?? kind;

const ACTION: Record<Row['action'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'default' | 'accent' }> = {
  create: { label: 'New', tone: 'ok' },
  identical: { label: 'Already here', tone: 'default' },
  conflict: { label: 'Conflict', tone: 'warn' },
  invalid: { label: 'Refused', tone: 'bad' },
  reference: { label: 'Not included', tone: 'default' },
};

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Import… of a bundle (a section's Import…, File ▸ Import, a bundle dropped on the window): pick the file, see what it
 * would do here (new, already here, conflict), choose per item (Keep both, Replace, Skip) with a default for all, and
 * apply. Nothing is written until Import; the message after it has Undo. A section's Import… takes only that kind.
 */
export default function ImportBundleDialog({ request, onClose }: { request: ImportRequest; onClose(): void }) {
  const [loaded, setLoaded] = useState<Preview>();
  const [upload, setUpload] = useState(false);
  const [error, setError] = useState<string>();
  const [onConflict, setOnConflict] = useState<Choice>('keep-both');
  const [rowChoice, setRowChoice] = useState<Record<string, Choice | 'import'>>({});
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const read = (params: Record<string, unknown>) => {
    setError(undefined);
    setLoaded(undefined);
    call<Preview | { upload: true } | null>('bundle.preview', params).then(
      (r) => {
        if (!r) return onClose(); // the picker was cancelled
        if ('upload' in r) return setUpload(true);
        setUpload(false);
        setLoaded(r);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    read(request.base64 ? { base64: request.base64, fileName: request.fileName } : { pick: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a file that is not a bundle ends in a way out: choose another file (or the Import for other formats), never a dead end
  const chooseAnother = () => {
    setError(undefined);
    setLoaded(undefined);
    setUpload(true);
  };
  const only = request.section ? [request.section === 'flow' ? 'test' : request.section] : undefined;
  const rows = loaded?.preview.items ?? [];
  const inScope = (r: Row) => !only || only.includes(r.kind);
  const decisions = rowChoice;
  const willWrite = rows.filter(
    (r) => inScope(r) && (r.action === 'create' || r.action === 'conflict') && decisions[key(r)] !== 'skip' && !(r.action === 'conflict' && !decisions[key(r)] && onConflict === 'skip'),
  );

  const apply = async () => {
    if (!loaded) return;
    setBusy(true);
    try {
      const r = await call<Outcome>('bundle.apply', { planId: loaded.planId, onConflict, decisions, ...(only ? { only } : {}) });
      const n = r.created.length + r.replaced.length;
      const need = r.requires.secrets.filter((s) => !s.defined);
      // one message, so its Undo is never under another: what was imported, and the values to fill in (secrets are never in a bundle)
      const fill = need.length
        ? `. To fill in as secret variables of an environment: ${need
            .slice(0, 6)
            .map((s) => `{{${s.name}}}`)
            .join(', ')}${need.length > 6 ? ' …' : ''}`
        : '';
      useApp
        .getState()
        .toast(
          `Imported ${n} item${n === 1 ? '' : 's'} from “${r.title}”${r.replaced.length ? ` (${r.replaced.length} replaced)` : ''}${fill}`,
          need.length ? 'warning' : 'success',
          r.open ? { ref: r.open } : undefined,
          {
            undo: () => call('bundle.undo', { importId: r.importId, planId: loaded.planId }),
            restored: `Undid the import of “${r.title}”`,
          },
        );
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const p = loaded?.preview;
  return (
    <Modal
      title={request.section ? `Import ${KIND_INFO[request.section as KindId]?.plural.toLowerCase() ?? request.section} from a bundle` : 'Import a bundle'}
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Upload size={13} />} loading={busy} disabled={!loaded || !willWrite.length} onClick={() => void apply()}>
            {willWrite.length ? `Import ${willWrite.length} item${willWrite.length === 1 ? '' : 's'}` : 'Nothing to import'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="import-bundle">
        {upload && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">Choose a TestPion bundle (.testpion.zip or .testpion.json). {BUNDLE_HINT}</p>
            <input
              ref={file}
              type="file"
              accept=".zip,.json"
              aria-label="Bundle file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void f.arrayBuffer().then((b) => read({ base64: toBase64(new Uint8Array(b)), fileName: f.name }));
              }}
            />
          </div>
        )}
        {error && (
          <Callout
            tone="bad"
            role="alert"
            action={
              <span className="flex gap-1">
                <Button size="sm" variant="primary" onClick={chooseAnother} data-bundle-choose-another>
                  Choose another file
                </Button>
                <Button size="sm" onClick={() => (onClose(), openImport())}>
                  Import another format…
                </Button>
              </span>
            }
          >
            {error}
            <div className="text-xs text-muted mt-1">Postman, Insomnia, Bruno, OpenAPI, HAR and other formats are not bundles: use Import another format.</div>
          </Callout>
        )}
        {!loaded && !error && !upload && (
          <div className="flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner /> Reading the file…
          </div>
        )}
        {p && (
          <>
            <div>
              <div className="font-medium">{p.title}</div>
              <div className="text-xs text-muted">
                {loaded!.fileName} · made by {p.createdBy.app} {p.createdBy.version}
                {p.createdAt ? ` · ${p.createdAt.slice(0, 10)}` : ''} · {p.totals.create} new, {p.totals.identical} already here, {p.totals.conflict} in conflict
                {p.totals.invalid ? `, ${p.totals.invalid} refused` : ''}
              </div>
            </div>
            {p.review.length > 0 && (
              <Callout tone="warn">
                <div className="font-medium">Review before you run (nothing runs on import)</div>
                <ul className="list-disc pl-4">
                  {p.review.slice(0, 6).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                  {p.review.length > 6 && <li>and {p.review.length - 6} more</li>}
                </ul>
              </Callout>
            )}
            {[...p.warnings, ...p.notes].length > 0 && (
              <ul className="text-xs text-muted list-disc pl-4">
                {[...p.warnings, ...p.notes].slice(0, 5).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {p.totals.conflict > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <span>When an item is already here:</span>
                <Select value={onConflict} onChange={(e) => setOnConflict(e.target.value as Choice)} aria-label="When an item is already here">
                  <option value="keep-both">Keep both (the new one is renamed)</option>
                  <option value="replace">Replace mine</option>
                  <option value="skip">Skip it</option>
                </Select>
              </div>
            )}
            <ul className="rounded-lg border border-line max-h-72 overflow-auto" aria-label="Items in the bundle">
              {rows.map((r) => {
                const scoped = inScope(r);
                const a = ACTION[r.action];
                return (
                  <li key={key(r)} className={`flex items-center gap-2 px-3 py-1.5 border-b border-line last:border-b-0 text-sm ${scoped ? '' : 'opacity-40'}`} data-action={r.action}>
                    <span className="text-xs text-muted w-24 shrink-0 truncate">{kindLabel(r.kind)}</span>
                    <span className="flex-1 min-w-0 truncate" title={`${r.name} (${r.id})`}>
                      {r.name}
                      {r.action === 'conflict' && r.proposed && (decisions[key(r)] ?? onConflict) === 'keep-both' && <span className="text-xs text-muted"> → {r.proposed.name}</span>}
                      {r.why && <span className="text-xs text-muted"> · {r.why}</span>}
                    </span>
                    <Badge tone={a.tone}>{a.label}</Badge>
                    {scoped && (r.action === 'conflict' || r.action === 'create') && (
                      <Select
                        className="w-32"
                        value={decisions[key(r)] ?? (r.action === 'create' ? 'import' : onConflict)}
                        onChange={(e) => setRowChoice((c) => ({ ...c, [key(r)]: e.target.value as Choice | 'import' }))}
                        aria-label={`What to do with ${r.name}`}
                      >
                        {r.action === 'create' ? (
                          <>
                            <option value="import">Import</option>
                            <option value="skip">Skip</option>
                          </>
                        ) : (
                          <>
                            <option value="keep-both">Keep both</option>
                            <option value="replace">Replace</option>
                            <option value="skip">Skip</option>
                          </>
                        )}
                      </Select>
                    )}
                  </li>
                );
              })}
            </ul>
            {p.requires.secrets.length > 0 && (
              <p className="text-xs text-muted">
                To fill in after the import:{' '}
                {p.requires.secrets
                  .slice(0, 8)
                  .map((s) => `{{${s.name}}}${s.defined ? ' (already defined)' : ''}`)
                  .join(', ')}
                {p.requires.secrets.length > 8 ? ' …' : ''}
              </p>
            )}
            {p.missing.length > 0 && (
              <p className="text-xs text-muted">
                Used but not in the bundle:{' '}
                {p.missing
                  .slice(0, 5)
                  .map((m) => m.to)
                  .join(', ')}
                .
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
