/**
 * Capturing a RAG dataset from real traffic (planning/rag-testing.md §4b "Capture from traffic"): the shapes the sources
 * (History, Debugger sessions, HAR files, evaluation runs) are read into, the options and the report.
 */

/** One call of the system under test, as a source read it: only what the capture needs (never headers or cookies). */
export interface CapturedCall {
  /** Where it came from: `history` entry, `debugger` session (HAR in debugger/), `har` file, `run` result, `messages` (a WebSocket message log). */
  source: 'history' | 'debugger' | 'har' | 'run' | 'messages';
  /** The protocol of the call (default http). A gRPC or MCP call in History has its request but no response; a WebSocket call is one sent message and the replies that followed it. */
  protocol?: 'http' | 'grpc' | 'mcp' | 'websocket';
  /** gRPC: the method (`rag.Rag/Ask`); MCP: the tool. */
  operation?: string;
  /** The call succeeded (set by the reader for the protocols that have no HTTP status); default: a 2xx status. */
  ok?: boolean;
  /** The entry / exchange / result id (with the session or run it belongs to for the last three). */
  id: string;
  at?: string;
  method?: string;
  /** The URL as it was called (resolved). */
  url?: string;
  /** The request body text. */
  requestBody?: string;
  requestContentType?: string;
  status?: number;
  /** The response body text (an event stream as its raw text). */
  responseText?: string;
  responseHeaders?: Array<[string, string]>;
  latencyMs?: number;
  /** A run result: the sample was already read (question, answer, contexts); no request to match. */
  sample?: { question: string; answer: string; contexts: Array<{ id: string; text: string; score?: number; source?: string }>; reference?: string; referenceIds?: string[] };
}

/** Where the question sits in a target's request. */
export interface QuestionLocator {
  where: 'body-json' | 'body-text' | 'query' | 'url';
  /** body-json: the keys down to the field; query: the parameter name. */
  path?: string[];
  /** The text around the placeholder (`Answer briefly: {{question}}`); the question is what stands in the placeholder. */
  template: string;
  /** How the question was written into it: plain, as a JSON string literal, or escaped for inside one. */
  encoding: 'plain' | 'json' | 'escaped';
}

export type CaptureSourceSpec =
  | { kind: 'history'; ids?: string[]; limit?: number }
  | { kind: 'debugger'; session: string }
  | { kind: 'har'; file: string }
  | { kind: 'run'; run: string }
  /** The message log of a WebSocket session saved from the message log's down arrow (JSON Lines: time, direction, data); `url` is the socket's address when the target's must match it. */
  | { kind: 'messages'; file: string; url?: string }
  /** Calls handed over by a host that already holds them (the Debugger's live exchanges). */
  | { kind: 'calls'; calls: CapturedCall[] };

export interface CaptureOptions {
  /** A RAG target (id or name): its request says where the question is, its mapping reads the answer and contexts. */
  target?: string;
  source: CaptureSourceSpec;
  /** `datasets/<name>.jsonl`. */
  name?: string;
  /** Overrides the question's place: a JSONPath into the JSON request body (`$.input.q`) or `query:<param>`. */
  questionPath?: string;
  /** Keep the newest or the first of calls with the same question (default newest). */
  dedupe?: boolean | 'newest' | 'first';
  /** At most this many records (after dedupe, in time order). */
  limit?: number;
  /** A seeded random sample of this many records. */
  sample?: number;
  seed?: string | number;
  since?: string;
  until?: string;
  /** Only calls that answered 2xx (default on). */
  onlySuccess?: boolean;
  /** Personal data (emails, phones, card and ID numbers) is masked; secrets and tokens always are. Default on. */
  maskPii?: boolean;
  /** Write question-only records (the target is called anew) instead of the captured answers and contexts. */
  asQuestions?: boolean;
  /** Replace a dataset file that exists. */
  overwrite?: boolean;
  /** Build everything, write nothing. */
  dryRun?: boolean;
}

export interface CapturedRecord {
  id: string;
  question: string;
  answer?: string;
  contexts?: Array<{ id: string; text: string; score?: number; source?: string }>;
  reference?: string;
  reference_ids?: string[];
  tags: string[];
  metadata: { capturedFrom: { kind: string; id: string }; at?: string; latencyMs?: number };
}

export interface CaptureReport {
  read: number;
  matched: number;
  /** Calls not used, by reason. */
  skipped: Array<{ reason: string; count: number; examples: string[] }>;
  /** How many strings had something masked, and what. */
  masked: { strings: number; kinds: Record<string, number> };
  deduped: number;
  sampled: number;
  /** Records in the result. */
  records: number;
  /** Where the question was read from. */
  questionAt?: string;
  warnings: string[];
}

export interface CaptureResult {
  report: CaptureReport;
  /** The first records (all when written). */
  preview: CapturedRecord[];
  /** `datasets/<name>.jsonl` when written. */
  written?: { path: string; rows: number };
}
