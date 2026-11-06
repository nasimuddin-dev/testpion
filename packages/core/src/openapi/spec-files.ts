/** API definitions as the app, the CLI and the MCP server take them: a link, a file in the workspace's specs/, or the text. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { fetchImportText } from '../import/fetch-url.js';
import { loadOpenApi, requestBodySchema } from './contract.js';
import { sharedSpecFile, sharedSpecs } from '../storage/shared-sources.js';

type SpecStore = Pick<WorkspaceStore, 'safePath'> & Partial<Pick<WorkspaceStore, 'root' | 'workspace'>>;

/**
 * The file of an API definition to read: one in the workspace, or one a shared folder gives (`../platform-shared/specs/x.yaml`,
 * workspace.json `shared`). Anything else outside the workspace is refused, as by `safePath`.
 */
export function specFileToRead(store: SpecStore, path: string): string {
  const shared = store.root && store.workspace ? sharedSpecFile({ root: store.root, workspace: store.workspace }, path) : undefined;
  return shared ?? store.safePath(path);
}

/**
 * The name generated tests and flows take from a definition's path: the file (specs/clinic.yaml → clinic); one a shared
 * folder gives keeps the folder's name (../platform-shared/specs/clinic.yaml → platform-shared-clinic), so its tests never
 * land on the workspace's own clinic tests.
 */
export function apiNameOf(specPath: string | undefined): string | undefined {
  if (!specPath) return undefined;
  const parts = specPath.replace(/\\/g, '/').split('/');
  const file = parts[parts.length - 1]!;
  const at = parts.lastIndexOf('specs');
  const from = specPath.startsWith('../') && at > 0 ? parts[at - 1] : undefined;
  return from && from !== '..' ? `${from}-${file}` : file;
}

/** One of: an http(s) link to download, a path inside the workspace, or the document text itself. */
export interface SpecRef {
  path?: string;
  url?: string;
  text?: string;
}

const SPEC_FILE = /\.(json|ya?ml)$/i;

/** A string as agents give it: a link, something that looks like a file path, or else the document text. */
function specRefOf(ref: string): SpecRef {
  if (/^https?:\/\//i.test(ref)) return { url: ref };
  if (!/[\n{]/.test(ref) && SPEC_FILE.test(ref)) return { path: ref };
  return { text: ref };
}

/**
 * The text of an API definition. `path` is read inside the workspace (never outside it) unless `roots` is given: then
 * it is tried under each root in turn, as the CLI takes a file as given or relative to the workspace folder.
 */
export async function readSpecRef(store: SpecStore | undefined, ref: SpecRef | string, opts: { roots?: string[] } = {}): Promise<string> {
  const r = typeof ref === 'string' ? specRefOf(ref) : ref;
  if (r.text !== undefined) return r.text;
  if (r.url) return (await fetchImportText(r.url)).text;
  if (!r.path) return '';
  let file: string;
  if (opts.roots?.length) {
    const candidates = opts.roots.map((root) => resolve(root, r.path!));
    file = candidates.find((c) => existsSync(c)) ?? candidates[0]!;
  } else {
    if (!store) throw new ApsError('ConfigurationError', `Cannot read ${r.path}: no workspace to read it from`);
    file = specFileToRead(store, r.path);
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new ApsError('ConfigurationError', `Cannot read ${r.path}: ${(e as Error).message}`);
  }
}

/**
 * The API definitions kept in the workspace, as paths from its root (`specs/clinic.yaml`; with `includeAsync`,
 * `specs/asyncapi/*` too); with `includeShared`, then those shared folders give (`../platform-shared/specs/x.yaml`).
 */
export function listSpecs(store: Pick<WorkspaceStore, 'path'> & Partial<Pick<WorkspaceStore, 'root' | 'workspace'>>, opts: { includeAsync?: boolean; includeShared?: boolean } = {}): string[] {
  const list = (rel: string) => {
    const dir = store.path(...rel.split('/'));
    return existsSync(dir) ? readdirSync(dir).filter((f) => SPEC_FILE.test(f)).map((f) => `${rel}/${f}`) : [];
  };
  const own = [...list('specs'), ...(opts.includeAsync ? list('specs/asyncapi') : [])];
  return opts.includeShared && store.root && store.workspace ? [...own, ...sharedSpecs({ root: store.root, workspace: store.workspace }, opts)] : own;
}

/**
 * The JSON Schema a request body should follow, from the operation `method url` maps to in one of the workspace's
 * OpenAPI documents (specs/), with the document it came from; null when none describes it.
 */
export function findBodySchema(store: SpecStore & Pick<WorkspaceStore, 'path'>, method: string, url: string): (ReturnType<typeof requestBodySchema> & { spec: string }) | null {
  if (!url) return null;
  // the workspace's own first, then the shared ones (a shared platform API describes calls of this workspace too)
  for (const spec of [...listSpecs(store).sort(), ...listSpecs(store, { includeShared: true }).filter((s) => s.startsWith('../'))]) {
    try {
      const r = requestBodySchema(loadOpenApi(readFileSync(specFileToRead(store, spec), 'utf8')), method, url);
      if (r) return { ...r, spec };
    } catch {
      /* not an OpenAPI document, or unreadable: the next one */
    }
  }
  return null;
}
