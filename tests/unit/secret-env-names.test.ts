import { describe, expect, it } from 'vitest';
import { EnvSecretStore, envNameForSecret, legacyEnvNameForSecret } from '../../packages/core/src/index.js';

describe('environment variable names of secrets', () => {
  it('two names that used to meet in one variable get different ones', () => {
    const names = ['env.a-b.key', 'env.a_b.key', 'env.a.b.key', 'env.a b.key'];
    expect(new Set(names.map(legacyEnvNameForSecret)).size).toBe(1); // the old mapping: one variable for all
    expect(new Set(names.map(envNameForSecret)).size).toBe(names.length);
    expect(envNameForSecret('env.a-b.key')).toMatch(/^TESTPION_SECRET_ENV_A_B_KEY_H[0-9A-F]{8}$/);
  });

  it('plain names keep the readable form documented before', () => {
    expect(envNameForSecret('provider.openai.apiKey')).toBe('TESTPION_SECRET_PROVIDER_OPENAI_APIKEY');
    expect(envNameForSecret('env.staging.token')).toBe('TESTPION_SECRET_ENV_STAGING_TOKEN');
  });

  it('a pipeline that set the old variable still resolves; the exact name wins when both are set', () => {
    const old = new EnvSecretStore({ TESTPION_SECRET_ENV_DEV_API_KEY: 'from-old' });
    expect(old.get('env.dev.api_key')).toBe('from-old');
    const both = new EnvSecretStore({ TESTPION_SECRET_ENV_DEV_API_KEY: 'from-old', [envNameForSecret('env.dev.api_key')]: 'from-new' });
    expect(both.get('env.dev.api_key')).toBe('from-new');
    expect(both.get('env.dev.apikey')).toBeUndefined();
  });
});
