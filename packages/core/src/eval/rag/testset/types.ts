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

/** Ways a person words a question; a style changes the wording only, never the facts or the expected answer. */
export const TESTSET_STYLES = ['formal', 'casual', 'terse', 'verbose', 'typos', 'non-native'] as const;
export const TESTSET_STYLE_HELP: Record<(typeof TESTSET_STYLES)[number], string> = {
  formal: 'Polite, complete sentences.',
  casual: 'Chatty, contractions, slang.',
  terse: 'A few keywords, no grammar (a search-box query).',
  verbose: 'A long question with background before it.',
  typos: 'Misspellings and missing punctuation, as typed in a hurry.',
  'non-native': 'Simple words and slightly wrong grammar, as a second-language speaker writes.',
};
/** Most personas or styles one run takes, and the longest text of one. */
export const MAX_VOICES = 8;
export const MAX_VOICE_CHARS = 120;

/** How a repeated question is found: by the words they share, or by what they mean (an embedding model, with the words as the fallback). */
export const DEDUPE_MODES = ['lexical', 'embedding'] as const;
export type DedupeMode = (typeof DEDUPE_MODES)[number];

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
  /** Who asks: each question is written as one of these people would ask it, in turn (`a nurse on night shift`). */
  personas?: string[];
  /** How they word it, in turn (`terse`, `typos` … or any short description). */
  styles?: string[];
  /** How repeated questions are found (default lexical). */
  dedupe?: DedupeMode;
  /** The embedding model of `dedupe: embedding`, as provider/model (default: the provider of the judge or of the AI settings). */
  embedder?: string;
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
  metadata: { generator: { task: string; version: number; model?: string; seed: string; batch: number; type: TestsetType; persona?: string; style?: string } };
}

export interface RawSample {
  type: TestsetType;
  question: string;
  reference?: string;
  chunks?: string[];
  answerable?: boolean;
  note?: string;
}
