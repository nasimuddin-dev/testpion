/**
 * What a bundle is, without a workspace: its title and maker, the items by kind, what it needs and what to look at
 * before running it. `testpion bundle inspect`, the MCP tool `describe_bundle` and the app's file picker use it.
 */
import type { BundleKindId, ParsedBundle } from './format.js';
import { adapter } from './registry.js';

export interface BundleDescription {
  title: string;
  source: ParsedBundle['source'];
  formatVersion: number;
  createdBy: { app: string; version: string };
  createdAt: string;
  counts: Partial<Record<BundleKindId, number>>;
  items: Array<{ kind: BundleKindId; id: string; name: string; size?: number; mode?: string }>;
  requires: ParsedBundle['manifest']['requires'];
  flags: ParsedBundle['manifest']['flags'];
  review: string[];
  missing: ParsedBundle['manifest']['missing'];
  notes: string[];
  warnings: string[];
  /** One sentence a person (or an agent) can read first. */
  summary: string;
}

export function describeBundle(bundle: ParsedBundle): BundleDescription {
  const m = bundle.manifest;
  const counts: BundleDescription['counts'] = {};
  const review = new Set<string>();
  for (const i of m.items) {
    counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    const data = i.entry ? bundle.entries.get(i.entry) : undefined;
    if (data) for (const r of adapter(i.kind).review(i, data)) review.add(r);
  }
  for (const p of m.flags.production) review.add(`Environment "${p}" is marked production: data-changing requests to it ask first`);
  const parts = (Object.entries(counts) as Array<[BundleKindId, number]>).map(([k, n]) => `${n} ${adapter(k).label}${n === 1 ? '' : 's'}`);
  const secrets = m.requires.secrets.length;
  return {
    title: m.title,
    source: bundle.source,
    formatVersion: m.formatVersion,
    createdBy: m.createdBy,
    createdAt: m.createdAt,
    counts,
    items: m.items.map((i) => ({ kind: i.kind, id: i.id, name: i.name, ...(i.size !== undefined ? { size: i.size } : {}), ...(i.mode === 'reference' ? { mode: 'reference' } : {}) })),
    requires: m.requires,
    flags: m.flags,
    review: [...review].slice(0, 100),
    missing: m.missing,
    notes: m.notes,
    warnings: bundle.warnings,
    summary: `"${m.title}": ${parts.join(', ') || 'nothing'}${secrets ? `; ${secrets} secret${secrets === 1 ? '' : 's'} to fill in` : ''}${review.size ? `; ${review.size} thing${review.size === 1 ? '' : 's'} to review before running` : ''}.`,
  };
}
