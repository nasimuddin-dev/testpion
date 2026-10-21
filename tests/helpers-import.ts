import { importDocument, legacyResult, type ImportAnyResult, type ImportScriptsMode } from '../packages/core/src/index.js';

/**
 * Any supported document read into the older import result ({ format, collection, environment, notes … }): what the CLI
 * reads (`readImport`), kept here for the many import tests that assert on that shape. The engine's own entry points are
 * `importDocument` (document and report).
 */
export function importAny(text: string, opts: { name?: string; scripts?: ImportScriptsMode; takenIds?: Iterable<string>; liftTests?: boolean } = {}): ImportAnyResult {
  return legacyResult(importDocument(text, opts).document);
}
