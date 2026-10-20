import { ApsError } from '../errors.js';
import { assertUrlAllowed } from '../net/policy.js';
import { IMPORT_FILE_EXTENSIONS } from '@testpion/shared';
import type { RawImportFile } from './inputs.js';

/**
 * Import from a repository link (import-compat plan 4d): a GitHub or GitLab link to a folder or a repository whose files
 * are a collection (a Bruno or OpenCollection folder, a Postman Git collection, a folder of Yaak files, an Insomnia
 * export, an OpenAPI folder). What it does, and what it never does:
 *
 * - **public repositories only**: no token, no cookie, no credential is sent, stored or asked for; a private repository
 *   answers 404 and the message says to download it and import the folder;
 * - **only https, only the hosts of the two services**: github.com (API: api.github.com, files: raw.githubusercontent.com)
 *   and gitlab.com. A redirect is followed only to one of those hosts (at most three), never anywhere else;
 * - **size limits**: at most 500 files that look like import files, 5 MB each, 25 MB together, and a repository listing of
 *   at most 20,000 entries; over a limit the import stops with the number and says to import a narrower folder;
 * - **nothing is executed**: the files are read as text, symbolic links and submodules are skipped, and a path with `..`,
 *   a NUL byte or a drive letter is refused. The files then go through the same importers as files from disk.
 */

export const REPO_LIMITS = { maxFiles: 500, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024, maxListing: 20_000 };

export interface RepoRef {
  host: 'github' | 'gitlab';
  /** `owner/repo` (GitLab: the full project path, groups included). */
  project: string;
  /** Branch, tag or commit; empty = the repository's default branch. */
  ref: string;
  /** Folder inside the repository ('' = the root). */
  path: string;
  /** The link as given, without a trailing slash. */
  link: string;
}

const SAFE_SEGMENT = /^[\w.-]+$/;

/**
 * A GitHub / GitLab link to a repository or a folder of one (`github.com/o/r`, `…/tree/<ref>/<path>`), or undefined when
 * the link is anything else (a file page is a single file: fetch-url.ts turns it into its raw link).
 */
export function parseRepoLink(input: string): RepoRef | undefined {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    if (segs.length < 2 || !segs.slice(0, 2).every((s) => SAFE_SEGMENT.test(s))) return undefined;
    const project = `${segs[0]}/${segs[1]!.replace(/\.git$/, '')}`;
    if (segs.length === 2) return { host: 'github', project, ref: '', path: '', link: input.trim().replace(/\/$/, '') };
    if (segs[2] !== 'tree') return undefined;
    return { host: 'github', project, ref: segs[3] ?? '', path: segs.slice(4).join('/'), link: input.trim().replace(/\/$/, '') };
  }
  if (u.hostname === 'gitlab.com' || u.hostname === 'www.gitlab.com') {
    const dash = segs.indexOf('-');
    const head = dash === -1 ? segs : segs.slice(0, dash);
    if (head.length < 2 || !head.every((s) => SAFE_SEGMENT.test(s))) return undefined;
    const project = head.join('/').replace(/\.git$/, '');
    if (dash === -1) return { host: 'gitlab', project, ref: '', path: '', link: input.trim().replace(/\/$/, '') };
    if (segs[dash + 1] !== 'tree') return undefined;
    return { host: 'gitlab', project, ref: segs[dash + 2] ?? '', path: segs.slice(dash + 3).join('/'), link: input.trim().replace(/\/$/, '') };
  }
  return undefined;
}

type Fetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

const HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const bad = (why: string, hint = 'Import a narrower folder, or download the repository and import the folder from disk.') => new ApsError('ValidationError', why, { suggestions: [hint] });

/** The EXT filter: only files an importer can read. */
const WANTED = new Set([...IMPORT_FILE_EXTENSIONS.map((e) => e.toLowerCase()), 'env', 'proto', 'js']);
const wanted = (path: string): boolean => {
  const name = path.split('/').pop()!;
  if (name === '.env') return true;
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return !!ext && WANTED.has(ext);
};

function checkPath(p: string): void {
  if (!p || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.split('/').some((s) => s === '..' || s === '')) throw bad(`The repository lists a path that cannot be imported: "${p.slice(0, 80)}"`);
}

/** A GET to one of the allowed hosts, with the caps, following redirects only within them. */
async function get(url: string, f: Fetch, accept: string, signal: AbortSignal | undefined, maxBytes: number): Promise<{ status: number; body: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.username || u.password) throw bad(`The link leaves GitHub and GitLab (${u.hostname}): a repository import only talks to those two`);
    await assertUrlAllowed(current);
    let res;
    try {
      res = await f(current, { headers: { accept, 'user-agent': 'TestPion-import' }, redirect: 'manual', signal: signal ?? AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new ApsError('NetworkError', `Couldn't reach ${u.hostname}: ${(e as Error).message}`, { suggestions: ['Check the internet connection and the proxy in Settings ▸ Proxy.'] });
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw bad(`${u.hostname} answered a redirect with no address`);
      current = new URL(loc, current).toString();
      continue;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw bad(`A file in the repository is larger than ${Math.round(maxBytes / 1048576)} MB`);
    if (!res.ok && res.status !== 404 && res.status !== 403) throw new ApsError('NetworkError', `${u.hostname} answered HTTP ${res.status}`, { suggestions: [] });
    const buf = res.status === 404 || res.status === 403 ? '' : Buffer.from(await res.arrayBuffer());
    if (typeof buf !== 'string' && buf.length > maxBytes) throw bad(`A file in the repository is larger than ${Math.round(maxBytes / 1048576)} MB`);
    return { status: res.status, body: typeof buf === 'string' ? '' : buf.toString('utf8') };
  }
  throw bad('Too many redirects');
}

const json = (r: { body: string }): Any => {
  try {
    return JSON.parse(r.body);
  } catch {
    throw bad('The service answered something that is not JSON');
  }
};
type Any = Record<string, any>;

export interface RepoFetch {
  files: RawImportFile[];
  /** The folder's name, for the collection (the last segment of the path, else the repository). */
  folderName: string;
  /** What was resolved: the repository, the ref and the folder. */
  resolved: { project: string; ref: string; path: string };
  /** Files left out and why (too many, too large, not an import file). */
  skipped: Array<{ path: string; why: string }>;
}

const notFound = (r: RepoRef) =>
  new ApsError('ValidationError', `Couldn't find ${r.project}${r.path ? ` / ${r.path}` : ''} on ${r.host === 'github' ? 'GitHub' : 'GitLab'}`, {
    suggestions: ['Only public repositories can be imported by link (TestPion sends no credentials). For a private one, clone it and import the folder.'],
  });

/** The files of a repository folder, read from the service without a token. */
export async function fetchRepoFiles(r: RepoRef, opts: { fetchImpl?: Fetch; signal?: AbortSignal } = {}): Promise<RepoFetch> {
  const f: Fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init) as never);
  const skipped: RepoFetch['skipped'] = [];
  const path = r.path.replace(/\/$/, '');
  let entries: Array<{ path: string; size: number }>;
  let ref = r.ref;
  let prefix = path;
  let rawUrl: (p: string) => string;

  if (r.host === 'github') {
    if (!ref) {
      const info = await get(`https://api.github.com/repos/${r.project}`, f, 'application/vnd.github+json', opts.signal, 1_000_000);
      if (info.status !== 200) throw notFound(r);
      ref = String(json(info).default_branch ?? 'main');
    }
    // a branch name can hold slashes (tree/feature/x/dir): try the first segment, then more of the path as the ref
    let tree: Any | undefined;
    const parts = path ? path.split('/') : [];
    for (let k = 0; k <= Math.min(parts.length, 3) && !tree; k++) {
      const tryRef = k === 0 ? ref : [ref, ...parts.slice(0, k)].join('/');
      const t = await get(`https://api.github.com/repos/${r.project}/git/trees/${encodeURIComponent(tryRef)}?recursive=1`, f, 'application/vnd.github+json', opts.signal, 40 * 1024 * 1024);
      if (t.status === 200) {
        tree = json(t);
        ref = tryRef;
        prefix = parts.slice(k).join('/');
      } else if (t.status === 403) throw bad('GitHub refused the request (its limit for unauthenticated use was probably reached); try again in an hour or clone the repository', 'Clone the repository and import the folder.');
    }
    if (!tree) throw notFound(r);
    if (tree.truncated) throw bad('The repository is too large to list through GitHub\'s API', 'Link to a folder of the repository (…/tree/main/<folder>) or clone it.');
    const list = Array.isArray(tree.tree) ? (tree.tree as Any[]) : [];
    if (list.length > REPO_LIMITS.maxListing) throw bad(`The repository lists ${list.length} entries (at most ${REPO_LIMITS.maxListing})`);
    entries = list.filter((e) => e.type === 'blob' && e.mode !== '120000').map((e) => ({ path: String(e.path), size: Number(e.size ?? 0) }));
    rawUrl = (p) => `https://raw.githubusercontent.com/${r.project}/${ref.split('/').map(encodeURIComponent).join('/')}/${p.split('/').map(encodeURIComponent).join('/')}`;
  } else {
    const id = encodeURIComponent(r.project);
    if (!ref) {
      const info = await get(`https://gitlab.com/api/v4/projects/${id}`, f, 'application/json', opts.signal, 1_000_000);
      if (info.status !== 200) throw notFound(r);
      ref = String(json(info).default_branch ?? 'main');
    }
    entries = [];
    for (let page = 1; page <= 25; page++) {
      const t = await get(`https://gitlab.com/api/v4/projects/${id}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}${prefix ? `&path=${encodeURIComponent(prefix)}` : ''}`, f, 'application/json', opts.signal, 5 * 1024 * 1024);
      if (t.status !== 200) throw notFound(r);
      const list = json(t) as Any[];
      for (const e of list) if (e.type === 'blob' && e.mode !== '120000') entries.push({ path: String(e.path), size: 0 });
      if (list.length < 100) break;
      if (entries.length > REPO_LIMITS.maxListing) throw bad(`The repository lists more than ${REPO_LIMITS.maxListing} files`);
    }
    rawUrl = (p) => `https://gitlab.com/api/v4/projects/${id}/repository/files/${encodeURIComponent(p)}/raw?ref=${encodeURIComponent(ref)}`;
  }

  // the files under the folder that an importer can read
  const under = entries.filter((e) => (prefix ? e.path === prefix || e.path.startsWith(`${prefix}/`) : true));
  for (const e of under) checkPath(e.path);
  const picked: Array<{ path: string; size: number }> = [];
  for (const e of under) {
    if (!wanted(e.path)) continue;
    if (e.size > REPO_LIMITS.maxFileBytes) {
      skipped.push({ path: e.path, why: `larger than ${Math.round(REPO_LIMITS.maxFileBytes / 1048576)} MB` });
      continue;
    }
    picked.push(e);
  }
  if (!picked.length) throw bad(`No importable file under ${r.project}${prefix ? ` / ${prefix}` : ''} (it holds ${under.length} other file${under.length === 1 ? '' : 's'})`, 'Link to the folder that holds the collection files.');
  if (picked.length > REPO_LIMITS.maxFiles) throw bad(`${picked.length} files look like import files (at most ${REPO_LIMITS.maxFiles})`);
  const total = picked.reduce((n, e) => n + e.size, 0);
  if (total > REPO_LIMITS.maxTotalBytes) throw bad(`The files add up to ${Math.round(total / 1048576)} MB (at most ${Math.round(REPO_LIMITS.maxTotalBytes / 1048576)} MB)`);

  const files: RawImportFile[] = [];
  let bytes = 0;
  const queue = [...picked];
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const res = await get(rawUrl(e.path), f, 'text/plain, */*;q=0.5', opts.signal, REPO_LIMITS.maxFileBytes);
      if (res.status !== 200) {
        skipped.push({ path: e.path, why: `could not be read (HTTP ${res.status})` });
        continue;
      }
      bytes += Buffer.byteLength(res.body);
      if (bytes > REPO_LIMITS.maxTotalBytes) throw bad(`The files add up to more than ${Math.round(REPO_LIMITS.maxTotalBytes / 1048576)} MB`);
      files.push({ path: prefix ? e.path.slice(prefix.length + 1) || e.path : e.path, data: res.body });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  files.sort((a, b) => a.path.localeCompare(b.path));
  const folderName = (prefix.split('/').pop() || r.project.split('/').pop()) ?? 'repository';
  return { files, folderName, resolved: { project: r.project, ref, path: prefix }, skipped };
}
