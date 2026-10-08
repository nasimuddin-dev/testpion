import { describe, expect, it } from 'vitest';
import { globToRegex } from '../../packages/core/src/util/glob.js';

describe('globToRegex', () => {
  describe('plain globs (debugger rules: * any run, ? one character, case-insensitive)', () => {
    it('matches whole strings only', () => {
      const re = globToRegex('api.example.com');
      expect(re.test('api.example.com')).toBe(true);
      expect(re.test('API.EXAMPLE.COM')).toBe(true);
      expect(re.test('api-example.com')).toBe(false); // the dot is literal
      expect(re.test('xapi.example.com')).toBe(false);
      expect(re.test('api.example.com/')).toBe(false);
    });

    it('* matches any run, across slashes', () => {
      const re = globToRegex('*.example.com/api/*');
      expect(re.test('a.example.com/api/users/1?x=y')).toBe(true);
      expect(re.test('.example.com/api/')).toBe(true);
      expect(re.test('a.example.com/v2/users')).toBe(false);
      expect(globToRegex('**').test('anything/at/all')).toBe(true);
    });

    it('? matches exactly one character', () => {
      const re = globToRegex('v?/users');
      expect(re.test('v1/users')).toBe(true);
      expect(re.test('v12/users')).toBe(false);
      expect(re.test('v/users')).toBe(false);
    });

    it('escapes the other regular-expression characters', () => {
      expect(globToRegex('a+b(c)[d]{e}|f^$\\').test('a+b(c)[d]{e}|f^$\\')).toBe(true);
      expect(globToRegex('a+b').test('aab')).toBe(false);
      expect(globToRegex('(a|b)').test('a')).toBe(false);
    });
  });

  describe('path globs (test discovery: segments)', () => {
    const match = (glob: string, path: string) => globToRegex(glob, { segments: true }).test(path);

    it('* and ? stop at a separator', () => {
      expect(match('tests/*.yaml', 'tests/a.yaml')).toBe(true);
      expect(match('tests/*.yaml', 'tests/sub/a.yaml')).toBe(false);
      expect(match('tests/?.yaml', 'tests/a.yaml')).toBe(true);
      expect(match('tests/?.yaml', 'tests//.yaml')).toBe(false);
    });

    it('** crosses directories, with or without a following separator', () => {
      expect(match('tests/**/*.yaml', 'tests/a.yaml')).toBe(true);
      expect(match('tests/**/*.yaml', 'tests/x/y/a.yaml')).toBe(true);
      expect(match('**/*.test.yaml', 'deep/down/a.test.yaml')).toBe(true);
      expect(match('tests/**', 'tests/x/y/a.yaml')).toBe(true);
      expect(match('tests/**/*.yaml', 'other/a.yaml')).toBe(false);
    });

    it('/ and \\ match each other and the match is case-insensitive', () => {
      expect(match('tests/**/*.yaml', 'tests\\x\\a.yaml')).toBe(true);
      expect(match('tests\\*.yaml', 'tests/a.yaml')).toBe(true);
      expect(match('Tests/*.YAML', 'tests/a.yaml')).toBe(true);
    });

    it('a dot and other specials are literal', () => {
      expect(match('tests/*.yaml', 'tests/ayaml')).toBe(false);
      expect(match('a+b/(c).yaml', 'a+b/(c).yaml')).toBe(true);
    });
  });

  describe('model globs (prices: ? is literal)', () => {
    const match = (glob: string, model: string) => globToRegex(glob, { question: false }).test(model);

    it('* alone matches every model and a name matches itself', () => {
      expect(match('*', 'gpt-4o-mini')).toBe(true);
      expect(match('gpt-4o', 'gpt-4o')).toBe(true);
      expect(match('gpt-4o', 'GPT-4O')).toBe(true);
      expect(match('gpt-4o', 'gpt-4o-mini')).toBe(false);
    });

    it('* matches any run inside a name', () => {
      expect(match('gpt-4o*', 'gpt-4o-mini-2024-07-18')).toBe(true);
      expect(match('claude-3-5-*-2024*', 'claude-3-5-sonnet-20240620')).toBe(true);
      expect(match('*sonnet*', 'claude-3-5-sonnet')).toBe(true);
      expect(match('gpt-4*', 'gpt-3.5-turbo')).toBe(false);
    });

    it('? and . are literal', () => {
      expect(match('model?', 'model?')).toBe(true);
      expect(match('model?', 'modelx')).toBe(false);
      expect(match('gpt-3.5', 'gpt-3x5')).toBe(false);
    });
  });
});
