/**
 * Tool selection for a server saved in a workspace: where its cases live, writing them with the AI assistant, and
 * running them against models. One implementation for the command line (`testpion mcp --select`), the app
 * (`mcp.selection*`) and the MCP tool (`mcp_server_tools { select }`). The choosing itself is mcp-selection.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mcpSnapshotFile } from '../protocols/mcp/check.js';
import { ApsError } from '../errors.js';
import { estimateCost } from '../ai/index.js';
import { runAiTask, type AiRunDeps } from '../ai/tasks/run.js';
import type { AiSurface } from '../storage/ai-usage.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { EngineContext } from '../engine.js';
import { shortId } from '../util/ids.js';
import { parseSelectionCases, runToolSelection, selectionCasesText, vetSelectionCases, type SelectionCase, type SelectionRun } from './mcp-selection.js';

interface ServerRef {
  id: string;
  name: string;
}
interface Offered {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  instructions?: string;
}

/** The cases file of a server: `datasets/mcp-selection-<server>.jsonl`, next to the other datasets so git carries it. */
export const selectionCasesFile = (server: ServerRef): string =>
  `datasets/mcp-selection-${mcpSnapshotFile(server)
    .replace(/^mcp-snapshots\//, '')
    .replace(/\.json$/, '')}.jsonl`;

/** The cases of a server as they are on disk: the file, whether it exists and how many cases it holds. */
export function selectionCasesInfo(root: string, server: ServerRef, file?: string): { file: string; exists: boolean; cases: number } {
  const f = file ?? selectionCasesFile(server);
  const p = resolve(root, f);
  if (!existsSync(p)) return { file: f, exists: false, cases: 0 };
  try {
    return { file: f, exists: true, cases: parseSelectionCases(readFileSync(p, 'utf8')).length };
  } catch {
    return { file: f, exists: true, cases: 0 };
  }
}

export interface WrittenSelectionCases {
  file: string;
  cases: number;
  dropped: Array<SelectionCase & { why: string }>;
  uncovered: string[];
  model: string;
  usage: unknown;
  costUsd?: number;
}

/**
 * Has the AI assistant write requests a user would type, each with the tool it needs, into the cases file. A file that
 * exists is kept unless `force`: a person may have corrected it.
 */
export async function writeSelectionCases(deps: AiRunDeps, o: { root: string; server: ServerRef; offered: Offered; perTool?: number; file?: string; force?: boolean }): Promise<WrittenSelectionCases> {
  const file = o.file ?? selectionCasesFile(o.server);
  const path = resolve(o.root, file);
  if (existsSync(path) && !o.force) throw new ApsError('ConfigurationError', `${file} exists (it may hold cases you corrected)`, { suggestions: ['Pass force to write it again.'] });
  const perTool = Math.min(5, Math.max(1, Number(o.perTool) || 2));
  const r = await runAiTask(deps, {
    task: 'mcp-selection-cases',
    context: {
      tools: o.offered.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        parameters: Object.keys(((t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<string, unknown>),
      })),
      perTool,
      noneCases: Math.max(2, Math.round(o.offered.tools.length / 5)),
    },
  });
  const written = ((r.value as { cases?: SelectionCase[] } | undefined)?.cases ?? [])
    .map((c) => ({ ask: String(c.ask ?? '').trim(), tool: String(c.tool ?? '').trim() }))
    .filter((c) => c.ask && c.tool);
  const vetted = vetSelectionCases(written, o.offered.tools);
  if (!vetted.cases.length) throw new ApsError('EvaluationError', `The model (${r.provider}/${r.model}) wrote no usable case${r.problems.length ? `: ${r.problems.slice(0, 2).join('; ')}` : ''}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, selectionCasesText(vetted.cases));
  return {
    file,
    cases: vetted.cases.length,
    dropped: vetted.dropped,
    uncovered: vetted.uncovered,
    model: `${r.provider}/${r.model}`,
    usage: r.usage,
    ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
  };
}

/**
 * Offers the server's tools to each model and asks every case of the file; no tool is called. With a `store`, each
 * model's tokens and cost go to the usage ledger (task `mcp-selection`), as every other AI call of the workspace does.
 */
export async function selectServerTools(o: {
  root: string;
  server: ServerRef;
  offered: Offered;
  ctx: EngineContext;
  models: string[];
  file?: string;
  store?: WorkspaceStore;
  surface?: AiSurface;
  signal?: AbortSignal;
}): Promise<SelectionRun & { server: string; casesFile: string }> {
  const info = selectionCasesInfo(o.root, o.server, o.file);
  if (!info.exists)
    throw new ApsError('ConfigurationError', `No cases at ${info.file}`, {
      suggestions: ['Write them first (an AI task writes one request per tool; read and correct them), or give a file with one {"ask", "tool"} a line.'],
    });
  const pricing = o.ctx.services.pricing ?? [];
  const at = new Date().toISOString();
  const run = await runToolSelection(o.ctx.services.providers, {
    tools: o.offered.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown> })),
    instructions: o.offered.instructions,
    cases: parseSelectionCases(readFileSync(resolve(o.root, info.file), 'utf8')),
    models: o.models,
    signal: o.signal,
    cost: (p, model, usage) => estimateCost(pricing, p.config, model, usage).cost,
  });
  if (o.store) {
    for (const m of run.models) {
      const slash = m.model.indexOf('/');
      try {
        o.store.meta.addAiCall({
          id: shortId('aic-'),
          at,
          surface: o.surface ?? 'cli',
          task: 'mcp-selection',
          provider: slash > 0 ? m.model.slice(0, slash) : m.model,
          model: slash > 0 ? m.model.slice(slash + 1) : '',
          inputTokens: m.usage.inputTokens,
          outputTokens: m.usage.outputTokens,
          ...(m.costUsd !== undefined ? { costUsd: m.costUsd } : {}),
          ms: m.ms,
          outcome: m.errors === m.cases ? 'error' : 'ok',
          calls: m.cases - m.errors,
          ...(m.firstError && m.errors === m.cases ? { error: m.firstError } : {}),
        });
      } catch {
        /* the ledger must never fail a run */
      }
    }
  }
  return { server: o.server.name, casesFile: info.file, ...run };
}
