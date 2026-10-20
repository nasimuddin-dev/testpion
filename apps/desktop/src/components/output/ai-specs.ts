import type { Proposal, ProposalFinding } from '@testpion/core';
import { jsonPretty, objectsToCsv, outputFileName, unifiedDiff } from '@testpion/shared';
import type { OutputSpec } from './output-core';

/**
 * What can be downloaded from the AI features' results (the Playground's answer, a model comparison, an analysis's
 * findings, a proposal): the answer or report as Markdown, or everything as JSON. What the model saw was masked before
 * it was sent, and the backend masks what is written again.
 */

/** A chat result as the Playground and Compare hold it. */
export interface AnswerLike {
  provider: string;
  model: string;
  text: string;
  json?: unknown;
  isJson: boolean;
  schemaValid?: boolean;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  costUsd?: number;
  timing?: { totalMs: number; firstTokenMs?: number };
  finishReason?: string;
  checks?: Array<{ name: string; passed: boolean; message?: string }>;
  renderedPrompt?: string;
  traceId?: string;
  error?: { message: string };
}

const checkLines = (checks: AnswerLike['checks']) => (checks ?? []).map((c) => `- ${c.passed ? '✓' : '✗'} ${c.name}${c.passed || !c.message ? '' : `: ${c.message}`}`).join('\n');

/** The Playground's answer: the text (Markdown, with the run's numbers below it) or the whole result. */
export function answerOutputSpec(r?: AnswerLike): OutputSpec {
  if (!r) return { id: 'ai.answers', what: 'answer', name: 'ai-answer', formats: [], empty: 'Run the prompt first' };
  return {
    id: 'ai.answers',
    what: 'answer',
    name: outputFileName({ name: `ai-answer-${r.model}`, ext: '' }),
    formats: [
      {
        key: 'md',
        format: 'md',
        label: 'Answer (Markdown)',
        default: true,
        build: () =>
          `${r.text.trimEnd()}\n\n---\n\n_${r.provider} · ${r.model}${r.timing ? ` · ${r.timing.totalMs} ms` : ''}${r.usage ? ` · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens` : ''}${r.finishReason ? ` · ${r.finishReason}` : ''}_\n${r.checks?.length ? `\n### Evaluation\n\n${checkLines(r.checks)}\n` : ''}`,
      },
      { key: 'json', format: 'json', label: 'Whole result (JSON)', build: () => jsonPretty(r) },
    ],
  };
}

/** A model comparison: one row per model (measurements and the output), as a table or a document. */
export function compareOutputSpec(results: AnswerLike[], providerName: (id: string) => string): OutputSpec {
  const rows = results.map((r) => ({
    model: `${providerName(r.provider)} · ${r.model}`,
    latencyMs: r.timing?.totalMs ?? '',
    firstTokenMs: r.timing?.firstTokenMs ?? '',
    inputTokens: r.usage?.inputTokens ?? '',
    outputTokens: r.usage?.outputTokens ?? '',
    costUsd: r.costUsd ?? '',
    validJson: r.error ? '' : r.isJson,
    schemaValid: r.schemaValid ?? '',
    checksPassed: r.checks ? `${r.checks.filter((c) => c.passed).length}/${r.checks.length}` : '',
    output: r.error ? `error: ${r.error.message}` : r.text,
  }));
  return {
    id: 'ai.compare',
    what: 'model comparison',
    name: outputFileName({ name: 'ai-model-comparison', ext: '' }),
    formats: [
      {
        key: 'md',
        format: 'md',
        label: 'Comparison (Markdown)',
        default: true,
        build: () =>
          `# Model comparison\n\nMeasurements only: there is no universal ranking.\n\n${rows
            .map(
              (r) =>
                `## ${r.model}\n\n- Latency: ${r.latencyMs} ms\n- Time to first token: ${r.firstTokenMs} ms\n- Tokens in / out: ${r.inputTokens} / ${r.outputTokens}\n- Est. cost: ${r.costUsd}\n- Valid JSON: ${r.validJson}\n- Schema valid: ${r.schemaValid}\n- Checks passed: ${r.checksPassed}\n\n\`\`\`\n${String(r.output).trimEnd()}\n\`\`\`\n`,
            )
            .join('\n')}`,
      },
      { key: 'csv', format: 'csv', label: 'Measurements (CSV)', build: () => objectsToCsv(rows) },
      { key: 'json', format: 'json', label: 'Whole results (JSON)', build: () => jsonPretty(results) },
    ],
    empty: results.length ? undefined : 'Run the comparison first',
  };
}

/** An analysis's findings (why tests failed, why a test is flaky): causes with their evidence. */
export function findingsOutputSpec(findings: ProposalFinding[], title: string): OutputSpec {
  return {
    id: 'ai.analysis',
    what: 'findings',
    name: outputFileName({ name: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), ext: '' }),
    formats: [
      {
        key: 'md',
        format: 'md',
        label: 'Findings (Markdown)',
        default: true,
        build: () =>
          `# ${title}\n\n${findings
            .map(
              (f) =>
                `## ${f.title}\n\n**${f.kind}**${f.count !== undefined ? ` · ${f.count} failure${f.count === 1 ? '' : 's'}` : ''}${typeof f.confidence === 'number' ? ` · ${Math.round(f.confidence * 100)}% sure (the model's own)` : ''}\n${f.explanation ? `\n${f.explanation}\n` : ''}${f.evidence.length ? `\n${f.evidence.map((e) => `- ${e.text}`).join('\n')}\n` : ''}`,
            )
            .join('\n')}`,
      },
      { key: 'json', format: 'json', label: 'Findings (JSON)', build: () => jsonPretty(findings) },
    ],
    empty: findings.length ? undefined : 'No findings',
  };
}

/** A security test run (AI-8): the report as Markdown, or the verdicts as JSON. Part of the API reports surface. */
export function securityOutputSpec(report: { markdown: string; verdicts: unknown[] } | undefined): OutputSpec {
  if (!report) return { id: 'api.reports', what: 'report', name: 'security-tests', formats: [], empty: 'Run the tests first' };
  return {
    id: 'api.reports',
    what: 'report',
    name: 'security-tests',
    formats: [
      { key: 'md', format: 'md', label: 'Report (Markdown)', default: true, build: () => report.markdown },
      { key: 'json', format: 'json', label: 'Verdicts (JSON)', build: () => jsonPretty(report) },
    ],
  };
}

/** A proposal under review: the document of what the model proposes, the same as JSON, or the changes as one patch. */
export function proposalOutputSpec(p: Proposal): OutputSpec {
  const patch = () =>
    p.items
      .map((i) => unifiedDiff(i.before ?? null, i.after, i.path ?? i.title))
      .filter(Boolean)
      .join('\n');
  return {
    id: 'ai.proposals',
    what: 'proposal',
    name: outputFileName({ name: `ai-proposal-${p.task}`, ext: '' }),
    formats: [
      {
        key: 'md',
        format: 'md',
        label: 'Proposal (Markdown)',
        default: true,
        build: () =>
          `# AI proposal: ${p.task}\n\n${p.provider} · ${p.model}\n${p.summary ? `\n${p.summary}\n` : ''}${(p.findings ?? []).map((f) => `\n## ${f.title}\n\n${f.explanation ?? ''}\n${f.evidence.map((e) => `- ${e.text}`).join('\n')}\n`).join('')}\n## Proposed changes\n\n${p.items
            .map((i) => `### ${i.title}\n\n${i.path ? `\`${i.path}\`\n\n` : ''}${i.verification.map((b) => `- ${b.status}: ${b.label}`).join('\n')}\n\n\`\`\`\n${i.after.trimEnd()}\n\`\`\`\n`)
            .join('\n')}`,
      },
      { key: 'json', format: 'json', label: 'Proposal (JSON)', build: () => jsonPretty(p) },
      { key: 'diff', format: 'diff', label: 'Changes as a patch', build: patch },
    ],
  };
}
