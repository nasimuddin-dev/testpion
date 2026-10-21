/**
 * MCP tool of the capture of a RAG dataset from real traffic (`rag_capture_dataset`, the same engine function as
 * `testpion rag capture`). Nothing is sent to a model; secrets and personal data are masked before a dataset is written.
 */
import { withEngine } from './server-kit.js';
import { captureDataset, type CaptureSourceSpec } from '../../eval/rag/capture/index.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';
import { ApsError } from '../../errors.js';

const strList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined);

function sourceOf(a: Record<string, unknown>): CaptureSourceSpec {
  const from = String(a.from ?? (a.session ? 'debugger' : a.run ? 'run' : a.har ? 'har' : a.messages ? 'messages' : 'history'));
  if (from === 'messages') {
    if (!a.messages) throw new ApsError('ValidationError', '`messages` is a WebSocket message log (JSON Lines) inside the workspace');
    return { kind: 'messages', file: String(a.messages), ...(a.messages_url ? { url: String(a.messages_url) } : {}) };
  }
  if (from === 'debugger') {
    if (!a.session) throw new ApsError('ValidationError', '`session` is a saved Debugger session or the History id that saved it');
    return { kind: 'debugger', session: String(a.session) };
  }
  if (from === 'run') {
    if (!a.run) throw new ApsError('ValidationError', '`run` is an evaluation run id');
    return { kind: 'run', run: String(a.run) };
  }
  if (from === 'har') {
    if (!a.har) throw new ApsError('ValidationError', '`har` is a HAR file inside the workspace');
    return { kind: 'har', file: String(a.har) };
  }
  return { kind: 'history', ...(Array.isArray(a.history) && a.history.length ? { ids: a.history.map(String) } : {}) };
}

export function ragCaptureTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings; checkEnvironment(name: unknown): string | undefined }): Tool[] {
  return [
    {
      name: 'rag_capture_dataset',
      write: true,
      doc: { when: 'Turning real calls to a RAG system (History, a saved Debugger session, a HAR file, a WebSocket message log, an evaluation run) into a dataset, to score production-like questions.', whenNot: 'Generating questions from documents (rag_generate_testset) or converting another tool’s dataset (rag_import_dataset).', example: { target: 'clinic-rag', from: 'history', name: 'prod-questions', dedupe: true, dry_run: true } },
      description:
        'Build a RAG dataset from real calls. The question is read from each request where the RAG target writes it ({{question}} in its request), the answer and the retrieved contexts from the response with the target’s mapping. Records get tags captured + the source and the call they came from; secrets are always masked and personal data (emails, phones, card and ID numbers) unless mask_pii is false; the request headers and cookies are never kept. `dry_run` returns the report (read, matched, skipped with reasons, masked, deduped, sampled) and the first records and writes nothing; otherwise datasets/<name>.jsonl is written (never over a file unless overwrite). `as_questions` writes questions only, so the target is called again when the dataset runs. A gRPC or MCP target is read from History, which keeps the request but not the response, so its dataset holds the questions; a WebSocket target is read from a saved message log (`messages`). Nothing is sent to a model.',
      inputSchema: {
        type: 'object',
        properties: {
          target: str('The RAG target the calls went to (rag_list_targets); not needed for from=run'),
          from: { type: 'string', enum: ['history', 'debugger', 'run', 'har', 'messages'], description: 'Where the calls are (default: found from session / run / har / messages, else history)' },
          history: strList('History entry ids (default: the recent HTTP entries)'),
          session: str('A saved Debugger session (debugger/<name>.har) or the id of the History entry that saved it'),
          run: str('An evaluation run id: its answered samples become records'),
          har: str('A HAR file inside the workspace'),
          messages: str('A WebSocket message log inside the workspace (JSON Lines saved from the message log: time, direction, data): each sent message and the replies after it are a call'),
          messages_url: str('With messages: the socket\'s address, when the target\'s must match it'),
          question_path: str('Where the question is when the target does not say: a JSONPath into the JSON request body ($.input.q) or query:<parameter>'),
          name: str('datasets/<name>.jsonl (default captured-<date>)'),
          limit: { type: 'number', description: 'At most this many records (the newest)' },
          sample: { type: 'number', description: 'A random sample of this many records (same every time with the same seed)' },
          seed: str('The seed of sample'),
          dedupe: { type: 'boolean', description: 'One record per question' },
          keep: { type: 'string', enum: ['newest', 'first'], description: 'With dedupe: which call stays (default newest)' },
          since: str('Only calls from this ISO time on'),
          until: str('Only calls up to this ISO time'),
          include_failed: { type: 'boolean', description: 'Also calls that did not answer 2xx' },
          mask_pii: { type: 'boolean', description: 'Mask personal data (default true; secrets and tokens are always masked)' },
          as_questions: { type: 'boolean', description: 'Write questions only' },
          overwrite: { type: 'boolean', description: 'Replace a dataset file that exists' },
          dry_run: { type: 'boolean', description: 'Report and preview only; write nothing' },
        },
      },
      run: async (a) => {
        return withEngine({ store, secrets, settings }, { aiSurface: 'mcp' }, async (ctx) => {
          return await captureDataset(
            store,
            {
              target: a.target ? String(a.target) : undefined,
              source: sourceOf(a),
              name: a.name ? String(a.name) : undefined,
              questionPath: a.question_path ? String(a.question_path) : undefined,
              dedupe: a.dedupe ? (a.keep === 'first' ? 'first' : 'newest') : false,
              limit: int(a.limit),
              sample: int(a.sample),
              seed: a.seed === undefined ? undefined : String(a.seed),
              since: a.since ? String(a.since) : undefined,
              until: a.until ? String(a.until) : undefined,
              onlySuccess: a.include_failed !== true,
              maskPii: a.mask_pii !== false,
              asQuestions: a.as_questions === true,
              overwrite: a.overwrite === true,
              dryRun: a.dry_run === true,
            },
            { redactor: ctx.redactor },
          );
        });
      },
    },
  ];
}
