/**
 * The command palette's filter and ranking (every palette: Ctrl+K, Quick Open, the flow designer's block picker, the
 * quick pickers). A row matches when each typed word is in its label, hint, detail or group; rows are then ranked by
 * how well the label matches — the label itself, then a label starting with what is typed, then every word at the
 * start of a word of the label, then inside the label, then only in the hint / detail / group — and keep their own
 * order within a rank (the lists are already in a meaningful order: groups, recency, the search's ranking).
 */
export interface RankedRow {
  label: string;
  hint?: string;
  detail?: string;
  group?: string;
}

/** How well a row matches the typed words (0 best), or undefined when it does not match. */
export function paletteScore(row: RankedRow, text: string): number | undefined {
  const q = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return 0;
  const words = q.split(' ');
  const label = row.label.toLowerCase();
  const other = [row.hint, row.detail, row.group].filter(Boolean).join('\n').toLowerCase();
  if (!words.every((w) => label.includes(w) || other.includes(w))) return undefined;
  if (label.trim() === q) return 0;
  if (label.startsWith(q)) return 1;
  // the start of a word: after the beginning, a space or a punctuation mark ("Log" in "Log in", "set" in "Set variable")
  const atWordStart = (w: string) => {
    for (let i = label.indexOf(w); i >= 0; i = label.indexOf(w, i + 1)) if (i === 0 || /[^\p{L}\p{N}]/u.test(label[i - 1]!)) return true;
    return false;
  };
  if (words.every(atWordStart)) return 2;
  if (words.every((w) => label.includes(w))) return 3;
  return 4;
}

/** The rows that match `text`, best first (stable within a rank). */
export function rankPalette<T extends RankedRow>(rows: T[], text: string): T[] {
  const scored: Array<[T, number, number]> = [];
  rows.forEach((r, i) => {
    const s = paletteScore(r, text);
    if (s !== undefined) scored.push([r, s, i]);
  });
  return scored.sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([r]) => r);
}
