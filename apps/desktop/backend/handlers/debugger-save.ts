/**
 * Writing the Debugger's session to disk (handlers/debugger.ts): the AutoSave, Save session, Stop and quitting.
 *
 * Nothing here builds or writes the whole HAR in one go on the main thread: the document is made a few exchanges at a time and
 * written as it is made (core debugger/har-file.ts). The AutoSave file is not the user's to share, so it lives in the app's data
 * folder (never in the workspace, which git tracks), and its values are masked by shape as well as by name (strictHarRedactor).
 */
import { ENGINE_VERSION, copyOwned, strictHarRedactor, writeHarFile, removeOwned, renameOwned } from '@testpion/core';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from '../backend.js';
import type { DebuggerState } from './debugger-state.js';

/** The reserved session name of the AutoSave file. */
export const AUTOSAVE = 'autosave';

export function sessionSaver(be: Backend, state: DebuggerState) {
  const debuggerDir = () => join(be.host.appDir, 'debugger');
  const autosaveFile = () => join(debuggerDir(), `${AUTOSAVE}.har`);
  let inflight: Promise<void> | undefined;

  /** Write the live session to the AutoSave file now, if something changed (one write at a time; changes while it runs make it dirty again). */
  const autosaveNow = (): Promise<void> => {
    if (inflight) return inflight;
    if (!state.dirty || !state.exchanges.length) return Promise.resolve();
    state.dirty = false;
    inflight = (async () => {
      try {
        await writeHarFile(autosaveFile(), state.exchanges, strictHarRedactor(be.logger.redactor), ENGINE_VERSION);
      } catch (e) {
        state.dirty = true;
        be.logger.warn(`Debugger autosave failed: ${(e as Error).message}`);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  return {
    autosaveFile,
    autosaveNow,
    /** Wait for the write in flight, then write what changed since (a few rounds at most): what quitting and stopping rely on. */
    async flush(): Promise<void> {
      for (let i = 0; i < 3; i++) {
        if (inflight) await inflight;
        if (!(state.dirty && state.exchanges.length)) return;
        await autosaveNow();
      }
    },
    /** A session the user asked to save, under their redaction settings. */
    async save(file: string): Promise<void> {
      await writeHarFile(file, state.exchanges, be.logger.redactor, ENGINE_VERSION);
    },
    /**
     * Earlier versions kept the AutoSave in the workspace's debugger/ folder (git-tracked folder, decrypted traffic): it moves
     * to the app's data folder, or goes when a newer one is there already. Temporary files a crash left are removed.
     */
    tidy(sessionsDirOf: () => string): void {
      try {
        let workspaceSessionsDir: string | undefined;
        try {
          workspaceSessionsDir = sessionsDirOf();
        } catch {
          /* no workspace is open yet: only the app's own folder */
        }
        const legacy = workspaceSessionsDir ? join(workspaceSessionsDir, `${AUTOSAVE}.har`) : undefined;
        if (legacy && existsSync(legacy)) {
          if (existsSync(autosaveFile())) removeOwned(legacy);
          else {
            try {
              renameOwned(legacy, autosaveFile());
            } catch {
              copyOwned(legacy, autosaveFile()); // another drive
              removeOwned(legacy);
            }
          }
        }
        for (const d of [workspaceSessionsDir, debuggerDir()])
          if (d && existsSync(d))
            for (const f of readdirSync(d)) if (/^autosave\.har\.tmp/i.test(f) && !(inflight && d === debuggerDir())) rmSync(join(d, f), { force: true });
      } catch (e) {
        be.logger.warn(`Debugger autosave tidy-up failed: ${(e as Error).message}`);
      }
    },
  };
}
