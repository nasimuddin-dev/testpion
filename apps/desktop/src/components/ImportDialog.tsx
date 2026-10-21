import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Link2, Upload, Undo2 } from 'lucide-react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { LABEL } from '../lib/vocabulary';
import { aiHidden } from '../lib/ai-visible';
import { startTidyImport } from './ai/flow-generate';
import { toastSpecKeptBoth } from '../lib/spec-import';
import { toastImportNotes, toastUnchangedScripts } from '../lib/import-scripts';
import { IMPORT_FILE_ACCEPT, MIGRATE_TOOLS, type MigrateTool } from '@testpion/shared';
import type { ImportManyPlan, ImportPlan, ImportReport, ImportSource, ReimportAction } from '../types';
import { pickImportFiles, pickImportFolder } from '../lib/import-files';
import { bundleRequestOf, openImportBundle } from '../lib/transfer';
import { plural } from '../lib/format';
import { Button, Field, Input, LinkButton, Modal, Segmented, Select, Spinner, Textarea, Toggle } from './ui';
import { ImportReportView, ImportTree } from './ImportReport';

export { MIGRATE_TOOLS, type MigrateTool } from '@testpion/shared';

type Step = 'source' | 'preview' | 'done';

interface Applied {
  imported: Array<{ input: { name: string; source: string }; result?: { format: string; report?: ImportReport; updated?: Array<{ collectionId: string; name: string; applied: { replaced: number; added: number; skipped: number } }>; collection?: { id: string; name: string }; environments?: Array<{ name: string }>; flows?: Array<{ path: string }>; notes?: string[]; specKeptBoth?: { existing: string }; specPath?: string; scriptWarnings?: Array<{ where: string; script: string; api: string; hint: string }>; scripts?: Parameters<typeof toastUnchangedScripts>[0] }; error?: { message: string } }>;
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
  // the tool choice: Home's "Migrate from…", the palette's, or "Coming from another tool?" in this dialog
  const [choosing, setChoosing] = useState(!!migrate);
  // a new step is announced and gets the focus (a screen reader hears the preview or the result arrive)
  const stepBody = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const [step, setStep] = useState<Step>('source');
  const [preview, setPreview] = useState<(ImportManyPlan & { sessionId: string; snippets: number }) | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [keepPm, setKeepPm] = useState(false);
  const [liftTests, setLiftTests] = useState(false);
  // a source imported before updates the collection it made: per item replace / new / skip, or a copy beside it
  const [newCopy, setNewCopy] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, ReimportAction>>({});
  const [keySet, setKeySet] = useState(false);
  const [key, setKey] = useState('');
  const [undone, setUndone] = useState(false);
  const sessionRef = useRef<string | undefined>(undefined);

  const run = async (src: ImportSource) => {
    // one Import entry: a bundle chosen or dropped here goes to the bundle preview
    const bundle = bundleRequestOf(src);
    if (bundle) {
      onClose();
      return openImportBundle(bundle);
    }
    setBusy(true);
    try {
      const p = await call<ImportManyPlan & { sessionId: string; snippets: number }>('import.preview', { ...src, keepPm, liftTests });
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

  useEffect(() => {
    if (first.current) return void (first.current = false);
    stepBody.current?.focus();
  }, [step]);
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await call<Applied>('import.apply', { sessionId: preview.sessionId, keepPm, liftTests, newCopy, decisions });
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
        if (x.collection && !aiHidden() && /^(postman|har|insomnia|bruno|hoppscotch|opencollection)/i.test(x.format))
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
  const liftable = plans.reduce((n, p) => n + (p.plan.report.findings.find((f) => f.code === 'TESTS_LIFTABLE') ? Number(/^(\d+)/.exec(p.plan.report.findings.find((f) => f.code === 'TESTS_LIFTABLE')!.message)?.[1] ?? 0) : 0), 0);
  const updates = plans.flatMap((p) => p.plan.reimport ?? []);

  return (
    <Modal
      title={step === 'source' ? (guide ? `Migrate from ${guide.label}` : 'Import') : step === 'preview' ? 'Import: preview' : 'Import: done'}
      onClose={onClose}
      width={720}
      footer={
        step === 'source' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button icon={<Upload size={13} />} variant={text.trim() ? 'default' : 'primary'} loading={busy} onClick={pick(() => pickImportFiles(IMPORT_FILE_ACCEPT))}>
              Choose files…
            </Button>
            <Button icon={<FolderOpen size={13} />} loading={busy} title="A collection folder (Bruno, OpenCollection) or a folder of files" onClick={pick(pickImportFolder)}>
              Choose folder…
            </Button>
            <Button variant={text.trim() ? 'primary' : 'default'} loading={busy} disabled={!text.trim()} onClick={() => void run({ text })}>
              Preview pasted content
            </Button>
          </>
        ) : step === 'preview' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="ghost" onClick={() => setStep('source')} className="mr-auto">
              Back
            </Button>
            <Toggle checked={keepPm} onChange={setKeepPm} label="Keep Postman scripts as they are" title="Postman and Insomnia scripts are converted to TestPion's own script API (tp.*), and the Postman form (pm.*) still runs. Turn this on to keep the scripts exactly as exported. Exporting to Postman turns them back." />
            {liftable > 0 && (
              <span data-import-lift>
                <Toggle checked={liftTests} onChange={setLiftTests} label={`Turn ${plural(liftable, 'simple test')} into checks`} title="A test that only checks a status, a response time, a header or a JSON field becomes a check in the request's Tests tab (readable without running the script). The rest of the script is kept." />
              </span>
            )}
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
      <div ref={stepBody} tabIndex={-1} className="outline-none">
      {step === 'source' && (
        <div className="flex flex-col gap-2">
          {choosing && (
            <div className="flex gap-1" role="group" aria-label="Migrate from">
              {(Object.keys(MIGRATE_TOOLS) as MigrateTool[]).map((k) => (
                <Button key={k} size="sm" variant={tool === k ? 'primary' : 'default'} aria-pressed={tool === k} onClick={() => setTool(k)}>
                  {MIGRATE_TOOLS[k].label}
                </Button>
              ))}
            </div>
          )}
          {guide ? <p className="text-sm text-muted">{guide.how}</p> : <p className="text-sm text-muted">Drop files, a folder or a link anywhere on the window, or choose them below. Postman (v1, v2, Git folders), Insomnia, Bruno (folders and OpenCollection YAML), Hoppscotch, Thunder Client, Yaak, HTTPie, Apidog, OpenAPI / Swagger, AsyncAPI, HAR, WSDL, GraphQL schemas, .env, .http, cURL, TestPion files and TestPion bundles (a bundle opens its own preview). A ZIP (a Postman data export, a zipped collection) is opened. You see what will be created, and what will not come over, before anything is written.</p>}
          {!choosing && (
            <p className="text-xs">
              <LinkButton icon={null} onClick={() => setChoosing(true)} data-import-migrate>
                Coming from another tool? See how to export from Postman, Insomnia, Bruno and others
              </LinkButton>
            </p>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (link.trim() && !busy) void run({ url: link.trim() });
            }}
          >
            <Input className="flex-1" aria-label="Link to import" placeholder="Or a link: https://…/openapi.json, a GitHub or GitLab file or folder, postman:collection/<id>" value={link} onChange={(e) => setLink(e.target.value)} />
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
            <p className="text-sm text-muted flex items-center gap-2" role="status">
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
          {updates.length > 0 && <UpdateSection updates={updates} newCopy={newCopy} setNewCopy={setNewCopy} decisions={decisions} setDecisions={setDecisions} />}
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
        <div className="flex flex-col gap-3" data-import-done role="status" aria-live="polite">
          {undone && <p className="text-sm text-ok">Undone. What was imported is in Recently deleted (Workspace ▸ Recently deleted), and can be restored.</p>}
          {applied.imported.map((i, n) =>
            i.result ? (
              <div key={n} className="border border-border rounded-md p-2 flex flex-col gap-2">
                <div className="font-medium text-sm">
                  {i.input.source} <span className="text-muted font-normal">→ {[i.result.collection?.name, ...(i.result.environments ?? []).map((e) => e.name)].filter(Boolean).join(', ') || i.result.format}</span>
                </div>
                {i.result.updated?.map((u) => (
                  <p key={u.collectionId} className="text-sm" data-import-updated>
                    Updated <b>{u.name}</b>: {u.applied.replaced} replaced, {u.applied.added} added, {u.applied.skipped} left as they are.
                  </p>
                ))}
                {i.result.report && (
                  <ImportReportView
                    report={i.result.report}
                    markdown={() => call<string>('import.reportMarkdown', { report: i.result!.report })}
                    onFixWithAi={!aiHidden() && i.result.collection ? () => startTidyImport({ collectionId: i.result!.collection!.id, source: i.result!.format, task: 'import-leftovers' }) : undefined}
                  />
                )}
              </div>
            ) : (
              <p key={n} className="text-sm text-bad">
                {i.input.source}: {i.error?.message}
              </p>
            ),
          )}
        </div>
      )}
      </div>
    </Modal>
  );
}

function PlanCard({ source, plan, single }: { source: string; plan: ImportPlan; single: boolean }) {
  const made = [
    ...plan.collections.map((c) => `collection "${c.name}": ${plural(c.requests, 'request')}${c.folders ? `, ${plural(c.folders, 'folder')}` : ''}${c.nameTaken ? ' (a collection of this name exists: this one is added beside it)' : ''}`),
    ...plan.environments.map((e) => `environment "${e.renamedTo ?? e.name}": ${plural(e.variables, 'variable')}${e.secrets ? `, ${plural(e.secrets, 'secret')}` : ''}${e.renamedTo ? ' (renamed: the name is taken)' : ''}`),
    ...plan.specs.map((s) => `API definition ${s.path}${s.existing === 'different' ? ' (a different document is there: both are kept)' : s.existing === 'same' ? ' (already there)' : ''}`),
    ...plan.flows.map((f) => `flow ${f.path} (${f.steps} steps)`),
    ...Object.entries(plan.library).map(([k, n]) => plural(n, k === 'grpc' ? 'gRPC call' : 'connection')),
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
        {plan.secretValues > 0 && <li>{plural(plan.secretValues, 'secret value')} go to the secret store, never into workspace files</li>}
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

/**
 * A source imported before: the import updates the collection it made instead of adding another. Each item that changed in the
 * source (replace), is new (new) or was edited here too (a conflict: skipped unless you choose Replace) is listed with its
 * choice; the unchanged ones are only counted. "Add a copy instead" turns the update off.
 */
function UpdateSection({ updates, newCopy, setNewCopy, decisions, setDecisions }: { updates: NonNullable<ImportPlan['reimport']>; newCopy: boolean; setNewCopy(v: boolean): void; decisions: Record<string, ReimportAction>; setDecisions(d: Record<string, ReimportAction>): void }) {
  return (
    <div className="border border-border rounded-md p-2 flex flex-col gap-2" data-import-update>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium">This source was imported before</span>
        <Segmented
          label="What to do"
          value={newCopy ? 'copy' : 'update'}
          onChange={(v) => setNewCopy(v === 'copy')}
          options={[
            { value: 'update', label: 'Update the collection', title: 'Replace what changed in the source, add what is new, leave what you edited' },
            { value: 'copy', label: 'Add a copy', title: 'Import it again as a second collection' },
          ]}
        />
      </div>
      {!newCopy &&
        updates.map((u) => {
          const shown = [u.root, ...u.items].filter((i) => i.action !== 'skip' || i.conflict);
          return (
            <div key={u.collectionId} className="flex flex-col gap-1">
              <p className="text-sm">
                <b>{u.collectionName}</b>: {u.counts.replace} to replace, {u.counts.new} new, {u.counts.skip} unchanged or left alone{u.counts.conflicts ? `, ${u.counts.conflicts} edited here too` : ''}
                {u.gone.length ? `; ${u.gone.length} no longer in the source (kept)` : ''}.
              </p>
              {shown.length > 0 && (
                <ul className="flex flex-col gap-1 max-h-48 overflow-auto" data-import-update-items>
                  {shown.slice(0, 300).map((i) => (
                    <li key={i.key} className="flex items-center gap-2 text-xs" data-import-update-item={i.action}>
                      <span className="mono truncate flex-1" title={i.reason}>
                        {i.path.length ? i.path.join(' / ') : 'Collection settings'} <span className="text-muted">{i.reason}</span>
                      </span>
                      <Select aria-label={`Action for ${i.path.join(' / ') || 'the collection settings'}`} className="text-xs" value={decisions[i.key] ?? i.action} onChange={(e) => setDecisions({ ...decisions, [i.key]: e.target.value as ReimportAction })}>
                        <option value="replace">Replace it</option>
                        <option value="new">Add as new</option>
                        <option value="skip">Leave it</option>
                      </Select>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
    </div>
  );
}
