import { describe, it, expect } from 'vitest';
import { expandImportFiles, fetchRepoFiles, importDocument, parseRepoLink, REPO_LIMITS } from '../../packages/core/src/index.js';

// Import from a GitHub / GitLab link: public repositories only, https and those hosts only, size limits, nothing executed.

const bru = `meta {\n  name: Ping\n  type: http\n  seq: 1\n}\n\nget {\n  url: {{host}}/ping\n  body: none\n  auth: none\n}\n`;

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A fake of the services: GitHub's tree API and raw files. */
function github(entries: Array<{ path: string; type?: string; mode?: string; size?: number; body?: string }>, opts: { truncated?: boolean; redirectRawTo?: string; status?: number } = {}) {
  const calls: Call[] = [];
  const f = async (url: string, init: { headers: Record<string, string>; redirect: 'manual' }) => {
    calls.push({ url, headers: init.headers });
    expect(init.redirect).toBe('manual');
    const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, ok: status < 400, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => String(body), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
    const u = new URL(url);
    if (opts.status && u.hostname === 'api.github.com') return res(opts.status, '{}');
    if (u.hostname === 'api.github.com' && /\/repos\/o\/r$/.test(u.pathname)) return res(200, { default_branch: 'main' });
    if (u.hostname === 'api.github.com' && /\/git\/trees\//.test(u.pathname)) return res(200, { truncated: !!opts.truncated, tree: entries.map((e) => ({ path: e.path, type: e.type ?? 'blob', mode: e.mode ?? '100644', size: e.size ?? (e.body ?? '').length })) });
    if (u.hostname === 'raw.githubusercontent.com') {
      if (opts.redirectRawTo) return res(302, '', { location: opts.redirectRawTo });
      const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
      const e = entries.find((x) => x.path === p);
      return e ? res(200, e.body ?? '') : res(404, '');
    }
    return res(404, '');
  };
  return { f: f as never, calls };
}

describe('parseRepoLink', () => {
  it('reads GitHub and GitLab repository and folder links, and nothing else', () => {
    expect(parseRepoLink('https://github.com/o/r')).toMatchObject({ host: 'github', project: 'o/r', ref: '', path: '' });
    expect(parseRepoLink('https://github.com/o/r/tree/main/api/clinic')).toMatchObject({ host: 'github', project: 'o/r', ref: 'main', path: 'api/clinic' });
    expect(parseRepoLink('https://gitlab.com/group/sub/proj')).toMatchObject({ host: 'gitlab', project: 'group/sub/proj', ref: '', path: '' });
    expect(parseRepoLink('https://gitlab.com/group/proj/-/tree/dev/collections/x')).toMatchObject({ host: 'gitlab', project: 'group/proj', ref: 'dev', path: 'collections/x' });
    // a file page, other hosts, other schemes, credentials in the link
    expect(parseRepoLink('https://github.com/o/r/blob/main/c.json')).toBeUndefined();
    expect(parseRepoLink('https://example.com/o/r')).toBeUndefined();
    expect(parseRepoLink('http://github.com/o/r')).toBeUndefined();
    expect(parseRepoLink('https://user:pw@github.com/o/r')).toBeUndefined();
    expect(parseRepoLink('https://github.com/o/r%2F..%2Fx/tree/main')).toBeUndefined();
  });
});

describe('fetchRepoFiles', () => {
  it('reads the default branch, the folder, and imports as a Bruno collection', async () => {
    const { f, calls } = github([
      { path: 'README.md', body: '# hi' },
      { path: 'api/bruno.json', body: '{"version":"1","name":"Clinic","type":"collection"}' },
      { path: 'api/Ping.bru', body: bru },
      { path: 'api/logo.png', body: 'x' },
      { path: 'other/x.json', body: '{}' },
      { path: 'api/link', mode: '120000', body: 'target' },
    ]);
    const r = await fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main/api')!, { fetchImpl: f });
    expect(r.resolved).toEqual({ project: 'o/r', ref: 'main', path: 'api' });
    expect(r.files.map((x) => x.path)).toEqual(['bruno.json', 'Ping.bru']);
    const { inputs } = expandImportFiles(r.files, { folderName: r.folderName });
    expect(inputs).toHaveLength(1);
    expect(importDocument(inputs[0]!.text).document.collections[0]!.name).toBe('Clinic');
    // no credential of any kind went out, and only the two services were asked
    for (const c of calls) {
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain('cookie');
      expect(['api.github.com', 'raw.githubusercontent.com']).toContain(new URL(c.url).hostname);
    }
  });
  it('without a ref it asks for the default branch', async () => {
    const { f, calls } = github([{ path: 'c.postman_collection.json', body: '{}' }]);
    await fetchRepoFiles(parseRepoLink('https://github.com/o/r')!, { fetchImpl: f });
    expect(calls[0]!.url).toBe('https://api.github.com/repos/o/r');
  });
  it('a private or missing repository says so and how to import it', async () => {
    const { f } = github([], { status: 404 });
    await expect(fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main/x')!, { fetchImpl: f })).rejects.toMatchObject({ message: expect.stringMatching(/Couldn.t find o\/r \/ x on GitHub/), suggestions: [expect.stringMatching(/public repositories/)] });
  });
  it('refuses a redirect that leaves the two services', async () => {
    const { f } = github([{ path: 'a.json', body: '{}' }], { redirectRawTo: 'https://evil.example/steal' });
    await expect(fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main')!, { fetchImpl: f })).rejects.toThrow(/leaves GitHub and GitLab/);
  });
  it('refuses paths that leave the folder', async () => {
    for (const p of ['../x.json', 'a/../../x.json', '/etc/passwd', 'C:/x.json', 'a//b.json']) {
      const { f } = github([{ path: p, body: '{}' }]);
      await expect(fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main')!, { fetchImpl: f }), p).rejects.toThrow(/cannot be imported/);
    }
  });
  it('size limits: too many files, a file too large, too much together, a listing GitHub truncated', async () => {
    const many = Array.from({ length: REPO_LIMITS.maxFiles + 1 }, (_, i) => ({ path: `c/${i}.json`, body: '{}' }));
    await expect(fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main/c')!, { fetchImpl: github(many).f })).rejects.toThrow(/at most 500/);
    const big = github([{ path: 'a.json', size: REPO_LIMITS.maxFileBytes + 1, body: '{}' }, { path: 'b.json', body: '{}' }]);
    const r = await fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main')!, { fetchImpl: big.f });
    expect(r.skipped).toEqual([{ path: 'a.json', why: 'larger than 5 MB' }]);
    const total = Array.from({ length: 6 }, (_, i) => ({ path: `t/${i}.json`, size: 5 * 1024 * 1024 }));
    await expect(fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main/t')!, { fetchImpl: github(total).f })).rejects.toThrow(/add up to/);
    await expect(fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main')!, { fetchImpl: github([{ path: 'a.json' }], { truncated: true }).f })).rejects.toThrow(/too large to list/);
  });
  it('nothing importable under the folder is an error that names the folder', async () => {
    const { f } = github([{ path: 'docs/readme.md' }, { path: 'docs/pic.png' }]);
    await expect(fetchRepoFiles(parseRepoLink('https://github.com/o/r/tree/main/docs')!, { fetchImpl: f })).rejects.toThrow(/No importable file under o\/r \/ docs/);
  });
  it('GitLab: the project tree and raw files, paged, with the same rules', async () => {
    const calls: string[] = [];
    const f = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push(url);
      expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('private-token');
      const res = (status: number, body: unknown) => ({ status, ok: status < 400, headers: { get: () => null }, text: async () => String(body), arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) });
      const u = new URL(url);
      expect(u.hostname).toBe('gitlab.com');
      if (/\/projects\/g%2Fp$/.test(u.pathname)) return res(200, { default_branch: 'trunk' });
      if (/\/repository\/tree$/.test(u.pathname)) return res(200, [{ type: 'blob', path: 'col/Ping.bru', mode: '100644' }, { type: 'blob', path: 'col/bruno.json', mode: '100644' }, { type: 'tree', path: 'col/sub' }]);
      if (/\/repository\/files\//.test(u.pathname)) return res(200, decodeURIComponent(u.pathname).endsWith('Ping.bru/raw') ? bru : '{"version":"1","name":"G","type":"collection"}');
      return res(404, '');
    };
    const r = await fetchRepoFiles(parseRepoLink('https://gitlab.com/g/p/-/tree/trunk/col')!, { fetchImpl: f as never });
    expect(r.files.map((x) => x.path)).toEqual(['bruno.json', 'Ping.bru']);
    expect(calls.some((c) => c.includes('ref=trunk') && c.includes('path=col'))).toBe(true);
  });
});
