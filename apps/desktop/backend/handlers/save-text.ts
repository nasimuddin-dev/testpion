import { writeFileSync } from 'node:fs';
import type { Backend } from '../backend.js';

/**
 * Save a text file for the user through the one save path (`Backend.saveOrDownload`): written where the native dialog says,
 * or returned for the window to download when the host has no dialog. Resolves to `{ path }`, `{ download }`, or `{}` when
 * the dialog was cancelled, so a cancelled save never downloads anyway.
 */
export const saveText = (be: Backend, name: string, filters: Array<{ name: string; extensions: string[] }>, text: string, type: string) =>
  be.saveOrDownload(name, filters, (dest) => writeFileSync(dest, text), () => Buffer.from(text), { type });
