/** Test-set generation from documents (planning/rag-testing.md §4b). */
export { TESTSET_TYPES, TESTSET_TYPE_HELP, TESTSET_STYLES, TESTSET_STYLE_HELP, DEDUPE_MODES, type DedupeMode, MAX_VOICES as TESTSET_MAX_VOICES, BATCH_SAMPLES, MAX_COUNT as TESTSET_MAX_COUNT, type TestsetType, type TestsetOptions, type TestsetRecord, type Chunk as TestsetChunk, type Corpus as TestsetCorpus } from './types.js';
export { chunkDocument, chunkCorpus, CHUNK_TOKENS } from './chunk.js';
export { loadDocuments, loadCorpus, htmlToText } from './documents.js';
export { fetchDocument, checkDocumentUrl, MAX_DOC_BYTES, MAX_URLS, type GuardDeps } from './url-guard.js';
export { bm25 as bm25Rank, jaccard as termJaccard, coverage as termCoverage, copiedShare, contentTerms } from './lexical.js';
export { planBatch, askOrder } from './sample.js';
export { REFERENCE_SUPPORT, TESTSET_INSTRUCTION, TESTSET_VERSION } from './prompts.js';
export { rememberCorpus, corpusOf, corpusToken } from './corpus-cache.js';
export { verifySupport, verifyAnswerable, verifyDuplicate, meaningBadge } from './verify.js';
export { embedderFor, closestQuestion, EMBED_DUPLICATE_AT, EMBED_WARN_AT } from './dedupe.js';
export { estimateTestset } from './estimate.js';
export { datasetPathOf, parseTypes as parseTestsetTypes, parseVoices as parseTestsetVoices, type TestsetLocal } from './task.js';
export { applyDatasetRowItem, undoDatasetRows } from './apply.js';
