/**
 * docs/ai-testing/rag-metrics.md is generated from the metric registry: it must match what the registry says now, and it
 * must be on the docs site and in the AI index (llms.txt gets a line when the page is added by the owner's review).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ragMetricsMarkdown, metricCatalogue } from '../../packages/core/src/index.js';

describe('rag-metrics.md', () => {
  const doc = readFileSync('docs/ai-testing/rag-metrics.md', 'utf8').replace(/\r\n/g, '\n');

  it('is the registry’s page: `node scripts/gen-rag-metrics-doc.mjs` rewrites it', () => {
    expect(doc).toBe(ragMetricsMarkdown());
  });

  it('has a section for every metric, with its formula and an example', () => {
    for (const m of metricCatalogue()) {
      expect(doc, m.id).toContain(`\`${m.id}\``);
      expect(doc, m.id).toContain(m.example);
    }
    expect(doc).toContain(`TestPion has ${metricCatalogue().length} RAG metrics`);
  });

  it('is in the docs sidebar', () => {
    expect(readFileSync('docs/.vitepress/config.mts', 'utf8')).toContain('/ai-testing/rag-metrics');
  });
});
