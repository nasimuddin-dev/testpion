import { describe, expect, it } from 'vitest';
import {
  SECRET_VALUE_PATTERNS,
  classifySecret,
  findSecretValues,
  isNonSecretKey,
  isSecretKey,
  isSecretReference,
  maskSensitiveText,
  mayHoldSecretShape,
  replaceSecretValues,
  valueConfidence,
} from '../../packages/core/src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VALUE_FIXTURES } from '../fixtures/secrets/values.js';

// SEC-1: one detector for git check, the masks (logs, AI context) and the export.
describe('secret detector: value shapes', () => {
  it('has a fixture for every pattern', () => {
    expect(VALUE_FIXTURES.map((f) => f.id).sort()).toEqual(SECRET_VALUE_PATTERNS.map((p) => p.id).sort());
  });

  for (const f of VALUE_FIXTURES) {
    it(`${f.id}: found with confidence ${f.confidence}, and the look-alike is not`, () => {
      const hit = findSecretValues(f.positive).find((m) => m.id === f.id);
      expect(hit, f.positive).toBeDefined();
      expect(hit!.confidence).toBe(f.confidence);
      expect(findSecretValues(f.negative)).toEqual([]);
      expect(valueConfidence(f.negative)).toBeUndefined();
    });
  }

  it('keeps the scheme and the user, takes only the secret part', () => {
    const pg = VALUE_FIXTURES.find((f) => f.id === 'connection-string')!.positive;
    expect(replaceSecretValues(pg, () => '{{dbPassword}}')).toBe('postgres://app:{{dbPassword}}@db.example.com:5432/clinic');
    const bearer = VALUE_FIXTURES.find((f) => f.id === 'auth-scheme')!.positive;
    expect(maskSensitiveText(`Authorization: ${bearer}`)).toBe('Authorization: Bearer [REDACTED:bearer]');
  });

  it('a minimum confidence leaves the weaker shapes alone', () => {
    const jwt = VALUE_FIXTURES.find((f) => f.id === 'jwt')!.positive;
    expect(findSecretValues(jwt, 'high')).toEqual([]);
    expect(replaceSecretValues(jwt, () => 'X', 'high')).toBe(jwt);
  });
});

describe('secret detector: references and names', () => {
  it('references are never findings', () => {
    for (const ref of [
      '{{token}}',
      'Bearer {{token}}',
      '{{$secret.provider.openai.apiKey}}',
      '$secret.mcp.key',
      '$env.GITHUB_TOKEN',
      '${GITHUB_TOKEN}',
      '$GITHUB_TOKEN',
      'env:DATABASE_URL',
      'postgres://u:{{dbPassword}}@h/db',
    ])
      expect([ref, isSecretReference(ref), classifySecret('Authorization', ref)]).toEqual([ref, true, undefined]);
    // a password that merely starts with $ is not a reference
    expect(isSecretReference('$ecretPass1')).toBe(false);
    expect(findSecretValues('postgres://u:{{dbPassword}}@h/db')).toEqual([]);
  });

  it('secret key names, exact and by suffix, and the allow-list', () => {
    for (const k of ['password', 'Authorization', 'X-API-Key', 'accessToken', 'client_secret', 'GITHUB_TOKEN']) expect([k, isSecretKey(k)]).toEqual([k, true]);
    for (const k of ['Content-Type', 'Accept', 'User-Agent', 'Cache-Control', 'X-Request-Id', 'totalTokens', 'NODE_ENV', 'baseUrl']) expect([k, isSecretKey(k)]).toEqual([k, false]);
    expect(isNonSecretKey('content_type')).toBe(true);
    expect(isNonSecretKey('Authorization')).toBe(false);
  });

  it('classifies a pair: key name high, value shape at its own confidence, allow-listed never', () => {
    expect(classifySecret('password', 'hunter2')).toEqual({ confidence: 'high', reason: 'key' });
    const key = VALUE_FIXTURES.find((f) => f.id === 'openai')!.positive;
    expect(classifySecret('note', key)).toEqual({ confidence: 'high', reason: 'value', pattern: 'openai' });
    expect(classifySecret('Authorization', key)).toMatchObject({ confidence: 'high', reason: 'key+value' });
    expect(classifySecret('Content-Type', key)).toBeUndefined();
    expect(classifySecret('Content-Type', 'application/json')).toBeUndefined();
    expect(classifySecret('password', '')).toBeUndefined();
    expect(classifySecret('page', '2')).toBeUndefined();
  });
});

describe('secret detector: the one-test prefilter', () => {
  // every pattern run on its own, without the prefilter: what the detector must still find
  const raw = (text: string) =>
    SECRET_VALUE_PATTERNS.flatMap((p) => {
      p.re.lastIndex = 0;
      return [...text.matchAll(p.re)].map((m) => `${p.id}@${m.index}`);
    });
  const corpus = [
    ...VALUE_FIXTURES.flatMap((f) => [f.positive, f.negative, `x ${f.positive} y`, f.positive.toLowerCase(), f.positive.toUpperCase()]),
    ...readdirSync(join(__dirname, '../../examples/public-workspace/collections')).map((f) => readFileSync(join(__dirname, '../../examples/public-workspace/collections', f), 'utf8')),
  ];
  it('every match of a pattern contains its hint (so a text without any hint holds no shape)', () => {
    for (const p of SECRET_VALUE_PATTERNS) {
      const hint = new RegExp(p.hint, p.re.flags.includes('i') ? 'i' : '');
      for (const text of corpus) {
        p.re.lastIndex = 0;
        for (const m of text.matchAll(p.re)) expect([p.id, m[0], hint.test(m[0])]).toEqual([p.id, m[0], true]);
      }
    }
  });
  it('finds exactly what the patterns find one by one', () => {
    for (const text of corpus) if (!mayHoldSecretShape(text)) expect(raw(text)).toEqual([]);
    for (const f of VALUE_FIXTURES) expect(mayHoldSecretShape(f.positive)).toBe(true);
    expect(mayHoldSecretShape('{{baseUrl}}/folder-1/item-2?page={{page}}&v={{v3}}')).toBe(false);
    expect(mayHoldSecretShape('tp.test("ok", () => tp.response.to.have.status(200));')).toBe(false);
  });
});
