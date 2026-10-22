import { describe, expect, it } from 'vitest';
import { validateSchema, assertRemoteUrl, gitClone } from '../../packages/core/src/index.js';

describe('security review leftovers', () => {
  it('a JSON Schema pattern that can freeze the app is refused, a normal one validates', () => {
    expect(() => validateSchema({ type: 'string', pattern: '^(a+)+$' }, 'aaaa')).toThrow(/refused/);
    expect(validateSchema({ type: 'string', pattern: '^[a-z]+@[a-z]+\\.com$' }, 'a@b.com').valid).toBe(true);
    expect(validateSchema({ type: 'string', pattern: '^[a-z]+$' }, 'A1').valid).toBe(false);
  });

  it('git clone refuses the ext:: transport', async () => {
    expect(() => assertRemoteUrl('ext::sh')).toThrow(/ext::/);
    await expect(gitClone('ext::sh', 'does-not-matter')).rejects.toThrow(/ext::/);
  });
});
