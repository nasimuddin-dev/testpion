import { formatUsd, plural } from '@testpion/shared';
import type { AiTaskResult, Proposal } from '@testpion/core';
import { bold, cyan, dim, green, red, yellow } from '../shared.js';

const badge = (s: string) => (s === 'pass' ? green('✓') : s === 'fail' ? red('✗') : s === 'warn' ? yellow('!') : dim('–'));

/** A proposal for people: its items, each with its verification, and how to apply it. */
export function printProposal(p: Proposal, o: { applied?: boolean; findings?: boolean } = {}): void {
  console.log(bold(`\nProposal ${p.id}`) + dim(` · ${p.items.length} item${p.items.length === 1 ? '' : 's'} · ${p.provider}/${p.model} · ${p.taskVersion === 0 ? 'made without AI' : 'AI-generated'}, review before applying`));
  if (p.summary && p.task !== 'design-flow') console.log(`  ${p.summary.split('\n')[0]}`);
  // an analysis: what it found, with the evidence (triage causes, why a test is flaky)
  for (const f of o.findings === false ? [] : (p.findings ?? [])) {
    console.log(`  ${bold(f.title)} ${dim(`· ${f.kind}${f.count !== undefined ? ` · ${plural(f.count, 'failure')}` : ''}${typeof f.confidence === 'number' ? ` · ${Math.round(f.confidence * 100)}% sure` : ''}`)}`);
    if (f.explanation) console.log(`    ${f.explanation.split('\n')[0]}`);
    for (const e of f.evidence.slice(0, 5)) console.log(dim(`    - ${e.text}`));
  }
  for (const a of p.assumptions) console.log(dim(`  assumed: ${a}`));
  for (const n of p.notes ?? []) console.log(yellow(`  note: ${n}`));
  for (const i of p.items) {
    // the path once: an item titled by its file (a flow, a test file) does not repeat it
    const where = i.path && !i.title.includes(i.path) ? dim(`  ${i.kind === 'spec' ? i.path : `tests/${i.path}`}`) : '';
    console.log(`  ${i.selected ? '[x]' : '[ ]'} ${i.id}  ${i.title}${where}`);
    for (const b of i.verification) console.log(`        ${badge(b.status)} ${b.label}${b.detail ? dim(` — ${b.detail.split('\n')[0]}`) : ''}`);
  }
  if (p.problems?.length) console.log(yellow(`  Still wrong after the repairs: ${p.problems.slice(0, 3).join('; ')}`));
  // applied already (--apply): how to undo it follows, not how to apply it
  if (o.applied) return;
  console.log(
    dim(
      `\nApply: testpion ai apply ${p.id}${p.items.some((i) => !i.selected) ? ` (the ticked items; --items ${p.items.map((i) => i.id).join(',')} to choose)` : ''} · discard: testpion ai discard ${p.id}`,
    ),
  );
}

export function printPreview(r: AiTaskResult): void {
  const p = r.preview;
  console.log(bold(`What will be sent — ${p.title}`));
  console.log(`  model     ${p.providerName} / ${p.model} (${p.tier} task, from ${p.modelSource})${p.local ? green(' · stays on this computer') : ''}`);
  console.log(`  privacy   ${p.privacy}`);
  console.log(
    `  estimate  ≈ ${p.estimate.inputTokens.toLocaleString('en-US')} tokens in, up to ${p.estimate.maxOutputTokens.toLocaleString('en-US')} out${p.estimate.priceKnown ? ` · up to ${formatUsd(p.estimate.maxCostUsd)}` : dim(' · no price for this model (Settings ▸ Model pricing)')}`,
  );
  for (const s of p.context.sections) console.log(dim(`  section   ${s.name}: ${s.tokens} tokens${s.notes.length ? ` (${s.notes.join('; ')})` : ''}`));
  if (p.redactionCount) console.log(dim(`  masked    ${p.redactionCount}: ${[...new Set(p.redactions.map((x) => x.kind))].join(', ')}`));
  for (const m of p.messages ?? []) console.log(`\n${cyan(`── ${m.role}`)}\n${m.content}`);
  console.log(dim('\nNothing was sent (--dry-run).'));
}
