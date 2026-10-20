/**
 * AI-12 · Natural-language search with the mock model (scripted answers; never a real key): golden question → query
 * pairs run end to end (the model's JSON is validated, TestPion runs the query), what the model is sent (the question,
 * the clock and field names — never the data searched), the repair loop on an invalid or hostile query, the plain text
 * search when there is no model / the model fails / its query stays invalid / a cap refuses, the scope a question is
 * asked in, a dry run, and the usage ledger. With AI_EVAL_LIVE=1 the same questions run against the configured model.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { aiUsageSummary, askSearch, listAiTasks, runQuerySpec, type SearchAnswer } from '../../packages/core/src/index.js';
import { harness, LIVE, printScorecard, score } from './harness.js';
import { NOW, seedSearchData } from './search-fixtures.js';

afterAll(printScorecard);

const json = (v: unknown) => JSON.stringify(v);
const where = (field: string, op: string, value: unknown) => ({ field, op, value });

/** Golden cases: the question, the query a good model writes, and what TestPion then finds. */
const GOLDEN: Array<{ question: string; spec: unknown; ids: string[]; says: RegExp }> = [
  {
    question: 'failed payment calls last week over 2 s',
    spec: {
      query: { sources: ['history'], where: [where('failed', 'eq', true), where('url', 'contains', 'payment'), where('time', 'within', '7d'), where('duration', 'gt', 2000)] },
      assumptions: ['"last week" taken as the last 7 days'],
    },
    ids: ['h1'],
    says: /Looking in History where failed is yes and url contains "payment" and time within the last 7 days and duration over 2 s/,
  },
  {
    question: 'which tests failed in production?',
    spec: { query: { sources: ['results'], where: [where('failed', 'eq', true), where('environment', 'eq', 'production')] } },
    ids: ['run-b:login'],
    says: /Looking in Test results where failed is yes and environment is "production"/,
  },
  {
    question: 'flaky tests',
    spec: { query: { sources: ['results'], where: [where('flaky', 'eq', true)] } },
    ids: ['run-b:checkout', 'run-a:checkout'],
    says: /flaky is yes/,
  },
  {
    question: 'traces where a tool timed out',
    spec: { query: { sources: ['traces'], where: [where('error', 'contains', 'timeout')] } },
    ids: ['tr1'],
    says: /Looking in Traces where error text contains "timeout"/,
  },
  {
    question: 'the slowest call yesterday',
    spec: { query: { sources: ['history'], where: [where('time', 'gte', '2026-10-18'), where('time', 'lte', '2026-10-18')], sort: { by: 'duration', dir: 'desc' }, limit: 1 } },
    ids: ['h2'],
    says: /slowest first, at most 1/,
  },
  {
    question: 'server errors on the api',
    spec: { query: { where: [where('status', 'gte', 500), where('status', 'lte', 599)] }, assumptions: ['server errors = 5xx'] },
    ids: ['h1'],
    says: /Looking in History where status at least 500 and status at most 599/,
  },
];

async function seeded(rules: Parameters<typeof harness>[0]['rules'], o: Parameters<typeof harness>[0] = {}) {
  const h = harness({ ...o, rules });
  await seedSearchData(h.store);
  return h;
}
const ask = (h: Awaited<ReturnType<typeof seeded>>, question: string, extra: Partial<Parameters<typeof askSearch>[1]> = {}): Promise<SearchAnswer> =>
  askSearch(h.deps, { question, now: NOW, ...extra });
const hits = (a: SearchAnswer) => a.outcome!.rows.map((r) => r.id);

describe('nl-search is a registered task', () => {
  it('is listed: small tier, JSON out, no proposal, nothing to apply', () => {
    const t = listAiTasks().find((x) => x.id === 'nl-search')!;
    expect(t).toMatchObject({ version: 1, tier: 'small', output: 'json', proposes: false });
    expect(t.description).toMatch(/never the data/);
  });
});

describe('golden questions → queries → hits', () => {
  for (const g of GOLDEN)
    it(`"${g.question}"`, async () => {
      const h = await seeded([{ match: '.', response: json(g.spec) }]);
      try {
        const a = await ask(h, g.question);
        expect(a.mode).toBe('ai');
        expect(hits(a)).toEqual(g.ids);
        expect(a.explain).toMatch(g.says);
        expect(a.chips.length).toBe(a.query.where.length);
        expect(a.model).toBe('Mock AI/mock-model');
        if (LIVE) score('nl-search', g.question, { calls: 1, repairs: a.repairs ?? 0, usage: a.usage ?? { totalTokens: 0 } }, JSON.stringify(hits(a)) === JSON.stringify(g.ids));
        // the model may guess; the guesses are shown
        expect(a.assumptions).toEqual((g.spec as { assumptions?: string[] }).assumptions ?? []);
      } finally {
        h.cleanup();
      }
    });
});

describe('what the model is sent', () => {
  it('the question, the clock and the field names; none of the data searched', async () => {
    if (LIVE) return;
    const h = await seeded([{ match: '.', response: json(GOLDEN[0]!.spec) }]);
    try {
      await ask(h, 'failed payment calls last week over 2 s');
      expect(h.rec.requests).toHaveLength(1);
      const sent = h.rec.sent();
      expect(sent).toContain('failed payment calls last week over 2 s');
      expect(sent).toContain('2026-10-19T12:00:00.000Z');
      for (const field of ['duration', 'environment', 'assertion', 'flaky']) expect(sent).toContain(field);
      // the workspace's own words: names, URLs, hosts, runs, error texts
      for (const secret of ['Charge card', 'api.example.com', 'payments/charge', 'Nightly', 'ECONNRESET', 'Login works', 'timeout after 5s', 'Checkout pays']) expect(sent).not.toContain(secret);
      // the call is JSON-schema'd and cheap
      expect(h.rec.requests[0]!.maxTokens).toBeLessThanOrEqual(800);
    } finally {
      h.cleanup();
    }
  });

  it('a secret typed into the question is masked before it is sent', async () => {
    if (LIVE) return;
    const h = await seeded([{ match: '.', response: json({ query: { where: [where('text', 'contains', 'x')] } }) }], { secrets: { apiToken: 'sk-live-0123456789abcdef' } });
    try {
      await ask(h, 'calls that used sk-live-0123456789abcdef');
      expect(h.rec.sent()).not.toContain('sk-live-0123456789abcdef');
    } finally {
      h.cleanup();
    }
  });

  it('a dry run sends nothing, searches nothing and shows what would be sent', async () => {
    const h = await seeded([{ match: '.', response: json(GOLDEN[0]!.spec) }]);
    try {
      const a = await ask(h, 'failed payment calls', { dryRun: true });
      expect(a.dryRun).toBe(true);
      expect(a.outcome).toBeUndefined();
      expect(h.rec.requests).toHaveLength(0);
      expect(a.preview!.messages!.map((m) => m.content).join('\n')).toContain('failed payment calls');
      expect(aiUsageSummary(h.store).today.calls).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('verification and repair', () => {
  it('an invalid, then a still invalid, then a corrected query: each problem goes back to the model', async () => {
    // outside the answer schema (an unknown source and field, a limit beyond the bound), then inside it but not allowed
    const bad = { query: { sources: ['users'], where: [where('password', 'eq', 'x')], limit: 9999 } };
    const notAllowed = { query: { sources: ['runs'], where: [where('status', 'contains', '5'), where('method', 'eq', 'GET')], limit: 5 } };
    const h = await seeded([{ match: '.', responses: [json(bad), json(notAllowed), json(GOLDEN[1]!.spec)] }]);
    try {
      const a = await ask(h, 'tests that failed in production');
      expect(a.mode).toBe('ai');
      expect(a.repairs).toBe(2);
      expect(hits(a)).toEqual(['run-b:login']);
      if (!LIVE) {
        expect(h.rec.requests[1]!.messages.at(-1)!.content).toMatch(/\/query\/sources\/0 must be equal to one of the allowed values[\s\S]*\/query\/limit must be <= 200/);
        const repair = h.rec.requests[2]!.messages.at(-1)!.content;
        expect(repair).toMatch(/"contains" is not an operator of status \(allowed: eq, ne, gt, gte, lt, lte, in\)/);
      }
    } finally {
      h.cleanup();
    }
  });

  it('a query that stays invalid after the repairs is a plain text search, saying why', async () => {
    if (LIVE) return;
    const h = await seeded([{ match: '.', response: json({ query: { where: [where('password', 'eq', 'x')] } }) }]);
    try {
      const a = await ask(h, 'payments charge');
      expect(a.mode).toBe('text');
      expect(a.fallback).toMatch(/not valid/);
      expect(a.explain).toMatch(/text contains "payments" and text contains "charge"/);
      expect(hits(a)).toEqual(['h1', 'h2']);
      // the three attempts were counted
      expect(a.usage!.totalTokens).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it('a non-JSON answer is repaired, then falls back', async () => {
    if (LIVE) return;
    const h = await seeded([{ match: '.', response: 'I would search for failed payment calls.' }]);
    try {
      const a = await ask(h, 'payments');
      expect(a.mode).toBe('text');
      expect(hits(a)).toEqual(['h1', 'h2']);
    } finally {
      h.cleanup();
    }
  });

  it('a hostile query (SQL, extra keys, prototype keys) never reaches the engine', async () => {
    if (LIVE) return;
    const hostile = [
      { query: { where: [{ field: 'text', op: 'contains', value: "'; DROP TABLE history; --", sql: 'DELETE FROM history' }] } },
      { query: { where: [], write: true } },
      JSON.parse('{"query": {"__proto__": {"x": 1}, "where": []}}'),
    ];
    for (const spec of hostile) {
      const h = await seeded([{ match: '.', response: json(spec) }]);
      try {
        const a = await ask(h, 'anything');
        expect(a.mode).toBe('text');
        expect(a.fallback).toMatch(/not valid/);
        // History is intact
        expect(h.store.meta.listHistory({ limit: 100 }).total).toBe(6);
      } finally {
        h.cleanup();
      }
    }
  });

  it('the literal text of a hostile value is only a substring to look for', async () => {
    if (LIVE) return;
    const h = await seeded([{ match: '.', response: json({ query: { where: [where('text', 'contains', "'; DROP TABLE history; --")] } }) }]);
    try {
      const a = await ask(h, 'drop');
      expect(a.mode).toBe('ai');
      expect(hits(a)).toEqual([]);
      expect(h.store.meta.listHistory({ limit: 100 }).total).toBe(6);
    } finally {
      h.cleanup();
    }
  });
});

describe('without a model, or when it fails', () => {
  it('no model set up: a plain text search with the reason', async () => {
    if (LIVE) return;
    const h = await seeded([], { settings: { pricing: [] } });
    try {
      const a = await ask(h, 'payments charge');
      expect(a.mode).toBe('text');
      expect(a.fallback).toMatch(/Searched for the words as typed instead/);
      expect(hits(a)).toEqual(['h1', 'h2']);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('noAi: the words as typed, no call', async () => {
    const h = await seeded([{ match: '.', response: json(GOLDEN[0]!.spec) }]);
    try {
      const a = await ask(h, 'payments', { noAi: true });
      expect(a).toMatchObject({ mode: 'text', fallback: expect.stringMatching(/no AI, as asked/) });
      expect(hits(a)).toEqual(['h1', 'h2']);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('a per-call cap refuses before anything is sent, and the box still answers', async () => {
    if (LIVE) return;
    const h = await seeded([{ match: '.', response: json(GOLDEN[0]!.spec) }], {
      settings: { assistantProvider: 'mock-ai', assistantModel: 'mock-model', pricing: [], ai: { maxTokensPerCall: 50 } },
    });
    try {
      const a = await ask(h, 'payments');
      expect(a.mode).toBe('text');
      expect(a.fallback).toMatch(/over the cap of 50 per call/);
      expect(h.rec.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('an empty question is refused', async () => {
    const h = await seeded([]);
    try {
      await expect(ask(h, '   ')).rejects.toThrow(/Ask a question/);
    } finally {
      h.cleanup();
    }
  });
});

describe('scope and the ledger', () => {
  it('asked inside History, the search stays inside History whatever the model wrote', async () => {
    const h = await seeded([{ match: '.', response: json({ query: { sources: ['runs', 'results'], where: [where('failed', 'eq', true)] } }) }]);
    try {
      const a = await ask(h, 'what failed', { scope: ['history'] });
      expect(a.query.sources).toEqual(['history']);
      expect(hits(a)).toEqual(['h1', 'h4', 'h6']);
      if (!LIVE) expect(h.rec.sent()).toMatch(/"scope":\s*\[\s*"history"/);
    } finally {
      h.cleanup();
    }
  });

  it('every call is in the usage ledger as task nl-search; no proposal is made', async () => {
    const h = await seeded([{ match: '.', response: json(GOLDEN[1]!.spec) }]);
    try {
      await ask(h, 'tests that failed in production');
      const u = aiUsageSummary(h.store);
      expect(u.today.calls).toBe(1);
      expect(u.recent[0]).toMatchObject({ task: 'nl-search', outcome: 'ok' });
      expect(u.recent[0]!.proposalId).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe('a query run directly (the chips edited by hand, --query-json)', () => {
  it('is validated, run and explained with no model call', async () => {
    const h = await seeded([{ match: '.', response: json(GOLDEN[0]!.spec) }]);
    try {
      const a = await runQuerySpec(h.store, { where: [where('status', 'eq', 404)] }, { now: NOW });
      expect(a).toMatchObject({ mode: 'query', explain: expect.stringContaining('status is 404') });
      expect(hits(a)).toEqual(['h6']);
      expect(h.rec.requests).toHaveLength(0);
      await expect(runQuerySpec(h.store, { where: [where('nope', 'eq', 1)] })).rejects.toThrow(/unknown field "nope"/);
      // inside a scope, as the History filter bar runs it
      expect(hits(await runQuerySpec(h.store, { where: [where('failed', 'eq', true)] }, { now: NOW, scope: ['runs'] }))).toEqual(['run-b', 'run-a']);
    } finally {
      h.cleanup();
    }
  });
});
