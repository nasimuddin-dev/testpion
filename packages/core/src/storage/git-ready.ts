import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './fsutil.js';
import { isInGitRepository, writeGitFiles, type GitReadyResult } from './git-files.js';
export { GITATTRIBUTES_LINES, GITIGNORE_LINES, attributesText, ignoreText, installPreCommitHook, isInGitRepository, preCommitScript, shellQuote, writeGitFiles, type GitReadyResult } from './git-files.js';
import { collectionFileContent, type WorkspaceStore } from './workspace.js';
import type { Collection } from '../model/types.js';

/**
 * A workspace ready for git (GIT-102): a `.gitignore` that keeps results and this computer's state out of the
 * repository, a `.gitattributes` that keeps line endings the same on every OS, and collection files in their
 * git-friendly form (no save counter / time, keys in a fixed order). See planning/git-integration.md.
 */

/** Make an existing workspace git-ready; safe to run again (it only adds what is missing). */
export function makeGitReady(store: WorkspaceStore): GitReadyResult {
  const files = writeGitFiles(store.root);
  const collections: string[] = [];
  const dir = store.path('collections');
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    let raw: Collection;
    try {
      raw = readJson<Collection>(join(dir, f));
    } catch {
      continue; // a broken file is left for the user to fix
    }
    const tidy = JSON.stringify(collectionFileContent(raw), null, 2) + '\n';
    if (readFileSync(join(dir, f), 'utf8') === tidy) continue;
    // saving moves version / updatedAt to the local meta file and writes the tidy form
    store.saveCollection(store.getCollection(raw.id));
    collections.push(`collections/${f}`);
  }
  return { files, collections, inRepository: isInGitRepository(store.root) };
}
