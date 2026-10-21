/**
 * The adapters of the kinds the workspace keeps as files in its folders: test and flow files (tests/), API definitions
 * (specs/), datasets (datasets/), proto files (protos/), MCP mocks (mocks/) and script packages (packages/). The id of
 * each is its path from the workspace root with `/`; every path, on the way out and the way in, goes through
 * `bundleFilePath` (the same rules as the workspace export: no `..`, no absolute path, no device names, one root folder).
 */
import { isUtf8 } from 'node:buffer';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from '../storage/fsutil.js';
import { bundleFilePath } from '../storage/workspace-bundle.js';
import { SCRIPT_PACKAGE_NAME, type WorkspaceStore } from '../storage/workspace.js';
import { RAW_ROOT, type BundleKindId } from './format.js';
import { listIndex, numberedPath, replacePaths, seedOnce, type ItemAdapter, type Listed, type Snapshot } from './items.js';

const ACCEPT: Partial<Record<BundleKindId, RegExp>> = {
  test: /\.(ya?ml|json)$/i,
  'mcp-mock': /\.mcp-mock\.ya?ml$/i,
  'script-package': /\.js$/,
};

/** Every plain file under a workspace folder that the kind accepts (no dot files, no links, the same listing on every OS). */
function walk(store: WorkspaceStore, kind: BundleKindId): Listed[] {
  const root = RAW_ROOT[kind]!;
  const accept = ACCEPT[kind];
  const out: Listed[] = [];
  const visit = (rel: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(store.path(...rel.split('/')), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const r = `${rel}/${e.name}`;
      const abs = store.path(...r.split('/'));
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(r);
      else if (st.isFile() && (!accept || accept.test(e.name))) out.push({ id: r, name: r, size: st.size });
    }
  };
  if (existsSync(store.path(root))) visit(root);
  return out;
}

/** Text: no NUL and valid UTF-8 (the check is made on the bytes, not by decoding and encoding a copy). */
const isText = (b: Buffer): boolean => !b.includes(0) && isUtf8(b);

/** The `server:` of a test file, renamed where the server it names got a new name or id on the way in. */
function renameServers(text: string, remap: Map<string, string>): string {
  let out = text;
  for (const [from, to] of remap) {
    if (from === to) continue;
    const q = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const esc = (s: string) => s.replace(/\$/g, '$$$$');
    out = out
      .replace(new RegExp(`(server:\\s*\\{[^}\\n]*?name:\\s*)(["']?)${q}\\2`, 'g'), (_m, a: string, quote: string) => `${a}${quote}${to}${quote}`)
      .replace(new RegExp(`(server:\\s*\\r?\\n\\s+name:\\s*)(["']?)${q}\\2`, 'g'), (_m, a: string, quote: string) => `${a}${quote}${to}${quote}`)
      .replace(new RegExp(`(server:\\s*)(["']?)${q}\\2(\\s*(?:\\r?\\n|$))`, 'g'), (_m, a: string, quote: string, end: string) => `${a}${quote}${esc(to)}${quote}${end}`);
  }
  return out;
}

function fileAdapter(kind: BundleKindId, label: string): ItemAdapter {
  const root = RAW_ROOT[kind]!;
  const accept = ACCEPT[kind];
  return {
    kind,
    label,
    list: (store) => walk(store, kind),
    snapshot(store, id, strip) {
      const ok = bundleFilePath(id, [root]);
      if ('why' in ok) return undefined;
      let abs: string;
      try {
        abs = store.safePath(ok.path);
        const st = lstatSync(abs);
        if (!st.isFile() || st.isSymbolicLink()) return undefined;
      } catch {
        return undefined;
      }
      const bytes = readFileSync(abs);
      const snap: Snapshot = { id: ok.path, name: ok.path, data: bytes, summary: { bytes: bytes.length } };
      if (!isText(bytes)) return { ...snap, unscanned: true };
      const text = bytes.toString('utf8');
      // a dataset is read field by field (a password column, a token property); the rest is text with shapes in it
      const stripped = kind === 'dataset' ? strip.datasetFile(ok.path, text) : { text: strip.text(kind === 'test' ? 'test' : 'file', ok.path, 'content', text), parsed: true };
      return { ...snap, data: stripped.text === text ? bytes : Buffer.from(stripped.text, 'utf8'), ...(stripped.parsed ? {} : { unscanned: true }) };
    },
    check(item, data) {
      const ok = bundleFilePath(item.id, [root]);
      if ('why' in ok) return `the path ${JSON.stringify(item.id.slice(0, 120))} is refused: ${ok.why}`;
      if (ok.path !== item.id) return 'its path is not in the normal form';
      const name = item.id.slice(item.id.lastIndexOf('/') + 1);
      if (accept && !accept.test(name)) return `a ${label.toLowerCase()} file is ${kind === 'test' ? '.yaml, .yml or .json' : kind === 'mcp-mock' ? '.mcp-mock.yaml' : '.js'}`;
      if (kind === 'script-package') {
        const pkg = item.id.slice('packages/'.length, -'.js'.length);
        if (!SCRIPT_PACKAGE_NAME.test(pkg)) return `"${pkg.slice(0, 60)}" is not a package name`;
      }
      void data;
      return undefined;
    },
    review(item, data) {
      if (kind === 'script-package') return [`Script package "${item.id.slice('packages/'.length, -3)}" is code: scripts that require it run it (nothing runs on import)`];
      if (kind === 'test' && /^\s*(?:-\s*)?(?:type:\s*script|script:)/m.test(data.toString('utf8', 0, Math.min(data.length, 2_000_000))))
        return [`Test file ${item.id} contains scripts that run when you run it (nothing runs on import)`];
      return [];
    },
    match: (existing, x) => listIndex(existing).byLowerId.get(x.id.toLowerCase()),
    fresh(existing, x, taken) {
      seedOnce(taken.ids, () => existing.forEach((e) => taken.ids.add(e.id.toLowerCase())));
      let id = x.id;
      for (let n = 2; taken.ids.has(id.toLowerCase()); n++) id = numberedPath(x.id, n);
      taken.ids.add(id.toLowerCase());
      return { id, name: id };
    },
    rewrite(_item, data, remap) {
      if (kind !== 'test' || !isText(data)) return data;
      const text = data.toString('utf8');
      let out = replacePaths(text, remap.path);
      out = renameServers(renameServers(out, remap.serverName), remap.serverId);
      return out === text ? data : Buffer.from(out, 'utf8');
    },
    commit(store, writes, journal) {
      for (const w of writes) {
        const ok = bundleFilePath(w.target.id, [root]);
        if ('why' in ok) throw new Error(`${w.target.id}: ${ok.why}`);
        // the real location too: a link inside the workspace cannot carry the write outside it
        const abs = store.safePath(ok.path);
        journal.before(ok.path);
        mkdirSync(dirname(abs), { recursive: true });
        atomicWrite(abs, w.data);
        journal.after(ok.path);
      }
    },
  };
}

export const FILE_ADAPTERS: ItemAdapter[] = [
  fileAdapter('test', 'Test file'),
  fileAdapter('spec', 'API definition'),
  fileAdapter('dataset', 'Dataset'),
  fileAdapter('proto', 'Proto file'),
  fileAdapter('mcp-mock', 'MCP mock'),
  fileAdapter('script-package', 'Script package'),
];
