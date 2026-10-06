/** CSV as the runner's datasets and the app's tables read it: quoted fields, doubled quotes, line breaks inside quotes. */

export function csvRecords(text: string, delim = ','): string[][] {
  const out: string[][] = [];
  let pending = '';
  for (const l of text.split(/\r?\n/)) {
    pending = pending ? `${pending}\n${l}` : l;
    if ((pending.match(/"/g)?.length ?? 0) % 2 === 1) continue;
    if (pending.trim()) out.push(parseCsvLine(pending, delim));
    pending = '';
  }
  if (pending.trim()) out.push(parseCsvLine(pending, delim));
  return out;
}

export function parseCsvLine(line: string, delim = ','): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
