import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Link2, Upload, Undo2 } from 'lucide-react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { LABEL } from '../lib/vocabulary';
import { startTidyImport } from './ai/flow-generate';
import { toastSpecKeptBoth } from '../lib/spec-import';
import { toastImportNotes, toastUnchangedScripts } from '../lib/import-scripts';
import { IMPORT_FILE_ACCEPT } from '@testpion/shared';
import type { ImportManyPlan, ImportPlan, ImportReport, ImportSource } from '../types';
import { pickImportFiles, pickImportFolder } from '../lib/import-files';
import { Button, Field, Input, Modal, Spinner, Textarea } from './ui';
import { ImportReportView, ImportTree } from './ImportReport';

/** The tools a user switches from, with how to get their collection out (the "Migrate from…" entry opens the dialog with one of them). */
export const MIGRATE_TOOLS = {
  postman: {
    label: 'Postman',
    how: 'In Postman, open the collection ▸ ⋯ ▸ Export ▸ Collection v2.1, and each environment ▸ ⋯ ▸ Export. A whole account: Settings ▸ Data export gives one ZIP of everything. Or paste a Postman API key below and a link or id (postman:collection/<id>).',
  },
  insomnia: { label: 'Insomnia', how: 'In Insomnia, open the collection menu ▸ Export ▸ choose Insomnia v5 (YAML) or v4 (JSON). Design documents (OpenAPI) in the export are kept in specs/.' },
  bruno: { label: 'Bruno', how: 'Choose the collection folder itself (the one with bruno.json or opencollection.yml); its .env comes along. A ZIP of the folder works too.' },
  other: { label: 'Another tool', how: 'OpenAPI / Swagger, HAR, Hoppscotch, cURL, .http files, WSDL and GraphQL schemas import as they are. Paste a cURL command, drop a file, or choose a folder.' },
} as const;
export type MigrateTool = keyof typeof MIGRATE_TOOLS;

type Step = 'source' | 'preview' | 'done';

interface Applied {
  imported: Array<{ input: { name: string; source: string }; result?: { format: string; report?: ImportReport; collection?: { id: string; name: string }; environments?: Array<{ name: string }>; flows?: Array<{ path: string }>; notes?: string[]; specKeptBoth?: { existing: string }; specPath?: string; scriptWarnings?: Array<{ where: string; script: string; api: string; hint: string }>; scripts?: Parameters<typeof toastUnchangedScripts>[0] }; error?: { message: string } }>;
  receipts: string[];
  snippets: Array<{ request?: string; collection?: string }>;
}

/**
 * Import, in three steps in one dialog: where it comes from (files, a folder, a link, pasted text; or something dropped on
 * the window), a preview of everything it would create with the compatibility report (nothing is written yet), and the
 * result with the same report and an Undo. The one dialog for File ▸ Import, the palette, the Explorer, the Collections view,
 * the Workspace menu, Home's "Migrate from…" and a drop.
 */
export function ImportDialog({ onClose, onDone, initial, tool: toolIn, migrate }: { onClose(): void; onDone(): void; initial?: ImportSource; tool?: MigrateTool; migrate?: boolean }) {
  const [tool, setTool] = useState<MigrateTool | undefined>(toolIn);
  const [step, setStep] = useState<Step>('source');
  const [preview, setPreview] = useState<(ImportManyPlan & { sessionId: string; snippets: number }) | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [keepPm, setKeepPm] = useState(false);
  const [keySet, setKeySet] = useState(false);
  const [key, setKey] = useState('');
  const [undone, setUndone] = useState(false);
  const sessionRef = useRef<string | undefined>(undefined);

  const run = async (src: ImportSource) => {
    setBusy(true);
    try {
      const p = await call<ImportManyPlan & { sessionId: string; snippets: number }>('import.preview', { ...src, keepPm });
      sessionRef.current = p.sessionId;
      setPreview(p);
      setStep('preview');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const pick = (fn: () => Promise<ImportSource | null>) => async () => {
    try {
      const src = await fn();
      if (src) await run(src);
    } catch (e) {
      toastError(e);
    }
  };
  useEffect(() => {
    void call<{ set: boolean }>('import.postmanKey').then((r) => setKeySet(r.set), () => undefined);
    if (initial) void run(initial);
    return () => {
      // a preview nobody imported is dropped on the backend
      if (sessionRef.current) void call('import.cancel', { sessionId: sessionRef.current }).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await call<Applied>('import.apply', { sessionId: preview.sessionId, keepPm });
      sessionRef.current = undefined;
      setApplied(r);
      setStep('done');
      await useApp.getState().refreshWorkspace();
      onDone();
      const made = r.imported.flatMap((i) => [i.result?.collection?.name, ...(i.result?.environments ?? []).map((e) => e.name), ...(i.result?.flows ?? []).map((f) => `flow ${f.path}`)]).filter(Boolean) as string[];
      const failed = r.imported.filter((i) => i.error).length;
      if (r.receipts.length)
        useApp.getState().toast(`Imported ${made.length ? made.slice(0, 3).join(', ') + (made.length > 3 ? ` and ${made.length - 3} more` : '') : 'it'}${failed ? `; ${failed} could not be imported` : ''}`, failed ? 'warning' : 'success', undefined, {
          undo: async () => {
            await call('import.undo', { receipts: r.receipts });
            await useApp.getState().refreshWorkspace();
            onDone();
          },
          restored: 'Import undone: it is in Recently deleted',
        });
      // what did not map one to one, and the clean-up of a collection from another tool (as before the preview step existed)
      for (const i of r.imported) {
        const x = i.result;
        if (!x) continue;
        toastUnchangedScripts(x.scripts);
        if (x.collection && /^(postman|har|insomnia|bruno|hoppscotch|opencollection)/i.test(x.format))
          useApp.getState().toast(`${x.collection.name} can be tidied: names, folders, the host and token as variables, ids chained.`, 'info', { label: LABEL.tidyImport, onClick: () => startTidyImport({ collectionId: x.collection!.id, source: x.format }) });
        toastImportNotes({ notes: toastSpecKeptBoth({ ...x, notes: x.notes }), scriptWarnings: x.scriptWarnings });
      }
      if (!r.receipts.length && r.snippets.length) useApp.getState().toast(`Imported ${r.snippets.length} request${r.snippets.length === 1 ? '' : 's'} into "Imported"`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!applied) return;
    setBusy(true);
    try {
      const r = await call<Array<{ refused?: string[] }>>('import.undo', { receipts: applied.receipts });
      const refused = r.flatMap((x) => x.refused ?? []);
      if (refused.length) useApp.getState().toast(`Not undone: ${refused.join('; ')}`, 'warning');
      else {
        setUndone(true);
        useApp.getState().toast('Import undone: it is in Recently deleted', 'success');
        await useApp.getState().refreshWorkspace();
        onDone();
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const plans = preview?.inputs.flatMap((p) => ('plan' in p ? [{ input: p.input, plan: p.plan }] : [])) ?? [];
  const failed = preview?.inputs.flatMap((p) => ('error' in p ? [p] : [])) ?? [];
  const guide = tool ? MIGRATE_TOOLS[tool] : undefined;

  return (
    <Modal
      title={step === 'source' ? (guide ? `Migrate from ${guide.label}` : 'Import') : step === 'preview' ? 'Import: preview' : 'Import: done'}
      onClose={onClose}
      width={720}
      footer={
        step === 'source' ? (
          <>
            <Button icon={<Upload size={13} />} loading={busy} onClick={pick(() => pickImportFiles(IMPORT_FILE_ACCEPT))}>
              Choose files…
            </Button>
            <Button icon={<FolderOpen size={13} />} loading={busy} title="A collection folder (Bruno, OpenCollection) or a folder of files" onClick={pick(pickImportFolder)}>
              Choose folder…
            </Button>
            <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void run({ text })}>
              Preview pasted content
            </Button>
          </>
        ) : step === 'preview' ? (
          <>
            <Button variant="ghost" onClick={() => setStep('source')}>
              Back
            </Button>
            <label className="flex items-center gap-2 text-xs mr-auto" title="Postman and Insomnia scripts are converted to TestPion's tp.* (pm.* still runs). Exporting to Postman turns tp.* back into pm.*.">
              <input type="checkbox" checked={keepPm} onChange={(e) => setKeepPm(e.target.checked)} />{' '}
              Keep pm.* in scripts
            </label>
            <Button variant="primary" loading={busy} disabled={!plans.length && !preview?.snippets} onClick={() => void apply()}>
              Import{plans.length > 1 ? ` ${plans.length} files` : ''}
            </Button>
          </>
        ) : (
          <>
            {!undone && applied && applied.receipts.length > 0 && (
              <Button icon={<Undo2 size={13} />} loading={busy} onClick={() => void undo()}>
                Undo import
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {step === 'source' && (
        <div className="flex flex-col gap-2">
          {migrate && (
            <div className="flex gap-1" role="group" aria-label="Migrate from">
              {(Object.keys(MIGRATE_TOOLS) as MigrateTool[]).map((k) => (
                <Button key={k} size="sm" variant={tool === k ? 'primary' : 'default'} aria-pressed={tool === k} onClick={() => setTool(k)}>
                  {MIGRATE_TOOLS[k].label}
                </Button>
              ))}
            </div>
          )}
          {guide ? <p className="text-sm text-muted">{guide.how}</p> : <p className="text-sm text-muted">Drop files, a folder or a link anywhere on the window, or choose them below. Postman, Insomnia, Bruno (folders and OpenCollection YAML), Hoppscotch, OpenAPI / Swagger, AsyncAPI, HAR, WSDL, GraphQL schemas, .env, .http, cURL and TestPion files. A ZIP (a Postman data export, a zipped collection) is opened. You see what will be created, and what will not come over, before anything is written.</p>}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim() && !busy) void run({ url: link.trim() });
            }}
          >
            <Input className="flex-1" aria-label="Link to import" placeholder="Or a link: https://…/openapi.json, a GitHub file, postman:collection/<id>" value={link} onChange={(e) => setLink(e.target.value)} />
            <Button type="submit" icon={<Link2 size={13} />} disabled={!/^(https?:\/\/\S+|postman:\S+)$/i.test(link.trim())} loading={busy && !!link.trim()}>
              Preview link
            </Button>
          </form>
          {(tool === 'postman' || link.startsWith('postman:')) && (
            <Field label="Postman API key" hint={keySet ? 'A key is saved in the secret store. Enter a new one to replace it, or clear to remove it.' : 'Only for postman:… ids and links. Create one in Postman ▸ Settings ▸ API keys. Kept in the secret store, sent only to api.getpostman.com.'}>
              <div className="flex gap-2">
                <Input type="password" className="mono flex-1" aria-label="Postman API key" value={key} onChange={(e) => setKey(e.target.value)} placeholder={keySet ? '••••••••' : 'PMAK-…'} />
                <Button
                  disabled={!key.trim() && !keySet}
                  onClick={() =>
                    void call<{ set: boolean }>('import.setPostmanKey', { key }).then((r) => {
                      setKeySet(r.set);
                      setKey('');
                    }, toastError)
                  }
                >
                  {key.trim() ? 'Save key' : 'Remove key'}
                </Button>
              </div>
            </Field>
          )}
          <Textarea autoGrow={false} className="field mono w-full h-48 text-xs" placeholder="Or paste a document or a cURL command here…" value={text} onChange={(e) => setText(e.target.value)} />
          {busy && (
            <p className="text-sm text-muted flex items-center gap-2">
              <Spinner /> Reading…
            </p>
          )}
        </div>
      )}
      {step === 'preview' && preview && (
        <div className="flex flex-col gap-3" data-import-preview>
          {plans.map((p, i) => (
            <PlanCard key={i} source={p.input.source} plan={p.plan} single={plans.length === 1} />
          ))}
          {preview.snippets > 0 && <p className="text-sm">{preview.snippets} copied request{preview.snippets === 1 ? '' : 's'} (cURL, fetch …) will be saved to the <b>Imported</b> collection, with secrets replaced by variables.</p>}
          {failed.map((p, i) => (
            <p key={i} className="text-sm text-bad">
              {p.input.source}: cannot be imported: {'error' in p ? p.error.message : ''}
            </p>
          ))}
          {preview.skipped.length > 0 && (
            <details className="text-xs text-muted">
              <summary>{preview.skipped.length} file{preview.skipped.length === 1 ? '' : 's'} skipped</summary>
              <ul className="mt-1">
                {preview.skipped.slice(0, 50).map((s) => (
                  <li key={s.path}>
                    <span className="mono">{s.path}</span>: {s.why}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-xs text-muted">Nothing has been written yet.</p>
        </div>
      )}
      {step === 'done' && applied && (
        <div className="flex flex-col gap-3" data-import-done>
          {undone && <p className="text-sm text-ok">Undone. What was imported is in Recently deleted (Workspace ▸ Recently deleted), and can be restored.</p>}
          {applied.imported.map((i, n) =>
            i.result ? (
              <div key={n} className="border border-border rounded-md p-2 flex flex-col gap-2">
                <div className="font-medium text-sm">
                  {i.input.source} <span className="text-muted font-normal">→ {[i.result.collection?.name, ...(i.result.environments ?? []).map((e) => e.name)].filter(Boolean).join(', ') || i.result.format}</span>
                </div>
                {i.result.report && <ImportReportView report={i.result.report} markdown={() => call<string>('import.reportMarkdown', { report: i.result!.report })} />}
              </div>
            ) : (
              <p key={n} className="text-sm text-bad">
                {i.input.source}: {i.error?.message}
              </p>
            ),
          )}
        </div>
      )}
    </Modal>
  );
}

function PlanCard({ source, plan, single }: { source: string; plan: ImportPlan; single: boolean }) {
  const made = [
    ...plan.collections.map((c) => `collection "${c.name}": ${c.requests} request${c.requests === 1 ? '' : 's'}${c.folders ? `, ${c.folders} folder${c.folders === 1 ? '' : 's'}` : ''}${c.nameTaken ? ' (a collection of this name exists: this one is added beside it)' : ''}`),
    ...plan.environments.map((e) => `environment "${e.renamedTo ?? e.name}": ${e.variables} variable${e.variables === 1 ? '' : 's'}${e.secrets ? `, ${e.secrets} secret` : ''}${e.renamedTo ? ' (renamed: the name is taken)' : ''}`),
    ...plan.specs.map((s) => `API definition ${s.path}${s.existing === 'different' ? ' (a different document is there: both are kept)' : s.existing === 'same' ? ' (already there)' : ''}`),
    ...plan.flows.map((f) => `flow ${f.path} (${f.steps} steps)`),
    ...Object.entries(plan.library).map(([k, n]) => `${n} ${k === 'grpc' ? 'gRPC call' : 'connection'}${n === 1 ? '' : 's'}`),
  ];
  return (
    <div className="border border-border rounded-md p-2 flex flex-col gap-2" data-import-plan>
      <div className="text-sm">
        <span className="font-medium">{source}</span> <span className="text-muted">{plan.tool ?? plan.format}</span>
      </div>
      <ul className="text-sm list-disc pl-5">
        {made.map((m) => (
          <li key={m}>Creates {m}</li>
        ))}
        {plan.secretValues > 0 && <li>{plan.secretValues} secret value{plan.secretValues === 1 ? '' : 's'} go to the secret store, never into workspace files</li>}
      </ul>
      {plan.collections.map((c, i) => c.tree.length > 0 && <ImportTree key={i} nodes={c.tree} />)}
      {plan.collections.some((c) => c.truncated) && <p className="text-xs text-muted">The tree shows the first 2000 items.</p>}
      <details open={single || plan.report.summary.changed + plan.report.summary.notImported > 0}>
        <summary className="text-sm cursor-pointer">Compatibility report</summary>
        <div className="mt-2">
          <ImportReportView report={plan.report} />
        </div>
      </details>
    </div>
  );
}
