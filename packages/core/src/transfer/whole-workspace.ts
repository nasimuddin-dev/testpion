/**
 * A whole workspace as a bundle, both ways (B-41i). `workspace export` (the CLI, the workspace menu's Export…) writes the
 * same bundle `testpion export --all` writes, and a bundle opens as a NEW workspace here, so the workspace menu's Import…
 * still turns an export into a workspace of its own. The one-file workspace export of earlier versions
 * (storage/workspace-bundle.ts) is only read now (it is read for two more releases, then removed): it is no longer written.
 */
import { ApsError } from '../errors.js';
import type { ReplacedSecret } from '../storage/bundle-secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { WorkspaceManager } from '../storage/workspace-manager.js';
import { applyImport, type ImportOutcome } from './apply.js';
import { buildBundleAsync, type BuildOptions, type BuildResult } from './export.js';
import type { BundleKindId, ParsedBundle } from './format.js';

/** What an export holds, in numbers and words, for the app's toast, the CLI and `--json` (one wording everywhere). */
export interface WorkspaceExportSummary {
  collections: number;
  environments: number;
  tests: number;
  /** Files of specs/, datasets/, mocks/ and protos/. */
  files: number;
  /** What was left out and why. */
  notes: string[];
  /** Secrets replaced by variables (where, and the variable; never the value). */
  replaced: ReplacedSecret[];
  /** One line each: what is in it, what was replaced, what was left out. */
  lines: string[];
}

export type WorkspaceExport = BuildResult & { summary: WorkspaceExportSummary };

const FILE_KINDS: readonly BundleKindId[] = ['spec', 'dataset', 'proto', 'mcp-mock'];

/** The whole workspace as a bundle (every kind, AI providers included as the earlier export had them; no secret value is written). */
export async function exportWholeWorkspace(store: WorkspaceStore, opts: Pick<BuildOptions, 'format' | 'datasets' | 'title'> = {}): Promise<WorkspaceExport> {
  const built = await buildBundleAsync(store, 'all', { providers: true, title: opts.title ?? store.workspace.name, format: opts.format, datasets: opts.datasets });
  // the workspace's own variables (the Globals) travel in the manifest's workspace section; the notes say so
  const notes = built.notes;
  const lines = built.lines;
  const n = (k: BundleKindId) => built.counts[k] ?? 0;
  return {
    ...built,
    notes,
    lines,
    summary: {
      collections: n('collection'),
      environments: n('environment'),
      tests: n('test'),
      files: FILE_KINDS.reduce((sum, k) => sum + n(k), 0),
      notes,
      replaced: built.replaced,
      lines,
    },
  };
}

/** What importing a bundle as a new workspace did: the workspace, what was skipped (in this import's own words) and the values to fill in. */
export interface NewWorkspaceFromBundle {
  store: WorkspaceStore;
  notes: string[];
  /** Variables the exporter replaced a secret with: `name (where)`. */
  valuesNeeded: string[];
  /** Files of specs/, datasets/, mocks/ and protos/ written. */
  files: number;
  outcome: ImportOutcome;
}

/** Open a bundle as a NEW workspace (its name gets a number when it is taken, unless `name` is given). A failure leaves no half-made workspace behind. */
export function importBundleAsWorkspace(manager: WorkspaceManager, bundle: ParsedBundle, name?: string): NewWorkspaceFromBundle {
  const base = name ?? `${bundle.manifest.title} (imported)`;
  const taken = new Set(manager.list().map((w) => w.name));
  let unique = base;
  for (let i = 2; !name && taken.has(unique); i++) unique = `${base} ${i}`;
  const store = manager.create(unique);
  try {
    // the new workspace starts with a default environment: the bundle's own environments replace it
    const envs = bundle.manifest.items.filter((i) => i.kind === 'environment');
    if (envs.length && !envs.some((e) => e.id === 'development')) store.deleteEnvironment('development');
    const outcome = applyImport(store, bundle, { onConflict: 'replace', workspaceVariables: 'replace' });
    const written = [...outcome.created, ...outcome.replaced];
    return {
      store,
      notes: [...outcome.warnings, ...outcome.skipped.map((s) => `${s.kind} ${s.name}: ${s.why ?? 'skipped'}`)],
      valuesNeeded: outcome.requires.secrets.map((s) => `${s.name} (${s.where})`),
      files: written.filter((w) => FILE_KINDS.includes(w.kind)).length,
      outcome,
    };
  } catch (e) {
    store.close();
    try {
      manager.delete(store.root);
    } catch {
      /* the error below says what failed */
    }
    throw e instanceof ApsError ? e : new ApsError('ValidationError', `Not a valid TestPion bundle: ${e instanceof Error ? e.message : String(e)}`);
  }
}
