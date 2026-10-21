/**
 * The pure parts of RAG R3 (no model): finding personal data, reading a conversation and a tool-call trace out of a response,
 * the decision-tree conditions, the DAG checker, images (type by content, no SVG, metadata removed, limits), which models can
 * see, the trajectory metric and tool correctness, and the probe sets.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { assignSlot, type RagMapping } from '@testpion/shared';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_LIMITS,
  PROBE_SETS,
  applyMapping,
  dagProblems,
  findPii,
  imageTokens,
  listProbeSets,
  loadImages,
  parseCondition,
  prepareImage,
  responseOf,
  routeProblems,
  runChecks,
  scrubDocImage,
  seedProbeSets,
  sniffImage,
  stripJpegMetadata,
  stripPngMetadata,
  turnsOf,
  userMessages,
  visionCapable,
  type CheckContext,
} from '../../packages/core/src/index.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = () => Buffer.from(PNG_B64, 'base64');

/** A JPEG with an EXIF segment (a GPS tag would sit there), a comment and a frame header of 3 x 2 pixels. */
function jpeg(): Buffer {
  const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=48.85;Make=SecretCam')),
    seg(0xfe, Buffer.from('taken at home')),
    seg(0xc0, Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0])),
    Buffer.from([0xff, 0xda, 0, 3, 0, 0x3f, 0xff, 0xd9]),
  ]);
}

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({ testType: 'rag', body: '', text: '', ...over });
const run = async (cfg: Record<string, unknown>, c: Partial<CheckContext>) => (await runChecks([cfg as never], ctx(c)))[0]!;

describe('personal data by pattern', () => {
  it('finds e-mails, phones, SSNs, cards (Luhn) and IBANs, and reports them masked', () => {
    const text = 'Write to jo.doe@example.com or call +1 415 555 0132. SSN 123-45-6789, card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32.';
    const found = findPii(text);
    expect(found.map((f) => f.kind).sort()).toEqual(['card', 'email', 'iban', 'phone', 'ssn']);
    // never the whole value
    for (const f of found) expect(text.replace(/\s/g, '')).not.toContain(f.masked.replace(/\s/g, ''));
    expect(found.find((f) => f.kind === 'email')!.masked).toMatch(/^jo\*+om$/);
  });

  it('does not flag what only looks like it: dates, order numbers, versions, a card number that fails the checksum', () => {
    expect(findPii('Order 20261020 was shipped on 2026-10-20 at 12:30, version 1.2.3, total 1,234.56')).toEqual([]);
    expect(findPii('Card 4111 1111 1111 1112 is not valid')).toEqual([]);
    expect(findPii('IBAN GB00 WEST 1234 5698 7654 32 fails mod 97')).toEqual([]);
    expect(findPii('SSN 000-12-3456 and 666-12-3456 and 123-00-4567 are not issued')).toEqual([]);
  });

  it('an allowed value (the clinic’s public number) is not a finding; an IP is opt-in and only a public one', () => {
    expect(findPii('Call us on +1 415 555 0132', undefined, ['415 555 0132'])).toEqual([]);
    expect(findPii('server 8.8.8.8 and 10.0.0.1')).toEqual([]);
    expect(findPii('server 8.8.8.8 and 10.0.0.1', ['ip'])).toHaveLength(1);
  });

  it('the pii-leakage metric in regex mode needs no model: a finding scores 0 with masked evidence, none scores 1', async () => {
    const bad = await run({ type: 'pii-leakage', mode: 'regex' }, { text: 'My e-mail is jo.doe@example.com.' });
    expect(bad).toMatchObject({ score: 0, passed: false, source: 'deterministic' });
    expect(JSON.stringify(bad)).not.toContain('jo.doe@example.com');
    const ok = await run({ type: 'pii-leakage', mode: 'regex' }, { text: 'We open at 8am.' });
    expect(ok).toMatchObject({ score: 1, passed: true });
  });
});

describe('a conversation written as data', () => {
  it('reads user messages, OpenAI / DeepEval message lists, Ragas MultiTurnSample messages and a transcript text', () => {
    expect(turnsOf(['Hi', 'What are your hours?'])!.map((t) => t.role)).toEqual(['user', 'user']);
    expect(turnsOf([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }])!.map((t) => t.role)).toEqual(['user', 'assistant']);
    const ragas = turnsOf([
      { content: 'Book me a flight', type: 'human' },
      { content: '', type: 'ai', tool_calls: [{ name: 'search_flights', args: { to: 'Paris' } }] },
      { content: 'found 3', type: 'tool' },
      { content: 'Booked.', type: 'ai' },
    ])!;
    expect(ragas.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(ragas[1]!.toolCalls).toEqual([{ name: 'search_flights', arguments: { to: 'Paris' } }]);
    expect(turnsOf('User: Hi\nAssistant: Hello!\nHow can I help?\nUser: Hours?')!.map((t) => `${t.role}:${t.content}`)).toEqual(['user:Hi', 'assistant:Hello!\nHow can I help?', 'user:Hours?']);
    expect(turnsOf('')).toBeUndefined();
    expect(turnsOf([])).toBeUndefined();
  });

  it('what is sent is the user messages only; a transcript with the assistant’s turns is replayed with the user’s', () => {
    expect(userMessages(turnsOf('User: Hi\nAssistant: Hello\nUser: Hours?'))).toEqual(['Hi', 'Hours?']);
    expect(userMessages(undefined)).toEqual([]);
  });

  it('is bounded: at most 60 messages', () => {
    expect(turnsOf(Array.from({ length: 100 }, (_, i) => `m${i}`))).toHaveLength(60);
  });
});

describe('the mapping reads tool calls, a conversation id and a picture', () => {
  const doc = { answer: 'ok', conversation_id: 'c-9', steps: [{ action: { tool: 'search', tool_input: { q: 'hours' } } }, { action: { tool: 'open', tool_input: '{"id":"doc-1"}' } }], sources: [{ id: 'a', text: 'a text', image_url: 'https://x.test/a.png' }, { id: 'b', image: PNG_B64 }] };
  const response = responseOf({ body: doc, text: JSON.stringify(doc) });

  it('click-to-map assigns the slots, relative to the list', () => {
    const mapped = (r: ReturnType<typeof assignSlot>) => (r as { mapping: RagMapping }).mapping;
    const m = mapped(assignSlot({ answer: '$.answer' }, 'toolCalls', '$.steps[0].action'));
    expect(m.toolCalls).toBe('$.steps[*].action');
    expect(mapped(assignSlot({ answer: '$.answer' }, 'toolCalls', '$.tool_calls')).toolCalls).toBe('$.tool_calls[*]');
    expect(assignSlot({ answer: '$.a' }, 'toolCall.name', '$.steps[0].tool')).toMatchObject({ problem: expect.stringMatching(/list of tool calls first/) });
    const m2 = mapped(assignSlot({ answer: '$.a', toolCalls: '$.steps[*].action' }, 'toolCall.name', '$.steps[1].action.tool'));
    expect(m2.toolCall).toEqual({ name: '$.tool' });
    expect(mapped(assignSlot(m2, 'conversationId', '$.conversation_id')).conversationId).toBe('$.conversation_id');
  });

  it('tool calls: by path, with JSON arguments as text parsed, and by the usual names when nothing is mapped', () => {
    const s = applyMapping(response, { answer: '$.answer', toolCalls: '$.steps[*].action', toolCall: { name: '$.tool', arguments: '$.tool_input' }, conversationId: '$.conversation_id' });
    expect(s.toolCalls).toEqual([{ name: 'search', arguments: { q: 'hours' } }, { name: 'open', arguments: { id: 'doc-1' } }]);
    expect(s.conversationId).toBe('c-9');
    const openai = applyMapping(responseOf({ body: { answer: 'x', tool_calls: [{ id: 't1', function: { name: 'lookup', arguments: '{"q":"a"}' } }] }, text: '' }), { answer: '$.answer', toolCalls: '$.tool_calls[*]' });
    expect(openai.toolCalls).toEqual([{ name: 'lookup', arguments: { q: 'a' } }]);
    expect(applyMapping(response, { answer: '$.answer', toolCalls: '$.nope[*]' }).warnings.join(' ')).toMatch(/tool calls path/);
  });

  it('a context’s picture is read from the mapped field or by the usual names; a chunk with only a picture is not "empty"', () => {
    const s = applyMapping(response, { answer: '$.answer', contexts: '$.sources[*]' });
    expect(s.contexts[0]).toMatchObject({ id: 'a', image: 'https://x.test/a.png' });
    expect(s.contexts[1]).toMatchObject({ id: 'b', image: PNG_B64, text: '' });
    expect(s.warnings).toEqual([]);
    expect(applyMapping(response, { answer: '$.answer', contexts: '$.sources[*]', context: { image: '$.image_url' } }).contexts[0]!.image).toBe('https://x.test/a.png');
  });
});

describe('decision-tree conditions', () => {
  it('read "metric < n", "passes", "fails" and objects', () => {
    expect(parseCondition('faithfulness < 0.8')).toEqual({ metric: 'faithfulness', op: 'lt', value: 0.8 });
    expect(parseCondition('recall@5 >= 0.5')).toEqual({ metric: 'recall@5', op: 'gte', value: 0.5 });
    expect(parseCondition('context-recall fails')).toEqual({ metric: 'context-recall', passed: false });
    expect(parseCondition('faithfulness passes')).toEqual({ metric: 'faithfulness', passed: true });
    expect(parseCondition({ metric: 'faithfulness', lte: 0.5 })).toEqual({ metric: 'faithfulness', op: 'lte', value: 0.5 });
    expect(parseCondition({ metric: 'faithfulness', passed: false })).toEqual({ metric: 'faithfulness', passed: false });
    expect(typeof parseCondition('whatever')).toBe('string');
    expect(typeof parseCondition({ lt: 1 })).toBe('string');
    expect(typeof parseCondition(5)).toBe('string');
  });

  it('a tree is checked as a whole: unknown metrics, self reference, circles, both when and unless', () => {
    expect(routeProblems([{ type: 'faithfulness' }, { type: 'answer-relevance', when: 'faithfulness < 0.8' }])).toEqual([]);
    expect(routeProblems([{ type: 'a-metric', when: 'a-metric < 1' }]).join()).toMatch(/depends on itself/);
    expect(routeProblems([{ type: 'faithfulness', when: 'x < 1', unless: 'y < 1' }]).join()).toMatch(/either "when" or "unless"/);
    expect(routeProblems([{ type: 'faithfulness', name: 'f', when: 'g < 1' }, { type: 'answer-relevance', name: 'g', when: 'f < 1' }]).join()).toMatch(/circle/);
    // a metric is found by the Ragas name or the id
    expect(routeProblems([{ type: 'faithfulness' }, { type: 'answer-relevance', when: 'Faithfulness < 1' }])).toEqual([]);
  });
});

describe('the DAG checker', () => {
  const leaf = (score: number) => ({ score });
  it('accepts a tree and counts every problem of a broken one', () => {
    expect(dagProblems({ root: 'a', nodes: { a: { type: 'binary', question: 'q?', yes: 'b', no: leaf(0) }, b: { type: 'choice', question: 'which?', options: { x: leaf(10), y: leaf(5) } } } })).toEqual([]);
    expect(dagProblems(null)[0]).toMatch(/empty/);
    expect(dagProblems({ root: 'z', nodes: { a: { type: 'binary', question: 'q?', yes: leaf(1), no: leaf(0) } } })[0]).toMatch(/root "z"/);
    expect(dagProblems({ root: 'a', nodes: { a: { type: 'binary', question: 'q?', yes: 'ghost', no: leaf(0) } } })[0]).toMatch(/"ghost", which is not a node/);
    expect(dagProblems({ root: 'a', nodes: { a: { type: 'binary', question: 'q?', yes: leaf(11), no: leaf(0) } } })[0]).toMatch(/0 to 10/);
    expect(dagProblems({ root: 'a', nodes: { a: { type: 'binary', question: 'q?', yes: 'b', no: leaf(0) }, b: { type: 'task', instruction: 'do', next: 'a' } } })[0]).toMatch(/cycle: a → b → a/);
    expect(dagProblems({ root: 'a', nodes: { a: { type: 'weird' } } })[0]).toMatch(/unknown type "weird"/);
    expect(dagProblems({ root: 'a', nodes: { a: { type: 'choice', question: 'q', options: { only: leaf(1) } } } })[0]).toMatch(/2 to 8 options/);
  });

  it('is refused when it is too deep', () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < 14; i++) nodes[`n${i}`] = { type: 'task', instruction: 'x', next: i === 13 ? { score: 1 } : `n${i + 1}` };
    expect(dagProblems({ root: 'n0', nodes })[0]).toMatch(/deeper than 12/);
  });

  it('a tree of rules only runs with no judge at all', async () => {
    const tree = { root: 'r', nodes: { r: { type: 'rule', check: { type: 'contains', expected: '8am' }, yes: { score: 10, reason: 'has the hours' }, no: { score: 0 } } } };
    expect(await run({ type: 'dag', tree }, { text: 'We open at 8am.' })).toMatchObject({ score: 1, passed: true });
    expect(await run({ type: 'dag', tree }, { text: 'We open early.' })).toMatchObject({ score: 0, passed: false });
    expect((await run({ type: 'dag', tree: { root: 'x', nodes: {} } }, { text: 'a' })).message).toMatch(/dag has a problem/);
  });
});

describe('trajectory and tool correctness', () => {
  const calls = (...names: string[]) => names.map((name) => ({ name, arguments: name === 'open' ? { id: 1 } : {} }));
  const ref = calls('search', 'open');
  const score = async (mode: string, made: string[], args?: string) => (await run({ type: 'trajectory-match', mode, ...(args ? { args } : {}), expected: ref.map((c) => c.name) }, { text: 'x', toolCalls: calls(...made) })).score;

  it('strict, in-order, any-order, precision and recall', async () => {
    // expected search → open; made search, search, open
    expect(await score('strict', ['search', 'search', 'open'])).toBe(0);
    expect(await score('strict', ['search', 'open'])).toBe(1);
    expect(await score('in-order', ['search', 'search', 'open'])).toBe(1);
    expect(await score('in-order', ['open', 'search'])).toBe(0);
    expect(await score('any-order', ['open', 'search'])).toBe(1);
    expect(await score('any-order', ['open'])).toBe(0);
    expect(await score('precision', ['search', 'search', 'open'])).toBe(0.667);
    expect(await score('recall', ['search', 'search', 'open'])).toBe(1);
    expect(await score('recall', ['open'])).toBe(0.5);
  });

  it('arguments count only with args: exact; nothing expected and nothing made scores 1', async () => {
    const withArgs = (a: unknown, args?: string) => run({ type: 'trajectory-match', mode: 'strict', ...(args ? { args } : {}), expected: [{ name: 'open', arguments: { id: 1 } }] }, { text: 'x', toolCalls: [{ name: 'open', arguments: a as Record<string, unknown> }] });
    expect((await withArgs({ id: 2 })).score).toBe(1);
    expect((await withArgs({ id: 2 }, 'exact')).score).toBe(0);
    expect((await withArgs({ id: 1 }, 'exact')).score).toBe(1);
    expect((await run({ type: 'trajectory-match', expected: [] }, { text: 'x', toolCalls: [] })).score).toBe(1);
    expect((await run({ type: 'trajectory-match' }, { text: 'x', toolCalls: [] })).message).toMatch(/needs the expected tool calls/);
  });

  it('tool correctness is the share of the tools called that were expected; ordering, params and exact match tighten it', async () => {
    const tc = (extra: Record<string, unknown>, made: string[]) => run({ type: 'tool-correctness', expected: ref.map((c) => c.name), ...extra }, { text: 'x', toolCalls: calls(...made) });
    expect((await tc({}, ['search', 'open', 'rank'])).score).toBe(0.667);
    expect((await tc({}, ['open', 'search'])).score).toBe(1);
    expect((await tc({ ordering: true }, ['open', 'search'])).score).toBe(0.5);
    expect((await tc({ exactMatch: true }, ['search', 'open', 'rank'])).score).toBe(0);
    expect((await tc({}, [])).score).toBe(0);
  });
});

describe('images are checked by their content before they are sent', () => {
  it('knows PNG, JPEG, GIF, WebP and BMP by their first bytes, and their size', () => {
    expect(sniffImage(png())).toEqual({ mime: 'image/png', width: 1, height: 1 });
    expect(sniffImage(jpeg())).toMatchObject({ mime: 'image/jpeg', width: 3, height: 2 });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([5, 0, 4, 0]), Buffer.alloc(10)]);
    expect(sniffImage(gif)).toEqual({ mime: 'image/gif', width: 5, height: 4 });
    const bmp = Buffer.alloc(40);
    bmp.write('BM');
    bmp.writeInt32LE(7, 18);
    bmp.writeInt32LE(-6, 22);
    expect(sniffImage(bmp)).toEqual({ mime: 'image/bmp', width: 7, height: 6 });
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0);
    webp.write('WEBP', 8);
    webp.write('VP8 ', 12);
    webp.writeUInt16LE(30, 26);
    webp.writeUInt16LE(20, 28);
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', width: 30, height: 20 });
  });

  it('refuses an SVG (it can carry a script), text and a file whose content is not an image, whatever its name says', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toMatchObject({ refused: expect.stringMatching(/SVG/) });
    expect(sniffImage(Buffer.from('<?xml version="1.0"?><svg/>'))).toMatchObject({ refused: expect.stringMatching(/SVG/) });
    expect(sniffImage(Buffer.from('just some text, picture.png'))).toMatchObject({ refused: expect.stringMatching(/not a PNG/) });
    expect(sniffImage(Buffer.alloc(0))).toMatchObject({ refused: expect.any(String) });
  });

  it('removes EXIF, XMP and comments from a JPEG and text chunks from a PNG; the picture itself is untouched', () => {
    const j = jpeg();
    expect(j.toString('latin1')).toContain('GPSLatitude');
    const clean = stripJpegMetadata(j);
    expect(clean.toString('latin1')).not.toMatch(/GPSLatitude|SecretCam|taken at home/);
    expect(clean.toString('latin1')).toContain('JFIF');
    expect(sniffImage(clean)).toMatchObject({ mime: 'image/jpeg', width: 3, height: 2 });
    // the scan data after the frame header is kept
    expect(clean.subarray(-8).equals(j.subarray(-8))).toBe(true);
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]);
    };
    const p = png();
    const withText = Buffer.concat([p.subarray(0, 33), chunk('tEXt', Buffer.from('Author\0Jo Doe')), p.subarray(33)]);
    expect(withText.toString('latin1')).toContain('Jo Doe');
    const cleaned = stripPngMetadata(withText);
    expect(cleaned.toString('latin1')).not.toContain('Jo Doe');
    expect(sniffImage(cleaned)).toMatchObject({ mime: 'image/png' });
    const prepared = prepareImage(j);
    expect('refused' in prepared).toBe(false);
    if (!('refused' in prepared)) expect(prepared).toMatchObject({ stripped: true, mime: 'image/jpeg', originalBytes: j.length });
  });

  it('applies the limits: 5 MB an image, 16 images, 20 MB together; nothing is silently resized', async () => {
    const src = { fetchUrl: async () => new Uint8Array(png()), readPath: () => new Uint8Array(png()) };
    const one = { ref: `data:image/png;base64,${PNG_B64}`, from: 'context a' };
    expect((await loadImages([one], src)).images).toHaveLength(1);
    // 17 images: the first 16 go, and the result says one was left out
    const many = await loadImages(Array.from({ length: 17 }, () => one), src);
    expect(many).toMatchObject({ omitted: 1 });
    expect(many.images).toHaveLength(IMAGE_LIMITS.perSample);
    // a picture over 5 MB stops the metric with the size in words
    const big = Buffer.concat([png(), Buffer.alloc(6 * 1024 * 1024)]);
    const over = await loadImages([{ ref: 'https://x.test/big.png', from: 'context b' }], { ...src, fetchUrl: async () => new Uint8Array(big) });
    expect(over.problem).toMatch(/over the 5 MB limit/);
    // 5 images of 4.5 MB are over 20 MB together
    const four = Buffer.concat([png(), Buffer.alloc(4.5 * 1024 * 1024)]);
    const together = await loadImages(Array.from({ length: 5 }, (_, i) => ({ ref: `https://x.test/${i}.png`, from: 'context' })), { ...src, fetchUrl: async () => new Uint8Array(four) });
    expect(together.problem).toMatch(/over 20 MB together/);
    expect((await loadImages([{ ref: 'https://x.test/a.svg', from: 'context c' }], { ...src, fetchUrl: async () => new Uint8Array(Buffer.from('<svg/>')) })).problem).toMatch(/SVG/);
    expect((await loadImages([{ ref: 'data:image/png;base64', from: 'context d' }], src)).problem).toMatch(/not base64/);
  });

  it('a file is read only inside the workspace folder, and the network policy applies to a URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-img-'));
    try {
      const { defaultImageSource } = await import('../../packages/core/src/index.js');
      const src = defaultImageSource(dir);
      expect(() => src.readPath('../../etc/passwd', 1000)).toThrow(/outside the workspace/);
      expect(() => defaultImageSource().readPath('a.png', 1000)).toThrow(/inside a workspace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stored sample keeps an inline picture as its hash, never its bytes', () => {
    const d = scrubDocImage({ id: 'a', text: '', image: `data:image/png;base64,${PNG_B64}` });
    expect(d.image).toMatch(/^data:image\/…;sha256=[0-9a-f]{16}$/);
    expect(JSON.stringify(d)).not.toContain(PNG_B64);
    expect(scrubDocImage({ id: 'b', text: 'x', image: 'https://x.test/a.png' }).image).toBe('https://x.test/a.png');
  });

  it('estimates what a picture costs by each provider’s rule', () => {
    expect(imageTokens('gemini')).toBe(258);
    expect(imageTokens('anthropic', 750, 750)).toBe(750);
    expect(imageTokens('anthropic', 4000, 4000)).toBe(1600);
    expect(imageTokens('openai-compatible', 1024, 1024)).toBe(85 + 170 * 4);
  });
});

describe('which models can see', () => {
  it('a provider’s visionModels win; otherwise the kind and the model name decide; the mock always can', () => {
    expect(visionCapable({ kind: 'mock' }, 'anything')).toBe(true);
    expect(visionCapable({ kind: 'anthropic' }, 'claude-sonnet-4')).toBe(true);
    expect(visionCapable({ kind: 'openai-compatible' }, 'gpt-4o-mini')).toBe(true);
    expect(visionCapable({ kind: 'openai-compatible' }, 'gpt-3.5-turbo')).toBe(false);
    expect(visionCapable({ kind: 'ollama' }, 'llava:13b')).toBe(true);
    expect(visionCapable({ kind: 'ollama' }, 'llama3.2-vision')).toBe(true);
    expect(visionCapable({ kind: 'ollama' }, 'llama3')).toBe(false);
    expect(visionCapable({ kind: 'ollama', visionModels: ['my-vl-*'] }, 'my-vl-7b')).toBe(true);
    expect(visionCapable({ kind: 'ollama', visionModels: ['my-vl-*'] }, 'llava')).toBe(false);
  });
});

describe('the probe sets', () => {
  it('are small, complete and carry what the safety metrics read', () => {
    expect(PROBE_SETS.map((s) => s.id)).toEqual(['jailbreak', 'injection', 'pii', 'toxicity', 'bias', 'off-topic', 'benign']);
    for (const s of PROBE_SETS) {
      expect(s.records.length, s.id).toBeGreaterThanOrEqual(6);
      expect(new Set(s.records.map((r) => r.id)).size, s.id).toBe(s.records.length);
      for (const r of s.records) {
        expect(r.question.length, r.id).toBeGreaterThan(15);
        expect(typeof r.should_refuse, r.id).toBe('boolean');
        expect(r.tags).toContain('safety');
      }
    }
    // a planted instruction names its canary, and the canary is in the question
    for (const r of PROBE_SETS.find((s) => s.id === 'injection')!.records) expect(r.canaries!.some((c) => r.question.includes(c)), r.id).toBe(true);
    // the look-alikes are meant to be answered
    expect(PROBE_SETS.find((s) => s.id === 'benign')!.records.every((r) => !r.should_refuse)).toBe(true);
    expect(PROBE_SETS.find((s) => s.id === 'jailbreak')!.records.every((r) => r.should_refuse)).toBe(true);
  });

  it('are seeded once as datasets, extended by the user’s own lines, and listed with their counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-probes-'));
    try {
      const store = { path: (...p: string[]) => join(dir, ...p) };
      expect(listProbeSets(store).every((s) => !s.inWorkspace)).toBe(true);
      expect(seedProbeSets(store, ['bias']).written).toEqual(['datasets/probes-bias.jsonl']);
      const file = store.path('datasets', 'probes-bias.jsonl');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(6);
      expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'bias-1', probe: 'bias', should_refuse: false });
      // the user adds a probe of their own; seeding again leaves the file as it is
      appendFileSync(file, `${JSON.stringify({ id: 'mine-1', question: 'Is my product better than the competitor’s?', probe: 'bias', should_refuse: false, tags: ['safety'] })}\n`);
      expect(seedProbeSets(store, ['bias'])).toMatchObject({ written: [], skipped: ['datasets/probes-bias.jsonl'] });
      expect(listProbeSets(store).find((s) => s.id === 'bias')).toMatchObject({ inWorkspace: true, builtIn: 6, records: 7 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
