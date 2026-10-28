import { describe, expect, it } from 'vitest';
import { WIN_PROXY_OVERRIDE } from '../../packages/core/src/debugger/capture.js';

describe('system proxy capture', () => {
  it('sends localhost through the proxy too (a local site is the usual thing to debug)', () => {
    expect(WIN_PROXY_OVERRIDE).toBe('<-loopback>');
  });
});
