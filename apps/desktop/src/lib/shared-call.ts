import { call, on } from '../api';

/**
 * Identical reads asked for while one is on its way share it (UI audit 2026-10-21, F-33: as the window opened, Home,
 * the explorer and the monitor alerts each asked for the certificates, the collections' health and the saved gRPC calls
 * and connections). Nothing is kept once the answer came, and a read asked for after the workspace changed
 * (`data.changed`, `workspace.changedOnDisk`) never joins one that started before the change: it gets its own answer.
 */
let epoch = 0;
const bump = () => void epoch++;
on('data.changed', bump);
on('workspace.changedOnDisk', bump);

const inFlight = new Map<string, { epoch: number; answer: Promise<unknown> }>();

export function sharedCall<T>(method: string, params?: unknown): Promise<T> {
  const key = `${method} ${JSON.stringify(params ?? null)}`;
  const on = inFlight.get(key);
  if (on && on.epoch === epoch) return on.answer as Promise<T>;
  const entry = { epoch, answer: call<T>(method, params) };
  inFlight.set(key, entry);
  const done = () => void (inFlight.get(key) === entry && inFlight.delete(key));
  entry.answer.then(done, done);
  return entry.answer as Promise<T>;
}
