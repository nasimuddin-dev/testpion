import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectionSavedItems, collectionToAsyncApi, collectionToHttpFile, type Collection } from '@testpion/core';
import { yellow, findWorkspaceUp, withWorkspace } from '../shared.js';

/** `testpion export` formats written as one text file: .http (REST Client, JetBrains) and AsyncAPI (the connections). */
export async function exportTextFormat(format: string, c: Collection, o: { workspace?: string; out?: string }): Promise<boolean> {
  let text: string;
  let notes: string[];
  if (format === 'http') ({ text, notes } = collectionToHttpFile(c));
  else if (format === 'asyncapi') {
    // the connections live beside the collection in its workspace
    const ws = o.workspace ?? findWorkspaceUp(process.cwd());
    const items: Parameters<typeof collectionToAsyncApi>[1] = ws ? await withWorkspace(ws, (store) => collectionSavedItems(store, c.id)?.websocket ?? []) : [];
    ({ text, notes } = collectionToAsyncApi(c, items));
  } else return false;
  for (const n of notes) console.error(yellow(`not exported: ${n}`));
  if (o.out) writeFileSync(resolve(o.out), text);
  else process.stdout.write(text);
  return true;
}
