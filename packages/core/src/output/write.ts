/**
 * Writing an output into a file, the one way: to `<name>.part` beside it and renamed when complete, so a cancel or a
 * failure leaves no half file. The window's Save as…, `testpion output --out` and MCP `save_output` all write here.
 */
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { ApsError } from '../errors.js';
import type { Chunks } from './types.js';

/**
 * Where a save is written before it is renamed onto `dest`: `<name>.part` beside it, or a short hidden name in the same
 * folder when `<name>.part` would pass the 255-byte name limit of macOS / Linux (a name typed in the dialog may be that
 * long). Same folder, so the rename never crosses a volume.
 */
export function partPathFor(dest: string): string {
  const name = basename(dest);
  if (Buffer.byteLength(`${name}.part`) <= 255) return `${dest}.part`;
  return join(dirname(dest), `.testpion-${process.pid}-${Date.now().toString(36)}.part`);
}

/** A file-system failure of a save as a message a person can act on (the folder, not a stack). */
function writeError(e: unknown, dest: string): unknown {
  const code = (e as { code?: string })?.code;
  const where = dirname(dest);
  const name = basename(dest);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return new ApsError('ConfigurationError', `Cannot write ${name}: permission denied in ${where}`, {
      suggestions: ['Choose another folder, or close the program that has the file open.'],
    });
  if (code === 'EBUSY') return new ApsError('ConfigurationError', `Cannot replace ${name}: it is open in another program`, { suggestions: ['Close it there, or save under another name.'] });
  if (code === 'ENOSPC' || code === 'EDQUOT')
    return new ApsError('ConfigurationError', `Not enough disk space to save ${name} in ${where}`, { suggestions: ['Free some space, or choose another drive.'] });
  if (code === 'ENAMETOOLONG') return new ApsError('ValidationError', `The file name or path is too long: ${name}`, { suggestions: ['Choose a shorter name or folder.'] });
  if (code === 'ENOENT' || code === 'ENOTDIR') return new ApsError('ConfigurationError', `The folder ${where} is no longer there`, { suggestions: ['Choose another folder.'] });
  return e;
}

/**
 * Write `chunks` to `dest` (through `<name>.part`); `onBytes` hears each chunk's size (progress). Aborting `signal`
 * stops it with a CancelledError and removes the part.
 */
export async function writeChunks(chunks: Chunks, dest: string, o: { signal?: AbortSignal; onBytes?: (n: number) => void } = {}): Promise<void> {
  const part = partPathFor(dest);
  const out = createWriteStream(part);
  const failed = new Promise<never>((_, reject) => out.on('error', reject));
  failed.catch(() => undefined);
  try {
    for await (const c of chunks) {
      if (o.signal?.aborted) break;
      const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
      o.onBytes?.(buf.length);
      if (!out.write(buf)) await Promise.race([once(out, 'drain'), failed]);
    }
    out.end();
    await Promise.race([once(out, 'close'), failed]);
    if (o.signal?.aborted) throw new ApsError('CancelledError', 'Saving was cancelled');
    renameSync(part, dest);
  } catch (e) {
    out.destroy();
    // closed before it is removed: an open handle can keep the name (or fail the removal) on some file systems
    if (!out.closed) await once(out, 'close').catch(() => undefined);
    try {
      rmSync(part, { force: true });
    } catch {
      // a .part that cannot be removed (the folder became read-only) must not hide why the save failed
    }
    throw writeError(e, dest);
  }
}
