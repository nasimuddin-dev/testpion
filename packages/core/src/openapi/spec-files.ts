/** API definitions as the app, the CLI and the MCP server take them: a link, a file in the workspace's specs/, or the text. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ApsError } from '../errors.js';
import { fetchImportText } from '../import/fetch-url.js';
import { loadOpenApi, requestBodySchema } from './contract.js';

/** One of: an http(s) link to download, a path inside the workspace, or the document text itself. */
export interface SpecRef {
  path?: string;
  url?: string;
  text?: string;
}

const SPEC_FILE = /\.(json|ya?ml)$/i;

/** A string as agents give it: a link, something that looks like a file path, or else the document text. */
export function specRefOf(ref: string): SpecRef {
  if (/^https?:\/\//i.test(ref)) return { url: ref };
  if (!/[\n{]/.test(ref) && SPEC_FILE.test(ref)) return { path: ref };
  return { text: ref };
}

/**
 * The text of an API definition. `path` is read inside the workspace (never outside it) unless `roots` is given: then
 * it is tried under each root in turn, as the CLI takes a file as given or relative to the workspace folder.
 */
export async function readSpecRef(store: Pick<WorkspaceStore, 'safePath'> | undefined, ref: SpecRef | string, opts: { roots?: string[] } = {}): Promise<string> {
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
    file = store.safePath(r.path);
  }
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new ApsError('ConfigurationError', `Cannot read ${r.path}: ${(e as Error).message}`);
  }
}

/** The API definitions kept in the workspace, as paths from its root (`specs/clinic.yaml`; with `includeAsync`, `specs/asyncapi/*` too). */
export function listSpecs(store: Pick<WorkspaceStore, 'path'>, opts: { includeAsync?: boolean } = {}): string[] {
  const list = (rel: string) => {
    const dir = store.path(...rel.split('/'));
    return existsSync(dir) ? readdirSync(dir).filter((f) => SPEC_FILE.test(f)).map((f) => `${rel}/${f}`) : [];
  };
  return [...list('specs'), ...(opts.includeAsync ? list('specs/asyncapi') : [])];
}

/**
 * The JSON Schema a request body should follow, from the operation `method url` maps to in one of the workspace's
 * OpenAPI documents (specs/), with the document it came from; null when none describes it.
 */
export function findBodySchema(store: Pick<WorkspaceStore, 'path' | 'safePath'>, method: string, url: string): (ReturnType<typeof requestBodySchema> & { spec: string }) | null {
  if (!url) return null;
  for (const spec of listSpecs(store).sort()) {
    try {
      const r = requestBodySchema(loadOpenApi(readFileSync(store.safePath(spec), 'utf8')), method, url);
      if (r) return { ...r, spec };
    } catch {
      /* not an OpenAPI document, or unreadable: the next one */
    }
  }
  return null;
}
