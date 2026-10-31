/** Numbers for people: sizes and durations, the same in the app, reports and the CLI. */

export function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** A duration in ms: "0.42 ms", "17 ms", "1.20 s", "2m 5s"; "–" when unknown. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '–';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * An amount of US dollars for people, the same in the app, the CLI and reports: cents from $1 up ("$2.00"), more
 * digits below it where a call's cost lives ("$0.0123", "$0.00015"), "$0" for nothing, "–" when unknown.
 */
export function formatUsd(c: number | undefined | null): string {
  if (c === undefined || c === null || !Number.isFinite(c)) return '–';
  if (c === 0) return '$0';
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  if (a >= 1) return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (a < 0.000001) return `${sign}<$0.000001`;
  // at most 4 decimals from a cent up, 6 below; trailing zeros dropped, but never fewer than cents
  const s = a.toFixed(a >= 0.01 ? 4 : 6).replace(/0+$/, '');
  const [, dec = ''] = s.split('.');
  return `${sign}$${dec.length < 2 ? a.toFixed(2) : s}`;
}

/** "1 call", "3 calls" (an irregular plural can be passed: plural(n, 'entry', 'entries')). */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
}

/** The same without the sub-millisecond case (reports and the CLI). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${((ms % 60_000) / 1000).toFixed(0)}s`;
}

/** The longest note a workspace can carry for its team (shown on Home to everyone who opens it). */
export const WORKSPACE_NOTE_LIMIT = 1500;
