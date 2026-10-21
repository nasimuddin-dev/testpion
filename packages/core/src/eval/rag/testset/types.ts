/** Shared shapes of test-set generation (planning/rag-testing.md §4b). */

export const TESTSET_TYPES = ['single-hop', 'multi-hop', 'abstract', 'unanswerable', 'adversarial'] as const;
export type TestsetType = (typeof TESTSET_TYPES)[number];

export const TESTSET_TYPE_HELP: Record<TestsetType, string> = {
  'single-hop': 'A specific question one passage answers.',
  'multi-hop': 'A question that needs two passages together.',
  abstract: 'A broader question about a theme, answered from a passage.',
  unanswerable: 'Sounds on topic, but the documents do not hold the answer (the system should say it does not know).',
  adversarial: 'The same question with a typo, a paraphrase or a twist; same expected answer.',
};

/** Most samples one model call asks for, and most one run produces. */
export const BATCH_SAMPLES = 8;
export const MAX_COUNT = 60;

export interface Chunk {
  /** `<docSlug>#<n>`: n is the chunk's order in its document, so the id does not change when other documents change. */
  id: string;
  doc: string;
  heading: string[];
  text: string;
  tokens: number;
  /** First 8 hex of the sha256 of the normalised text: tells whether a chunk's content changed. */
  hash: string;
}

export interface SourceDoc {
  /** Where it came from: a workspace path, an absolute path (CLI) or an https URL. */
  name: string;
  kind: 'file' | 'url';
  text: string;
  format: 'markdown' | 'text';
}

export interface Corpus {
  docs: Array<{ name: string; slug: string; chunks: number }>;
  chunks: Chunk[];
  /** Why a document was left out, one line each. */
  skipped: string[];
}

export interface TestsetOptions {
  /** Workspace-relative files or folders (the CLI also takes absolute paths). */
  paths?: string[];
  urls?: string[];
  count: number;
  types?: TestsetType[];
  /** Seed of the chunk selection (same seed, same documents, same chunks asked about). */
  seed?: string;
  /** datasets/<name>.jsonl the accepted rows are added to. */
  name?: string;
}

/** The record written to a dataset (dataset-formats.ts, canonical TestPion record). */
export interface TestsetRecord {
  id: string;
  question: string;
  reference: string;
  reference_ids: string[];
  reference_contexts: string[];
  answerable: boolean;
  tags: string[];
  metadata: { generator: { task: string; version: number; model?: string; seed: string; batch: number; type: TestsetType } };
}

export interface RawSample {
  type: TestsetType;
  question: string;
  reference?: string;
  chunks?: string[];
  answerable?: boolean;
  note?: string;
}
