import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { call, on } from '../api';

/**
 * The answer of one RPC call, made when the component mounts and again when the params change or one of the
 * `reloadOn` events arrives. `undefined` until the first answer; `fallback` when the call fails. The params
 * are compared by value (JSON), so an inline object is fine. A reload keeps what is shown until the new answer
 * comes; a change of params starts over (`undefined`, or the old answer with `keep`). `enabled: false` makes
 * no call and answers `undefined`.
 */
export function useRpc<T>(method: string, params?: unknown, opts: { fallback?: T; reloadOn?: string[]; enabled?: boolean; keep?: boolean } = {}): T | undefined {
  const [data, setData] = useState<T>();
  const key = JSON.stringify(params ?? null);
  const enabled = opts.enabled ?? true;
  const events = (opts.reloadOn ?? []).join('\0');
  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      return;
    }
    if (!opts.keep) setData(undefined);
    let live = true;
    const load = () =>
      void call<T>(method, params).then(
        (r) => live && setData(r),
        () => live && setData(opts.fallback),
      );
    load();
    const offs = events ? events.split('\0').map((ch) => on(ch, load)) : [];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, key, enabled, events]);
  return data;
}

/**
 * The last `max` events of a channel, oldest first, after the ones the backend kept (`initial`: the method that
 * lists them). The setter clears or replaces the list (Clear buttons).
 */
export function useEventLog<T>(channel: string, max: number, initial?: string): [T[], Dispatch<SetStateAction<T[]>>] {
  const [list, setList] = useState<T[]>([]);
  useEffect(() => {
    if (initial) void call<T[]>(initial).then(setList, () => undefined);
    return on<T>(channel, (e) => setList((l) => [...l.slice(1 - max), e]));
  }, [channel, max, initial]);
  return [list, setList];
}
