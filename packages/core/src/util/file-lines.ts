import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * The lines of a text file, streamed. Leaving the loop early (a `break`, a thrown error) closes the file at once: a bare `readline` over a
 * read stream can keep the descriptor open until it is garbage collected, which adds up when a trend or a matrix reads many results files.
 */
export async function* fileLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, 'utf8');
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    input.destroy();
  }
}
