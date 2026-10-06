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

/** The same without the sub-millisecond case (reports and the CLI). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${((ms % 60_000) / 1000).toFixed(0)}s`;
}
