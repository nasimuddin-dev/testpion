import { describe, expect, it } from 'vitest';
import { MCP_DEFAULT_AI_CAPS, aiSettingsForSurface, checkAiCaps } from '../../packages/core/src/index.js';

// an agent that loops must not drain the person's credit: the MCP surface has default caps where the person set none
describe('default AI caps for agents (the mcp surface)', () => {
  it('apply to the mcp surface only, and only where no cap is set', () => {
    expect(aiSettingsForSurface(undefined, 'cli')).toBeUndefined();
    expect(aiSettingsForSurface({ localOnly: true }, 'app')).toEqual({ localOnly: true });
    expect(aiSettingsForSurface(undefined, 'mcp')).toMatchObject(MCP_DEFAULT_AI_CAPS);
    expect(aiSettingsForSurface({ dailyBudgetUsd: 20, maxTokensPerCall: 200_000 }, 'mcp')).toMatchObject({ dailyBudgetUsd: 20, maxTokensPerCall: 200_000, dailyTokens: MCP_DEFAULT_AI_CAPS.dailyTokens });
  });

  it('a call over the per-call cap is refused for an agent and allowed for the person', () => {
    const est = { tokens: MCP_DEFAULT_AI_CAPS.maxTokensPerCall + 1 };
    expect(() => checkAiCaps(undefined, aiSettingsForSurface(undefined, 'mcp'), est)).toThrow(/over the cap of 50,000 per call/);
    expect(() => checkAiCaps(undefined, aiSettingsForSurface(undefined, 'cli'), est)).not.toThrow();
    expect(() => checkAiCaps(undefined, aiSettingsForSurface({ maxTokensPerCall: 400_000 }, 'mcp'), est)).not.toThrow();
  });
});
