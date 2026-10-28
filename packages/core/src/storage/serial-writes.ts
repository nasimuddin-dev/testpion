/**
 * One queue per target file. The asynchronous savers (`atomicWriteAsync` waits and retries on a busy file with timers) may overlap
 * when two saves of the same file are in flight; on Windows the first one's rename then fails with EBUSY, the second lands at once,
 * and the first's retry would put the OLDER bytes over the newer ones. A write started later never starts before the earlier one
 * for the same file has finished (or failed); writes to different files do not wait for each other. The failure of one write is
 * its caller's, never the next write's.
 */
import { atomicWriteAsync, writeJsonAsync } from './fsutil.js';

export class WriteQueue {
  /** The last write of each file still in flight (an entry leaves when its write is the last one and has settled). */
  private readonly tails = new Map<string, Promise<unknown>>(); // bounded: the files with a write in flight, each removed when it settles

  run<T>(key: string, write: () => Promise<T>): Promise<T> {
    const k = process.platform === 'win32' ? key.toLowerCase() : key;
    const run = (this.tails.get(k) ?? Promise.resolve()).then(write, write);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(k, tail);
    void tail.then(() => {
      if (this.tails.get(k) === tail) this.tails.delete(k);
    });
    return run;
  }

  /** `atomicWriteAsync` in the file's queue. */
  atomic(path: string, data: string | Buffer): Promise<void> {
    return this.run(path, () => atomicWriteAsync(path, data));
  }

  /** `writeJsonAsync` in the file's queue; the value is written as it is NOW, whatever the caller does to it while an earlier write retries. */
  json(path: string, value: unknown): Promise<void> {
    const snapshot = structuredClone(value);
    return this.run(path, () => writeJsonAsync(path, snapshot));
  }

  get pending(): number {
    return this.tails.size;
  }
}
