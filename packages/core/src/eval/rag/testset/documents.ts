/**
 * Loading the documents a test set is made from (planning/rag-testing.md §4b): markdown, text and HTML files of the
 * workspace (a file or a folder), and public https pages. Only text is read: a PDF has no extractor in TestPion, so it is
 * refused with what to do (extract the text first). Nothing in a document is executed. Folder walks are capped.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ApsError } from '../../../errors.js';
import type { WorkspaceStore } from '../../../storage/workspace.js';
import { chunkCorpus } from './chunk.js';
import { fetchDocument, MAX_DOC_BYTES, MAX_URLS, type GuardDeps } from './url-guard.js';
import type { Corpus, SourceDoc } from './types.js';

export const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const TEXT = /\.(md|markdown|txt|text)$/i;
const HTML = /\.(html?|xhtml)$/i;

/** The readable text of an HTML page: scripts, styles, navigation and forms dropped, block elements on their own lines, headings as markdown. */
export async function htmlToText(html: string): Promise<string> {
  const { parse } = await import('node-html-parser');
  const root = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  for (const el of root.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,svg,iframe')) el.remove();
  const out: string[] = [];
  const walk = (n: { childNodes: unknown[] }): void => {
    for (const c of n.childNodes as Array<{ nodeType: number; rawTagName?: string; text?: string; childNodes: unknown[] }>) {
      if (c.nodeType === 3) {
        const t = (c.text ?? '').replace(/\s+/g, ' ');
        if (t.trim()) out.push(t);
        continue;
      }
      const tag = (c.rawTagName ?? '').toLowerCase();
      const h = /^h([1-6])$/.exec(tag);
      const block = /^(p|div|section|article|main|li|ul|ol|table|tr|pre|blockquote|br|dl|dt|dd)$/.test(tag);
      if (h) out.push(`\n\n${'#'.repeat(Number(h[1]))} `);
      else if (block) out.push('\n\n');
      walk(c);
      if (h || block) out.push('\n\n');
    }
  };
  walk(root);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const looksLikeMarkdown = (name: string, text: string) => /\.(md|markdown)$/i.test(name) || /^#{1,6}\s/m.test(text);

async function fileDoc(abs: string, name: string, skipped: string[]): Promise<SourceDoc | undefined> {
  if (/\.pdf$/i.test(name)) {
    skipped.push(`${name}: a PDF cannot be read here; extract its text first (for example pdftotext) and use the .txt file`);
    return undefined;
  }
  const isHtml = HTML.test(name);
  if (!isHtml && !TEXT.test(name)) {
    skipped.push(`${name}: not a text, markdown or HTML file`);
    return undefined;
  }
  const raw = readFileSync(abs, 'utf8');
  if (raw.includes('\u0000')) {
    skipped.push(`${name}: it is not text`);
    return undefined;
  }
  const text = isHtml ? await htmlToText(raw) : raw;
  if (!text.trim()) {
    skipped.push(`${name}: it is empty`);
    return undefined;
  }
  return { name, kind: 'file', text, format: isHtml || looksLikeMarkdown(name, text) ? 'markdown' : 'text' };
}

export interface LoadOptions {
  paths?: string[];
  urls?: string[];
  /** The CLI may name files outside the workspace; the app, RPC and MCP may not. */
  allowAbsolute?: boolean;
  guard?: GuardDeps;
}

/** The documents named by paths (files or folders) and URLs, in the order given (a folder in name order), with why any was left out. */
export async function loadDocuments(store: WorkspaceStore, o: LoadOptions): Promise<{ docs: SourceDoc[]; skipped: string[] }> {
  const skipped: string[] = [];
  const docs: SourceDoc[] = [];
  let files = 0;
  let bytes = 0;
  const add = async (abs: string, name: string) => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return void skipped.push(`${name}: a link is not followed`);
    if (st.size > MAX_DOC_BYTES) return void skipped.push(`${name}: larger than ${MAX_DOC_BYTES / 1024 / 1024} MB`);
    if (++files > MAX_FILES) throw new ApsError('ValidationError', `More than ${MAX_FILES} files: name a smaller folder`);
    bytes += st.size;
    if (bytes > MAX_TOTAL_BYTES) throw new ApsError('ValidationError', `More than ${MAX_TOTAL_BYTES / 1024 / 1024} MB of documents: name a smaller folder`);
    const d = await fileDoc(abs, name, skipped);
    if (d) docs.push(d);
  };
  const walk = async (abs: string, name: string): Promise<void> => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = join(abs, e.name);
      const childName = `${name}/${e.name}`;
      if (e.isDirectory()) await walk(child, childName);
      else if (e.isFile()) {
        if (TEXT.test(e.name) || HTML.test(e.name)) await add(child, childName);
      }
    }
  };
  for (const p of o.paths ?? []) {
    const given = p.trim();
    if (!given) continue;
    let abs: string;
    if (isAbsolute(given)) {
      if (!o.allowAbsolute) throw new ApsError('ValidationError', `"${given}" is outside the workspace: name a file or folder of the workspace`);
      abs = resolve(given);
    } else abs = store.safePath(given);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw new ApsError('ConfigurationError', `No file or folder "${given}"`, { suggestions: ['Names are relative to the workspace folder (docs/handbook.md).'] });
    }
    const name = isAbsolute(given) ? given.split(sep).join('/') : relative(store.root, abs).split(sep).join('/');
    if (st.isDirectory()) await walk(abs, name);
    else await add(abs, name);
  }
  const urls = (o.urls ?? []).map((u) => u.trim()).filter(Boolean);
  if (urls.length > MAX_URLS) throw new ApsError('ValidationError', `At most ${MAX_URLS} URLs at a time (${urls.length} given)`);
  for (const u of urls) {
    try {
      const f = await fetchDocument(u, o.guard);
      const text = f.html ? await htmlToText(f.text) : f.text;
      if (text.trim()) docs.push({ name: f.url, kind: 'url', text, format: f.html || looksLikeMarkdown(f.url, text) ? 'markdown' : 'text' });
      else skipped.push(`${u}: it has no text`);
    } catch (e) {
      // one bad URL does not stop the others; the reason is shown
      skipped.push(`${u}: ${(e as Error).message.replace(/^The document URL \S+ is refused: /, 'refused: ')}`);
    }
  }
  return { docs, skipped };
}

export async function loadCorpus(store: WorkspaceStore, o: LoadOptions & { chunkTokens?: number }): Promise<Corpus> {
  const { docs, skipped } = await loadDocuments(store, o);
  if (!docs.length) throw new ApsError('ConfigurationError', 'No document could be read', { why: skipped.join('; ') || 'Nothing was named.', suggestions: ['Name markdown, text or HTML files (or a folder of them), or public https pages.'] });
  const c = chunkCorpus(docs, { tokens: o.chunkTokens });
  return { ...c, skipped };
}
