/**
 * Test-set generation, the deterministic parts: chunking (stable ids, headings), the document guard (https only, public
 * addresses, same-host redirects, size cap), selection of what the model is asked about, the three verifiers, and applying
 * a proposal's rows to a dataset file with undo. No model and no network.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDatasetRowItem,
  bm25Rank,
  checkDocumentUrl,
  chunkCorpus,
  chunkDocument,
  copiedShare,
  fetchDocument,
  htmlToText,
  loadDocuments,
  planBatch,
  rememberCorpus,
  corpusToken,
  termJaccard,
  undoDatasetRows,
  verifyAnswerable,
  verifyDuplicate,
  verifySupport,
  WorkspaceStore,
  type ProposalItem,
  type TestsetChunk,
  type TestsetRecord,
} from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const MD = [
  '# Clinic handbook',
  '',
  'Welcome to Happy Paws. We treat dogs and cats.',
  '',
  '## Opening hours',
  '',
  'The clinic opens at 8am on weekdays and closes at 6pm. On Saturdays it opens at 9am and closes at noon.',
  '',
  'Sunday is closed except for emergencies.',
  '',
  '## Vaccines',
  '',
  'Puppies receive their first vaccine at 8 weeks. The booster follows at 12 weeks and costs 45 dollars.',
].join('\n');

const doc = (name: string, text: string) => ({ name, kind: 'file' as const, text, format: 'markdown' as const });

describe('chunking', () => {
  it('splits at headings, keeps the heading path and gives stable ids', () => {
    const a = chunkDocument(doc('docs/handbook.md', MD), 'handbook', { tokens: 60 });
    expect(a.map((c) => c.id)).toEqual(a.map((_, i) => `handbook#${i + 1}`));
    expect(a.find((c) => c.text.includes('opens at 8am'))!.heading).toEqual(['Clinic handbook', 'Opening hours']);
    expect(a.find((c) => c.text.includes('Puppies'))!.heading).toEqual(['Clinic handbook', 'Vaccines']);
    // deterministic: the same input twice is identical, hashes included
    expect(chunkDocument(doc('docs/handbook.md', MD), 'handbook', { tokens: 60 })).toEqual(a);
  });

  it('a long paragraph is cut at sentence ends within the budget', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} says something about the clinic.`).join(' ');
    const c = chunkDocument(doc('long.txt', long), 'long', { tokens: 50 });
    expect(c.length).toBeGreaterThan(3);
    for (const x of c) expect(x.tokens).toBeLessThanOrEqual(60);
    expect(c.map((x) => x.text).join(' ')).toContain('Sentence number 29');
  });

  it('a document keeps its ids when other documents change (slugs are per document, duplicates numbered)', () => {
    const one = chunkCorpus([doc('a/readme.md', MD), doc('b/readme.md', 'Other text.\n\nMore text here.')]);
    const two = chunkCorpus([doc('a/readme.md', MD), doc('b/readme.md', 'Changed.')]);
    expect(one.docs.map((d) => d.slug)).toEqual(['a-readme', 'b-readme']);
    expect(one.chunks.filter((c) => c.id.startsWith('a-readme')).map((c) => [c.id, c.hash])).toEqual(two.chunks.filter((c) => c.id.startsWith('a-readme')).map((c) => [c.id, c.hash]));
    const dup = chunkCorpus([doc('x/readme.md', 'One.'), doc('y/readme.md', 'Two.')]);
    expect(dup.docs.map((d) => d.slug)).toEqual(['x-readme', 'y-readme']);
    expect(chunkCorpus([doc('readme.md', 'One.'), doc('readme.md', 'Two.')]).docs.map((d) => d.slug)).toEqual(['readme', 'readme-2']);
  });

  it('a heading inside a code fence is not a heading', () => {
    const c = chunkDocument(doc('c.md', '# Real\n\n```\n# not a heading\n```\n\nAfter.'), 'c');
    expect(c.every((x) => x.heading.join('/') === 'Real')).toBe(true);
  });
});

describe('documents', () => {
  it('reads files and folders of the workspace in name order, skips what is not text, refuses PDFs and paths outside', async () => {
    const t = tempDir('tp-ts-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'ts');
    mkdirSync(join(store.root, 'docs', 'sub'), { recursive: true });
    writeFileSync(join(store.root, 'docs', 'b.md'), '# B\n\nBee text.');
    writeFileSync(join(store.root, 'docs', 'a.txt'), 'Plain a.');
    writeFileSync(join(store.root, 'docs', 'sub', 'c.html'), '<html><nav>menu</nav><h1>Title</h1><p>Body text.</p><script>evil()</script></html>');
    writeFileSync(join(store.root, 'docs', 'img.png'), 'x');
    writeFileSync(join(store.root, 'docs', 'paper.pdf'), '%PDF');
    try {
      const r = await loadDocuments(store, { paths: ['docs', 'docs/paper.pdf'] });
      expect(r.docs.map((d) => d.name)).toEqual(['docs/a.txt', 'docs/b.md', 'docs/sub/c.html']);
      const html = r.docs.find((d) => d.name.endsWith('c.html'))!;
      expect(html.text).toContain('# Title');
      expect(html.text).toContain('Body text.');
      expect(html.text).not.toMatch(/menu|evil/);
      expect(r.skipped.join('\n')).toMatch(/paper\.pdf.*extract its text first/);
      await expect(loadDocuments(store, { paths: ['../outside.md'] })).rejects.toThrow(/escapes the workspace/);
      await expect(loadDocuments(store, { paths: [join(t.dir, 'x.md')] })).rejects.toThrow(/outside the workspace/);
    } finally {
      t.cleanup();
    }
  });

  it('htmlToText keeps headings and drops scripts', async () => {
    expect(await htmlToText('<body><h2>Hours</h2><p>8 to 6</p><style>p{}</style></body>')).toBe('## Hours\n\n8 to 6');
  });
});

describe('the URL guard', () => {
  const ok = (body: string, type = 'text/html') => ({ status: 200, headers: new Headers({ 'content-type': type }), body: new Response(body).body });
  const publicIp = async () => ['93.184.216.34'];

  it('refuses what is not a public https page', () => {
    for (const u of ['http://example.com/a', 'https://user:pw@example.com/', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://printer.local/', 'ftp://example.com', 'not a url'])
      expect(() => checkDocumentUrl(u), u).toThrow(/refused/);
    expect(checkDocumentUrl('https://example.com/docs').hostname).toBe('example.com');
  });

  it('refuses a host that resolves to a private address, even when its name looks public', async () => {
    await expect(fetchDocument('https://docs.example.com/a', { resolve: async () => ['10.1.2.3'], fetchImpl: async () => ok('x') })).rejects.toThrow(/private or local address/);
    await expect(fetchDocument('https://docs.example.com/a', { resolve: async () => ['93.184.216.34', '192.168.1.9'], fetchImpl: async () => ok('x') })).rejects.toThrow(/private/);
  });

  it('reads text pages, rejects other types and big bodies', async () => {
    const r = await fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => ok('Hello', 'text/plain; charset=utf-8') });
    expect(r).toMatchObject({ text: 'Hello', html: false });
    await expect(fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => ok('{}', 'application/json') })).rejects.toThrow(/its type is application\/json/);
    await expect(fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => ok('x'.repeat(2 * 1024 * 1024 + 10), 'text/plain') })).rejects.toThrow(/larger than 2 MB/);
  });

  it('follows redirects to the same host only, three at most, and checks every hop', async () => {
    const hop = (to: string) => ({ status: 302, headers: new Headers({ location: to }), body: null });
    let calls = 0;
    const same = await fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => (calls++ === 0 ? hop('/b') : ok('B', 'text/plain')) });
    expect(same.url).toBe('https://docs.example.com/b');
    await expect(fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => hop('https://evil.example.org/x') })).rejects.toThrow(/another host/);
    await expect(fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => hop('http://docs.example.com/x') })).rejects.toThrow(/only https/);
    await expect(fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => hop('/loop') })).rejects.toThrow(/more than 3 redirects/);
    // a redirect to a private literal on the same name is not possible, but a literal host is checked on its own
    await expect(fetchDocument('https://docs.example.com/a', { resolve: publicIp, fetchImpl: async () => hop('https://169.254.169.254/') })).rejects.toThrow(/refused/);
  });

  it('one bad URL among several is reported and the others are read', async () => {
    const t = tempDir('tp-ts-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'ts');
    try {
      const r = await loadDocuments(store, { urls: ['https://docs.example.com/a', 'http://insecure.example.com/'], guard: { resolve: publicIp, fetchImpl: async () => ok('<h1>Doc</h1><p>Text.</p>') } });
      expect(r.docs).toHaveLength(1);
      expect(r.skipped.join('\n')).toMatch(/insecure.*only https/);
    } finally {
      t.cleanup();
    }
  });
});

const corpus = chunkCorpus([doc('handbook.md', MD)], { tokens: 40 });

describe('lexical helpers', () => {
  it('BM25 ranks the chunk that holds the question’s words first, and ties keep chunk order', () => {
    const top = bm25Rank(corpus.chunks, 'When does the clinic open on Saturdays?', 3);
    expect(top[0]!.chunk.text).toContain('Saturdays');
    expect(top[0]!.covers).toBeGreaterThan(0.5);
    expect(bm25Rank(corpus.chunks, 'zebra', 3)).toEqual([]);
  });

  it('token-set similarity and copy detection', () => {
    expect(termJaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(termJaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(copiedShare('The booster follows at 12 weeks and costs 45 dollars', 'Puppies receive their first vaccine at 8 weeks. The booster follows at 12 weeks and costs 45 dollars.')).toBeGreaterThan(0.9);
    expect(copiedShare('How much is the second shot for a young dog', MD)).toBeLessThan(0.5);
  });
});

describe('planning what the model is asked about', () => {
  // paragraphs of about 60 tokens with a budget of 70: one chunk each
  const big = chunkCorpus(Array.from({ length: 4 }, (_, i) => doc(`d${i}.md`, Array.from({ length: 5 }, (_, j) => `Paragraph ${j} of document ${i} about topic${i}${j}. ${'It goes on about the clinic and its patients for a while. '.repeat(4)}`).join('\n\n'))), { tokens: 70 });
  it('is deterministic per seed, interleaves documents, gives multi-hop a pair', () => {
    expect(big.chunks.length).toBe(20);
    const o = { seed: 's1', batch: 0, count: 8, types: ['single-hop', 'multi-hop'] as never };
    const a = planBatch(big.chunks, o);
    expect(planBatch(big.chunks, o)).toEqual(a);
    expect(planBatch(big.chunks, { ...o, seed: 's2' }).slots.map((s) => s.chunks[0])).not.toEqual(a.slots.map((s) => s.chunks[0]));
    expect(a.slots).toHaveLength(8);
    expect(a.slots.filter((s) => s.type === 'multi-hop').every((s) => s.chunks.length === 2 && s.chunks[0] !== s.chunks[1])).toBe(true);
    // the first four slots come from four different documents
    expect(new Set(a.slots.slice(0, 4).map((s) => s.chunks[0]!.split('#')[0])).size).toBe(4);
    expect(planBatch(big.chunks, { ...o, batch: 1, count: 10 }).slots.map((s) => s.n)).toEqual([9, 10]);
  });
});

function row(q: string, ref: string, chunks: TestsetChunk[], o: { answerable?: boolean; batch?: number; token?: string } = {}): ProposalItem {
  const record: TestsetRecord = {
    id: `ts-${q.length}`,
    question: q,
    reference: ref,
    reference_ids: chunks.map((c) => c.id),
    reference_contexts: chunks.map((c) => c.text),
    answerable: o.answerable !== false,
    tags: ['generated'],
    metadata: { generator: { task: 'rag-generate-testset', version: 1, seed: 's', batch: o.batch ?? 0, type: 'single-hop' } },
  };
  return { id: 'i1', kind: 'dataset-row', title: q, after: `${JSON.stringify(record)}\n`, language: 'json', data: { dataset: 'datasets/t.jsonl', record, corpus: o.token }, verification: [], selected: true };
}

describe('the verifiers', () => {
  const token = corpusToken(corpus, 'v');
  rememberCorpus(token, corpus);
  const hours = corpus.chunks.find((c) => c.text.includes('opens at 8am'))!;

  it('support: a reference made of words the chunk lacks fails; a faithful one passes (no judge: said so); a copied question warns', async () => {
    const bad = await verifySupport(row('When does it open?', 'The clinic offers free grooming every Tuesday afternoon for senior animals.', [hours]), {});
    expect(bad).toMatchObject({ verifier: 'testset-support', status: 'fail' });
    const good = await verifySupport(row('When does the clinic open on weekdays?', 'It opens at 8am on weekdays and closes at 6pm.', [hours]), {});
    expect(good).toMatchObject({ status: 'pass' });
    expect(good!.label).toMatch(/no judge/);
    const copy = await verifySupport(row('The clinic opens at 8am on weekdays and closes at 6pm', 'It opens at 8am on weekdays and closes at 6pm.', [hours]), {});
    expect(copy).toMatchObject({ status: 'warn', label: expect.stringMatching(/copies/) });
    const none = await verifySupport(row('Is it open?', '', [], { answerable: false }), {});
    expect(none!.status).toBe('pass');
  });

  it('answerable: an unanswerable question the corpus answers fails; one it cannot answer passes; a missing corpus is skipped', () => {
    const answered = verifyAnswerable(row('When does the clinic open on weekdays?', '', [], { answerable: false, token }));
    expect(answered).toMatchObject({ status: 'fail' });
    const unanswered = verifyAnswerable(row('Which surgeon performs hip replacements for horses?', '', [], { answerable: false, token }));
    expect(unanswered).toMatchObject({ status: 'pass' });
    expect(verifyAnswerable(row('q?', 'a', [hours], { token: 'gone' }))).toMatchObject({ status: 'skip' });
    const retrievable = verifyAnswerable(row('When does the clinic open on Saturdays?', 'At 9am.', [corpus.chunks.find((c) => c.text.includes('Saturdays'))!], { token }));
    expect(retrievable!.status).toBe('pass');
  });

  it('duplicate: a near-identical question of the same pass fails, a new pass starts at the first item', async () => {
    const a = { ...row('When does the clinic open on weekdays?', 'x', [hours], { token }), id: 'i1' };
    const b = { ...row('When does the clinic open on weekdays', 'x', [hours], { token }), id: 'i2' };
    const c = { ...row('What does the booster cost for puppies?', 'x', [hours], { token }), id: 'i3' };
    expect((await verifyDuplicate(a, {}))!.status).toBe('pass');
    expect((await verifyDuplicate(b, {}))!.status).toBe('fail');
    expect((await verifyDuplicate(c, {}))!.status).toBe('pass');
    // verifying again (a repair turn) does not make the item a duplicate of itself
    expect((await verifyDuplicate(a, {}))!.status).toBe('pass');
    expect((await verifyDuplicate(b, {}))!.status).toBe('fail');
  });
});

describe('applying rows to a dataset file', () => {
  it('appends each row once, keeps what the verifiers said, and undo restores the file (or removes it)', () => {
    const t = tempDir('tp-ts-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'ts');
    try {
      const hours = corpus.chunks[1]!;
      const i1 = { ...row('First question about opening?', 'At 8am.', [hours]), id: 'i1', verification: [{ verifier: 'testset-support', status: 'pass' as const, label: 'ok' }] };
      const i2 = { ...row('Second question about vaccines for puppies?', 'At 8 weeks.', [hours]), id: 'i2' };
      const u1 = applyDatasetRowItem(store, i1);
      const u2 = applyDatasetRowItem(store, i2);
      applyDatasetRowItem(store, i2);
      const file = join(store.root, 'datasets', 't.jsonl');
      const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines.map((l) => l.question)).toEqual(['First question about opening?', 'Second question about vaccines for puppies?']);
      expect(lines[0].metadata.verification).toEqual([{ verifier: 'testset-support', status: 'pass' }]);
      expect(lines[0].tags).toContain('generated');
      undoDatasetRows(store, u2.dataset!);
      expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
      undoDatasetRows(store, u1.dataset!);
      expect(existsSync(file)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('refuses a dataset path outside datasets/ or not .jsonl, and takes the text edited in the review', () => {
    const t = tempDir('tp-ts-');
    const store = WorkspaceStore.create(join(t.dir, 'ws'), 'ts');
    try {
      const it = row('A question that is long enough?', 'An answer.', []);
      for (const p of ['tests/x.jsonl', 'datasets/../x.jsonl', 'datasets/sub/x.jsonl', 'datasets/x.csv', '/etc/passwd']) expect(() => applyDatasetRowItem(store, { ...it, data: { ...(it.data as object), dataset: p } }), p).toThrow(/not a dataset file/);
      const edited = { ...(it.data as { record: object }).record, question: 'The edited question?' };
      applyDatasetRowItem(store, { ...it, after: JSON.stringify(edited) });
      expect(readFileSync(join(store.root, 'datasets', 't.jsonl'), 'utf8')).toContain('The edited question?');
    } finally {
      t.cleanup();
    }
  });
});
