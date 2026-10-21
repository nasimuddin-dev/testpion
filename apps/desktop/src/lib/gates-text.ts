// The gates of a RAG evaluation as a person writes them: `metric=minimum`, comma separated (the same words as `testpion rag run --min`).

/** `faithfulness=0.8, recall@5=0.9` as the gates of an evaluation; a text that is not that gives undefined (the field says so). */
export function parseGatesText(text: string): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const part of text.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*[=:]\s*(-?\d+(?:\.\d+)?)$/.exec(part);
    if (!m) return undefined;
    out[m[1]!] = Number(m[2]);
  }
  return out;
}

export const gatesText = (g: Record<string, number> | undefined): string =>
  Object.entries(g ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
