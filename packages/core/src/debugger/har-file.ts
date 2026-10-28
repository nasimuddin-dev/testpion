import { atomicWriteChunks, PRIVATE_FILE_MODE } from '../storage/fsutil.js';
import { harPieces, type HarRedactor } from './har.js';
import type { DebuggerExchange } from './proxy.js';

/**
 * Write a captured session as a HAR file without holding up the thread: the document is made a few exchanges at a time
 * (each slice of work at most `sliceMs`, then the event loop serves what waits), written to a temporary file as it is made,
 * and renamed over the target when complete, so a crash or a full disk never leaves half a session. Private to the user.
 * The exchanges are taken as they are when the call starts (the session may go on growing while this runs).
 */
export async function writeHarFile(file: string, exchanges: DebuggerExchange[], redactor: HarRedactor, version = '1', o: { sliceMs?: number; pause?: () => Promise<void> } = {}): Promise<void> {
  await atomicWriteChunks(file, harPieces(exchanges.slice(), redactor, version, o), { mode: PRIVATE_FILE_MODE });
}
