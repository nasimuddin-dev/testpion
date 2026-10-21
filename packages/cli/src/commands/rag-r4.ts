/**
 * The `testpion rag` commands of RAG R4, each family in its own module: `generate-dataset` (test sets from documents),
 * `capture` (a dataset from real traffic), `draft-references` (AI-drafted reference answers for it), `label` and `calibrate` (judge calibration), `author`, and `trend`.
 */
import type { Command } from 'commander';
import { registerRagAuthorCommands } from './rag-author.js';
import { registerRagCalibrateCommands } from './rag-calibrate.js';
import { registerRagCaptureCommands } from './rag-capture.js';
import { registerRagReferencesCommands } from './rag-references.js';
import { registerRagTestsetCommands } from './rag-testset.js';
import { registerRagTrendCommands } from './rag-trend.js';

export function registerRagR4Commands(rag: Command): void {
  registerRagTestsetCommands(rag);
  registerRagCaptureCommands(rag);
  registerRagReferencesCommands(rag);
  registerRagCalibrateCommands(rag);
  registerRagAuthorCommands(rag);
  registerRagTrendCommands(rag);
}
