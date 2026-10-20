/**
 * MCP tools for RAG testing (the same engine functions as `testpion rag …`): the RAG targets of the workspace, a probe of
 * one (a real question to the system under test and the sample its mapping reads), and the conversion of Ragas and
 * DeepEval datasets. A RAG evaluation runs with `run_evaluation`; its judged metrics need a judge (the evaluation's, or
 * the AI settings' large model) and fail with a setup hint without one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RagTarget } from '@testpion/shared';
import { datasetFormatOfName } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { createEngineContext } from '../engine.js';
import { exportRagRecords, importRagRecords, parseRagDatasetText, RAG_DATASET_FORMATS, stringifyRagRecords, type RagDatasetFormat } from '../eval/rag/dataset-formats.js';
import { findRagTarget, listRagTargets } from '../eval/rag/targets.js';
import type { AppSettings } from '../model/types.js';
import { probeRagTarget } from '../runner/rag-probe.js';
import type { SecretStore } from '../storage/secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { str, type Tool } from './tool.js';

const FORMATS = [...RAG_DATASET_FORMATS];

/** A dataset's text: given, or a file of the workspace. */
function datasetText(store: WorkspaceStore, a: Record<string, unknown>): { text: string; format: ReturnType<typeof datasetFormatOfName> } {
  if (typeof a.text === 'string' && a.text.trim()) return { text: a.text, format: datasetFormatOfName(String(a.format ?? '')) ?? (a.text.trim().startsWith('[') ? 'json' : 'jsonl') };
  const rel = String(a.path ?? '');
  if (!rel) throw new ApsError('ValidationError', 'Give `path` (a file of the workspace, e.g. datasets/ragas.jsonl) or `text`');
  return { text: readFileSync(store.safePath(rel), 'utf8'), format: datasetFormatOfName(rel) };
}

/** Where `save_as` writes: datasets/<name>.jsonl, never over a file that is there. */
function saveDataset(store: WorkspaceStore, name: string, body: string): string {
  const base = basename(name.trim()).replace(/\.jsonl$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 100);
  if (!base) throw new ApsError('ValidationError', '`save_as` must be a file name');
  const dir = store.path('datasets');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${base}.jsonl`);
  if (existsSync(file)) throw new ApsError('ValidationError', `datasets/${base}.jsonl exists already: choose another name`);
  writeFileSync(file, body);
  return `datasets/${base}.jsonl`;
}

export function ragTools({ store, secrets, settings, checkEnvironment }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [
    {
      name: 'rag_list_targets',
      description:
        'The RAG targets of the workspace (AI Lab ▸ RAG): a RAG system under test — one request of any protocol (HTTP, SSE stream, WebSocket, gRPC, MCP tool) and the mapping that reads the answer and the retrieved contexts out of its response. Returns id, name, protocol, the mapping in a line and the problems that stop it from being called. A saved evaluation of type rag uses one by name.',
      inputSchema: { type: 'object', properties: {} },
      run: () => listRagTargets(store),
    },
    {
      name: 'rag_probe',
      write: true,
      description:
        'Call a RAG target once with a question (a real request to the system under test, with the environment\'s variables) and return what its mapping reads: the answer, the retrieved contexts (id, text, score, source), usage and latency, plus the response the mapping reads (an SSE stream as { events }, a WebSocket as { received }). Use it to check a target works before running an evaluation.',
      inputSchema: { type: 'object', properties: { target: str('A target name or id (rag_list_targets)'), question: str('The question to ask'), environment: str('Environment name') }, required: ['target', 'question'] },
      run: async (a) => {
        const found = findRagTarget(store, String(a.target ?? ''));
        const { id: _id, name: _name, ...target } = found;
        const ctx = createEngineContext({ store, secrets, settings, environment: checkEnvironment(a.environment), aiSurface: 'mcp' });
        try {
          const p = await probeRagTarget(ctx, target as RagTarget, String(a.question ?? ''));
          return { target: found.name, ...p, response: { ...p.response, text: p.response.text.slice(0, 4000) } };
        } finally {
          await ctx.dispose();
        }
      },
    },
    {
      name: 'rag_import_dataset',
      description:
        'Convert a Ragas or DeepEval dataset (JSON, JSONL or CSV, as `path` in the workspace or as `text`) into TestPion RAG records: question, reference, reference_contexts, reference_ids, tags. Only data is read. Returns the format found, up to `limit` records and notes on what was left out; `save_as` writes them to datasets/<name>.jsonl (never over an existing file).',
      write: true,
      inputSchema: {
        type: 'object',
        properties: { path: str('A file of the workspace'), text: str('The dataset text instead of a file'), format: str('With text: json, jsonl or csv'), from: { type: 'string', enum: FORMATS, description: 'The format of the data (default: found by its columns)' }, save_as: str('Write the records to datasets/<save_as>.jsonl'), limit: { type: 'number', description: 'Records to return (default 20)' } },
      },
      run: (a) => {
        const { text, format } = datasetText(store, a);
        const r = importRagRecords(parseRagDatasetText(text, format ?? 'jsonl'), a.from ? (String(a.from) as RagDatasetFormat) : undefined);
        const saved = a.save_as ? saveDataset(store, String(a.save_as), stringifyRagRecords(r.records)) : undefined;
        return { from: r.from, count: r.records.length, notes: r.notes, ...(saved ? { saved } : {}), records: r.records.slice(0, Math.min(Number(a.limit) || 20, 500)) };
      },
    },
    {
      name: 'rag_export_dataset',
      description: 'Convert a TestPion RAG dataset (a file of the workspace, or the text) into Ragas (user_input, reference, reference_contexts, response, retrieved_contexts …) or DeepEval (input, expected_output, context, actual_output, retrieval_context …) records, to score the same questions with those tools. Returns up to `limit` records.',
      inputSchema: { type: 'object', properties: { path: str('A file of the workspace'), text: str('The dataset text instead of a file'), format: str('With text: json, jsonl or csv'), to: { type: 'string', enum: ['ragas', 'deepeval'] }, limit: { type: 'number', description: 'Records to return (default 20)' } }, required: ['to'] },
      run: (a) => {
        const { text, format } = datasetText(store, a);
        const to = String(a.to) as RagDatasetFormat;
        if (to !== 'ragas' && to !== 'deepeval') throw new ApsError('ValidationError', '`to` is ragas or deepeval');
        const out = exportRagRecords(importRagRecords(parseRagDatasetText(text, format ?? 'jsonl')).records, to);
        return { to, count: out.length, records: out.slice(0, Math.min(Number(a.limit) || 20, 500)) };
      },
    },
  ];
}
