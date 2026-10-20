/**
 * RAG R4 (planning/rag-testing.md §4b, §4d, R4; ai-features.md AI-11): test-set generation from documents, capture of a
 * dataset from real traffic, judge calibration against human labels, and AI evaluation authoring. One barrel so the
 * package index names the whole step once.
 */
export * from './calibrate/index.js';
export * from './capture/index.js';
export * from './testset/index.js';
export * from './author/index.js';
