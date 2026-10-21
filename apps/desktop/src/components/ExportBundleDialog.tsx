import { Download } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { KIND_INFO, type KindId } from '@testpion/shared';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Badge, Button, Callout, Field, Modal, Select, Spinner, Toggle } from './ui';
import { finishSave, type SaveResult } from '../lib/files';
import type { ExportRequest } from '../lib/transfer';
import { BUNDLE_HINT } from '../lib/vocabulary';

/** What `bundle.export` answers (and, with dryRun, what the dialog shows before anything is saved). */
interface ExportSummary extends SaveResult {
  title: string;
  fileName: string;
  format: 'zip' | 'json';
  size: number;
  counts: Record<string, number>;
  items: Array<{ kind: string; id: string; name: string; mode?: string }>;
  replaced: Array<{ item: string; field: string; variable: string }>;
  missing: Array<{ from: string; to: string; reason: string }>;
  notes: string[];
  review: string[];
  saved?: boolean;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const labelOf = (kind: string, n: number) => {
  const k = KIND_INFO[kind as KindId];
  return k ? (n === 1 ? k.label : k.plural) : kind;
};

/**
 * Export… of any item or section (and "Export with everything it uses…" of a collection): one dialog for every kind,
 * opened by the shared node menus. It shows what the bundle will hold before anything is saved: the items (those a
 * picked item uses are added when the switch is on), the secrets that will be replaced by {{variables}}, and anything a
 * picked item uses that is not in the workspace. Saved where you choose (desktop) or downloaded (browser).
 */
export default function ExportBundleDialog({ request, onClose }: { request: ExportRequest; onClose(): void }) {
  const [uses, setUses] = useState(!!request.uses);
  const [datasets, setDatasets] = useState<'auto' | 'embed' | 'reference'>('auto');
  const [summary, setSummary] = useState<ExportSummary>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const params = useMemo(() => ({ selection: request.selection, section: request.section, all: request.all, title: request.title, uses, datasets }), [request, uses, datasets]);

  useEffect(() => {
    let live = true;
    setSummary(undefined);
    setError(undefined);
    call<ExportSummary>('bundle.export', { ...params, dryRun: true }).then(
      (s) => live && setSummary(s),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [params]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await call<ExportSummary>('bundle.export', params);
      if (!r.saved) return; // the save dialog was cancelled
      finishSave(r, 'Bundle');
      const warn = r.replaced.length || r.missing.length;
      if (warn)
        useApp
          .getState()
          .toast(
            [
              r.replaced.length
                ? `${r.replaced.length} secret${r.replaced.length === 1 ? '' : 's'} replaced by variables: ${[...new Set(r.replaced.map((x) => `{{${x.variable}}}`))].join(', ')}.`
                : '',
              r.missing.length ? `${r.missing.length} used item${r.missing.length === 1 ? ' is' : 's are'} not in the workspace.` : '',
            ]
              .filter(Boolean)
              .join(' '),
            'info',
          );
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const groups = summary ? Object.entries(summary.counts) : [];
  return (
    <Modal
      title={
        request.all
          ? 'Export the workspace as a bundle'
          : request.section
            ? `Export ${KIND_INFO[request.section as KindId]?.plural.toLowerCase() ?? request.section}`
            : `Export${request.title ? ` “${request.title}”` : ''}`
      }
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Download size={13} />} loading={busy} disabled={!summary} onClick={() => void run()}>
            Export
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="export-bundle">
        <p className="text-sm text-muted">
          {BUNDLE_HINT} This one is <code>{summary?.fileName ?? '….testpion.zip'}</code>; Import a Bundle… brings it back, here or in another workspace. Secret values are never in it.
        </p>
        {!request.all && (
          <Toggle
            checked={uses}
            onChange={setUses}
            label="Include everything it uses"
            title="Environments, API definitions, datasets, MCP servers and mocks, protos, packages, test files and saved items that the picked items refer to"
          />
        )}
        <Field label="Datasets" hint="A bigger dataset goes by reference: the bundle names it and the importer is told to copy the file.">
          <Select value={datasets} onChange={(e) => setDatasets(e.target.value as typeof datasets)} aria-label="Datasets">
            <option value="auto">Include up to 10 MB, bigger ones by reference</option>
            <option value="embed">Always include the data</option>
            <option value="reference">Never include the data</option>
          </Select>
        </Field>
        {error && <Callout tone="bad">{error}</Callout>}
        {!summary && !error && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Reading what would be exported…
          </div>
        )}
        {summary && (
          <div className="flex flex-col gap-2 text-sm" data-testid="export-bundle-summary">
            <div className="font-medium">
              {summary.items.length} item{summary.items.length === 1 ? '' : 's'} · {kb(summary.size)} · {summary.format === 'zip' ? '.zip' : '.json'}
            </div>
            <ul className="flex flex-col gap-1 max-h-56 overflow-auto rounded-lg border border-line p-2">
              {groups.map(([kind, n]) => (
                <li key={kind} className="flex flex-col">
                  <span className="text-xs text-muted">
                    {n} {labelOf(kind, n)}
                  </span>
                  <span className="truncate">
                    {summary.items
                      .filter((i) => i.kind === kind)
                      .slice(0, 6)
                      .map((i) => i.name)
                      .join(', ')}
                    {n > 6 ? ` … and ${n - 6} more` : ''}
                  </span>
                </li>
              ))}
            </ul>
            {summary.items.some((i) => i.mode === 'reference') && (
              <div className="flex items-center gap-2">
                <Badge tone="warn">by reference</Badge>
                <span className="text-muted">
                  {summary.items
                    .filter((i) => i.mode === 'reference')
                    .map((i) => i.name)
                    .join(', ')}
                  : copy the file by hand.
                </span>
              </div>
            )}
            {summary.replaced.length > 0 && (
              <Callout tone="warn">
                {summary.replaced.length} secret{summary.replaced.length === 1 ? '' : 's'} will be replaced by variables:{' '}
                {[...new Set(summary.replaced.map((x) => `{{${x.variable}}}`))].slice(0, 8).join(', ')}. Set them in the other workspace.
              </Callout>
            )}
            {summary.missing.length > 0 && (
              <Callout tone="warn">
                Used but not in the workspace:{' '}
                {summary.missing
                  .slice(0, 5)
                  .map((m) => m.to)
                  .join(', ')}
                {summary.missing.length > 5 ? ` … and ${summary.missing.length - 5} more` : ''}.
              </Callout>
            )}
            {summary.review.length > 0 && (
              <p className="text-xs text-muted">
                Whoever imports it will be told to review: {summary.review.slice(0, 3).join('; ')}
                {summary.review.length > 3 ? ' …' : ''}.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
