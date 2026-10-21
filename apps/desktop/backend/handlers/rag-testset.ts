/**
 * RPC handlers of test-set generation (AI Lab ▸ RAG ▸ Data ▸ Generate a test set): what documents the workspace has, the
 * estimate of a run, and the run itself (its proposal is reviewed in the window's one ProposalReview and applied with
 * `ai.applyProposal`). The window builds no prompt and reads no document: the engine does, the same as
 * `testpion rag generate-dataset` and the MCP tool.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { ApsError, estimateGeneration, generateTestset, listWorkspaceDatasets, TESTSET_STYLES, TESTSET_STYLE_HELP, TESTSET_TYPES, TESTSET_TYPE_HELP, type GenerateOptions } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

const DOC = /\.(md|markdown|txt|text|html?)$/i;
const SKIP = new Set(['node_modules', 'datasets', 'runs', 'payloads', 'traces', 'reports', 'baselines', 'collections', 'environments', 'tests', 'library', 'metrics', 'labels']);

/** Document-like files of the workspace (the picker's list), capped. */
function docFiles(root: string): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || out.length >= 300) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || (depth === 0 && SKIP.has(e.name))) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && DOC.test(e.name)) out.push({ path: relative(root, p).split(sep).join('/'), size: statSync(p).size });
    }
  };
  walk(root, 0);
  return out;
}

const recordsOf = (file: string, format: string): number | undefined => {
  try {
    if (format !== 'jsonl' || statSync(file).size > 8 * 1024 * 1024) return undefined;
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return undefined;
  }
};

type Params = GenerateOptions & { environment?: string; requestId?: string };

export function ragTestsetHandlers(be: Backend): Handlers {
  const clean = (p: Params): GenerateOptions => {
    // the window names workspace files and https pages only; an absolute path is the CLI's
    const { environment: _e, requestId: _r, allowAbsolute: _a, guard: _g, ...o } = p;
    return o;
  };
  return {
    /** The documents the workspace holds, its folders of them, the datasets (with their record counts) and the question types. */
    'rag.testset.sources': () => {
      const files = docFiles(be.ws.root);
      const folders = new Map<string, number>();
      for (const f of files) {
        const d = dirname(f.path);
        if (d !== '.') folders.set(d, (folders.get(d) ?? 0) + 1);
      }
      return {
        files,
        folders: [...folders].map(([path, docs]) => ({ path, docs })),
        datasets: listWorkspaceDatasets(be.ws).map((d) => ({ path: d.path, name: d.path.replace(/^datasets\//, ''), format: d.format, size: d.size, modified: d.modified, records: recordsOf(be.ws.safePath(d.path), d.format) })),
        types: TESTSET_TYPES.map((id) => ({ id, help: TESTSET_TYPE_HELP[id] })),
        styles: TESTSET_STYLES.map((id) => ({ id, help: TESTSET_STYLE_HELP[id] })),
      };
    },
    /** Reads and chunks the documents and returns the shared estimate (calls, tokens, cost range, the caps it would break); nothing is sent. */
    'rag.testset.estimate': async (p: Params) => {
      const ctx = be.context({ environment: p.environment });
      try {
        if (!ctx.services.ragJudge) throw new ApsError('ConfigurationError', 'No judge host');
        return { estimate: await estimateGeneration(be.ws, ctx.services.ragJudge, clean(p)) };
      } finally {
        await ctx.dispose();
      }
    },
    /** Writes the questions (one model call per eight), verifies every sample and returns ONE proposal to review. */
    'rag.testset.generate': ({ requestId, environment, ...rest }: Params) =>
      be.withAiDeps({ environment, requestId }, async (deps) => {
        const progress = be.batched<{ id?: string; done: number; of: number; text: string }>('rag.testset.progress', 0);
        try {
          const r = await generateTestset(deps, be.ws, clean(rest), (done, of, text) => (progress.push({ id: requestId, done, of, text }), progress.flush()));
          return { proposal: r.proposal, tally: r.tally, corpus: r.corpus, calls: r.calls, costUsd: r.costUsd, usage: r.usage };
        } finally {
          progress.flush();
        }
      }),
  };
}
