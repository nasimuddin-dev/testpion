import type { CollectionNode } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { workspaceNodeIds } from '../storage/node-ids.js';
import { ApsError, normalizeError } from '../errors.js';
import type { NormalizedError } from '../model/types.js';
import { importDocument } from './importers.js';
import { legacyResult } from './pipeline.js';
import type { ImportReport } from './report.js';
import type { ImportScriptsMode } from './import-scripts.js';
import { plannedSpecs, importIntoWorkspace, type SpecConflict, type WorkspaceImportResult } from './workspace-import.js';
import { existsSync, readFileSync } from 'node:fs';
import { undoImportReceipt, type UndoResult } from './import-receipt.js';
import type { ImportInput, SkippedFile } from './inputs.js';
import type { SecretStore } from '../storage/secrets.js';

/**
 * The preview of an import: everything it would create and everything that would not come over, computed without
 * writing a thing (the app's preview dialog, `testpion import --preview --json`, MCP `import_definition` with
 * `preview`). `importMany` then does the import for a list of inputs, `undoMany` takes it back.
 */

export interface PlanNode {
  kind: 'folder' | 'http' | 'graphql';
  name: string;
  method?: string;
  /** `changed`: something of it did not map one to one (the report says what). */
  status: 'full' | 'changed';
  children?: PlanNode[];
}

export interface ImportPlan {
  format: string;
  tool?: string;
  fileCount: number;
  bytes: number;
  collections: Array<{ name: string; folders: number; requests: number; /** The workspace already has a collection of this name. */ nameTaken: boolean; tree: PlanNode[]; /** Nodes beyond the first 2000 that the tree leaves out. */ truncated?: number }>;
  environments: Array<{ name: string; variables: number; secrets: number; /** The workspace has one of this name: it is imported as this. */ renamedTo?: string }>;
  /** API definitions kept in the workspace, with what is there already. */
  specs: Array<{ path: string; existing?: 'same' | 'different' }>;
  /** Flow files (Arazzo): where they are written. */
  flows: Array<{ path: string; steps: number }>;
  /** gRPC calls and connections (library items), by kind. */
  library: Record<string, number>;
  /** Secret values the import would write to the secret store (a .env file): the count only. */
  secretValues: number;
  report: ImportReport;
}

const TREE_CAP = 2000;

function treeOf(nodes: CollectionNode[], path: string[], changed: Set<string>, budget: { left: number; dropped: number }): PlanNode[] {
  const out: PlanNode[] = [];
  for (const n of nodes) {
    if (budget.left <= 0) {
      budget.dropped++;
      continue;
    }
    budget.left--;
    const p = [...path, n.name];
    const status = changed.has(p.join(' / ')) ? 'changed' : 'full';
    if (n.kind === 'folder') out.push({ kind: 'folder', name: n.name, status, children: treeOf(n.items, p, changed, budget) });
    else out.push({ kind: n.kind, name: n.name, status, ...(n.kind === 'http' ? { method: n.request.method } : {}) });
  }
  return out;
}

/** What importing this text into the workspace would do. Nothing is written. */
export function planImport(store: WorkspaceStore, text: string, opts: { name?: string; scripts?: ImportScriptsMode } = {}): ImportPlan {
  const { document, report } = importDocument(text, { name: opts.name, scripts: opts.scripts, takenIds: workspaceNodeIds(store.listCollections()) });
  const changed = new Set(document.findings.filter((f) => f.severity !== 'info').map((f) => f.where.join(' / ')));
  const names = new Set(store.listCollections().map((c) => c.name.toLowerCase()));
  const envNames = new Set(store.listEnvironments().map((e) => e.name.toLowerCase()));
  const r = legacyResult(document);
  const specs = plannedSpecs(r, text).map((s) => {
    const rel = `${s.stem}${s.suffix}`;
    let existing: 'same' | 'different' | undefined;
    if (existsSync(store.safePath(rel))) {
      try {
        existing = readFileSync(store.safePath(rel), 'utf8') === s.text ? 'same' : 'different';
      } catch {
        existing = 'different';
      }
    }
    return { path: rel, ...(existing ? { existing } : {}) };
  });
  const saved = document.savedItems && typeof document.savedItems === 'object' ? Object.entries(document.savedItems as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0] as const) : [];
  return {
    format: document.format,
    ...(document.tool ? { tool: document.tool } : {}),
    fileCount: document.fileCount,
    bytes: document.bytes,
    collections: document.collections.map((c) => {
      const budget = { left: TREE_CAP, dropped: 0 };
      const tree = treeOf(c.items, [], changed, budget);
      let folders = 0;
      let requests = 0;
      const walk = (ns: CollectionNode[]) => ns.forEach((n) => (n.kind === 'folder' ? (folders++, walk(n.items)) : requests++));
      walk(c.items);
      return { name: c.name, folders, requests, nameTaken: names.has(c.name.toLowerCase()), tree, ...(budget.dropped ? { truncated: budget.dropped } : {}) };
    }),
    environments: document.environments.map((e) => {
      const taken = envNames.has(e.name.toLowerCase());
      return { name: e.name, variables: e.variables.length, secrets: e.variables.filter((v) => v.secret).length, ...(taken ? { renamedTo: `${e.name} (imported)` } : {}) };
    }),
    specs,
    flows: (document.flows ?? []).map((f) => ({ path: f.path, steps: f.steps })),
    library: Object.fromEntries(saved.filter(([, n]) => n > 0)),
    secretValues: Object.values(document.secretValues ?? {}).reduce((n, v) => n + Object.keys(v).length, 0),
    report,
  };
}

/** One input of a multi-file import, planned or failed. */
export type PlannedInput = { input: Pick<ImportInput, 'name' | 'source' | 'fileCount'>; plan: ImportPlan } | { input: Pick<ImportInput, 'name' | 'source' | 'fileCount'>; error: NormalizedError };

export interface ImportManyPlan {
  inputs: PlannedInput[];
  skipped: SkippedFile[];
  totals: { collections: number; requests: number; environments: number; changed: number; notImported: number; valuesNeeded: number; errors: number };
}

/** The plans of several inputs (a failing one is reported, the others still plan). */
export function planInputs(store: WorkspaceStore, inputs: ImportInput[], skipped: SkippedFile[] = [], opts: { scripts?: ImportScriptsMode } = {}): ImportManyPlan {
  const planned: PlannedInput[] = inputs.map((input) => {
    const id = { name: input.name, source: input.source, fileCount: input.fileCount };
    try {
      return { input: id, plan: planImport(store, input.text, { name: input.name, scripts: opts.scripts }) };
    } catch (e) {
      return { input: id, error: normalizeError(e) };
    }
  });
  const plans = planned.flatMap((p) => ('plan' in p ? [p.plan] : []));
  return {
    inputs: planned,
    skipped,
    totals: {
      collections: plans.reduce((n, p) => n + p.collections.length, 0),
      requests: plans.reduce((n, p) => n + p.collections.reduce((m, c) => m + c.requests, 0), 0),
      environments: plans.reduce((n, p) => n + p.environments.length, 0),
      changed: plans.reduce((n, p) => n + p.report.summary.changed, 0),
      notImported: plans.reduce((n, p) => n + p.report.summary.notImported, 0),
      valuesNeeded: plans.reduce((n, p) => n + p.report.summary.valuesNeeded, 0),
      errors: planned.length - plans.length,
    },
  };
}

export interface ImportedInput {
  input: Pick<ImportInput, 'name' | 'source' | 'fileCount'>;
  result?: WorkspaceImportResult;
  error?: NormalizedError;
}

/** Import several inputs in order; one that fails does not stop the others. `receipts` are what `undoMany` takes. */
export function importInputs(
  store: WorkspaceStore,
  inputs: ImportInput[],
  opts: { contractChecks?: boolean; secrets?: SecretStore; scripts?: ImportScriptsMode; specs?: SpecConflict; envName?: (input: ImportInput) => string | undefined; arazzo?: (input: ImportInput) => { baseDir?: string; sources?: Record<string, string> } | undefined } = {},
): { imported: ImportedInput[]; receipts: string[] } {
  const imported: ImportedInput[] = [];
  const receipts: string[] = [];
  for (const input of inputs) {
    const id = { name: input.name, source: input.source, fileCount: input.fileCount };
    try {
      const result = importIntoWorkspace(store, input.text, { contractChecks: opts.contractChecks, secrets: opts.secrets, scripts: opts.scripts, specs: opts.specs, arazzo: opts.arazzo?.(input), name: opts.envName?.(input) ?? input.name });
      if (result.receipt) receipts.push(result.receipt.id);
      imported.push({ input: id, result });
    } catch (e) {
      imported.push({ input: id, error: normalizeError(e) });
    }
  }
  return { imported, receipts };
}

/** Take back several imports (the ids `importInputs` returned). */
export function undoMany(store: WorkspaceStore, receipts: string[], opts: { force?: boolean } = {}): UndoResult[] {
  if (!receipts.length) throw new ApsError('ValidationError', 'No import to undo', { suggestions: [] });
  return receipts.map((id) => undoImportReceipt(store, id, opts));
}

