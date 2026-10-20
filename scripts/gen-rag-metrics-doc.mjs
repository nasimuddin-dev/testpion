#!/usr/bin/env node
/**
 * Writes docs/ai-testing/rag-metrics.md from the RAG metric registry (packages/core). Build core first
 * (`npm run build -w @testpion/core`); tests/unit/rag-metrics-doc.test.ts fails when the page is out of date.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ragMetricsMarkdown } from '../packages/core/dist/index.js';

const out = fileURLToPath(new URL('../docs/ai-testing/rag-metrics.md', import.meta.url));
writeFileSync(out, ragMetricsMarkdown());
console.log(`wrote ${out}`);
