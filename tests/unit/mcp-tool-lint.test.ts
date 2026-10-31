import { describe, expect, it } from 'vitest';
import { lintMcpTools, type LintTool } from '../../packages/shared/src/mcp-tool-lint.js';

const good = (over: Partial<LintTool> = {}): LintTool => ({
  name: 'search_orders',
  description: 'Find orders by customer or status. Use it before get_order; not for payments.',
  inputSchema: { type: 'object', properties: { customer: { type: 'string', description: 'The customer id' } }, required: ['customer'] },
  outputSchema: { type: 'object' },
  annotations: { readOnlyHint: true },
  ...over,
});
const codes = (tools: LintTool[], o?: { instructions?: string }) => lintMcpTools(tools, o).findings.map((f) => `${f.level}:${f.code}:${f.tool ?? ''}`);

describe('lintMcpTools', () => {
  it('says nothing about a well-described tool', () => {
    const r = lintMcpTools([good()]);
    expect(r.findings).toEqual([]);
    expect(r.text).toMatch(/^1 tool: 0 errors, 0 warnings, 0 tips\. The list takes about \d+ tokens/);
  });

  it('finds a missing, short, repeated or name-only description', () => {
    expect(codes([good({ description: '' })])).toContain('error:no-description:search_orders');
    expect(codes([good({ description: 'Orders.' })])).toContain('warn:short-description:search_orders');
    expect(codes([good({ name: 'list_items', description: 'list items' }), good({ name: 'list_items', description: 'List items.' })])).toContain('warn:description-repeats-name:list_items');
    const a = good({ name: 'a_tool', description: 'Find orders by customer or status; use it before get_order.' });
    const b = good({ name: 'b_tool', description: 'Find orders by customer or status; use it before get_order.' });
    expect(codes([a, b])).toContain('warn:same-description:b_tool');
    expect(codes([good({ description: 'x'.repeat(1600) })])).toContain('warn:long-description:search_orders');
  });

  it('finds a name no client accepts, a bad schema and a required parameter that does not exist', () => {
    expect(codes([good({ name: 'search orders!' })])).toContain('error:name:search orders!');
    expect(codes([good({ inputSchema: { type: 'string' } })])).toContain('error:schema-type:search_orders');
    expect(codes([good({ inputSchema: { type: 'object', properties: { a: { description: 'x' } }, required: ['b'] } })])).toContain('error:required-unknown:search_orders');
  });

  it('finds parameters without descriptions and a schema that names no required ones', () => {
    expect(codes([good({ inputSchema: { type: 'object', properties: { a: {}, b: {} }, required: ['a'] } })])).toContain('warn:no-parameter-descriptions:search_orders');
    expect(codes([good({ inputSchema: { type: 'object', properties: { a: { description: 'x' }, b: {} }, required: ['a'] } })])).toContain('tip:some-parameter-descriptions:search_orders');
    expect(codes([good({ inputSchema: { type: 'object', properties: { a: { description: 'x' } } } })])).toContain('tip:no-required:search_orders');
  });

  it('asks a destructive-sounding tool to say so, and a read to say it only reads', () => {
    expect(codes([good({ name: 'delete_order', description: 'Delete an order for good. Use only when asked.', annotations: undefined })])).toContain('warn:destructive-unmarked:delete_order');
    expect(codes([good({ name: 'delete_order', description: 'Delete an order for good. Use only when asked.', annotations: { destructiveHint: true } })])).not.toContain('warn:destructive-unmarked:delete_order');
    expect(codes([good({ annotations: undefined })])).toContain('tip:no-annotations:search_orders');
    expect(codes([good({ outputSchema: undefined })])).toContain('tip:no-output-schema:search_orders');
  });

  it('counts the tools and the list: too many, a big list, and no instructions for a big server', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => good({ name: `tool_${i}`, description: `Does thing number ${i}: use it when you need thing ${i}, not otherwise.` }));
    expect(codes(many(60))).toContain('warn:many-tools:');
    expect(codes(many(120))).toContain('error:too-many-tools:');
    expect(codes(many(10))).toContain('tip:no-instructions:');
    expect(codes(many(10), { instructions: 'Search first, then get.' })).not.toContain('tip:no-instructions:');
    const big = lintMcpTools(Array.from({ length: 10 }, (_, i) => good({ name: `t${i}`, description: 'd'.repeat(1400) + ` ${i}`, inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 80 }, (_, k) => [`p${k}`, { type: 'string', description: 'x'.repeat(120) }])), required: ['p0'] } })));
    expect(big.listTokens).toBeGreaterThan(20_000);
    expect(big.findings.some((f) => f.code === 'big-list')).toBe(true);
  });

  it('sorts errors first and counts each level', () => {
    const r = lintMcpTools([good({ description: '', name: 'a b' }), good({ name: 'ok_tool', annotations: undefined })]);
    expect(r.findings[0]!.level).toBe('error');
    expect(r.errors).toBeGreaterThanOrEqual(2);
    expect(r.errors + r.warnings + r.tips).toBe(r.findings.length);
  });

  it('looks at prompts and resources too', () => {
    const r = lintMcpTools([good()], {
      prompts: [{ name: 'review', arguments: [{ name: 'file' }, { name: 'style', description: 'tone' }] }, { name: 'ok', description: 'Review a file.' }],
      resources: [{ name: 'readme', uri: 'file:///r' }, { name: 'api', uri: 'file:///a', description: 'The API notes' }],
    });
    expect(r.findings.map((f) => `${f.level}:${f.code}`)).toEqual(['warn:prompt-no-description', 'tip:prompt-argument-no-description', 'tip:resource-no-description']);
    expect(r.findings[2]!.text).toBe('1 resource has no description: readme.');
  });
});
