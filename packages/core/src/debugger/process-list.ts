/**
 * The process picker (FG-16): the running programs that hold network connections, so one can be chosen as "Capture only".
 * A program is named as the Application column names it ("chrome", not "chrome.exe"). The system is asked for a snapshot
 * (netstat + tasklist on Windows, lsof elsewhere); the parsers are pure.
 */
import { execFileChecked } from '../net/process.js';

export interface RunningProgram {
  /** As the Application column and the rules name it. */
  name: string;
  pids: number[];
  /** Established TCP connections right now. */
  connections: number;
}

/** `netstat -ano -p tcp`: the number of established connections per process id. */
export function parseNetstat(out: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const m of out.matchAll(/^\s*TCP\s+\S+\s+\S+\s+ESTABLISHED\s+(\d+)\s*$/gm)) {
    const pid = Number(m[1]);
    if (pid > 0) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  return counts;
}

/** `tasklist /FO CSV /NH`: process id to name (no .exe). */
export function parseTasklist(out: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const m of out.matchAll(/^"([^"]+)","(\d+)"/gm)) names.set(Number(m[2]), m[1]!.replace(/\.exe$/i, ''));
  return names;
}

/** `lsof -nP -iTCP -sTCP:ESTABLISHED -Fpc`: a `p` line starts a process, its `c` line names it, every `f` line is one connection. */
export function parseLsof(out: string): Array<{ pid: number; name: string; connections: number }> {
  const found: Array<{ pid: number; name: string; connections: number }> = [];
  let cur: { pid: number; name: string; connections: number } | undefined;
  for (const line of out.split(/\r?\n/)) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === 'p') found.push((cur = { pid: Number(rest), name: '', connections: 0 }));
    else if (tag === 'c' && cur) cur.name = rest;
    else if (tag === 'f' && cur) cur.connections++;
  }
  return found.filter((p) => p.pid > 0 && p.name);
}

/** Programs by name with their process ids and connections, the busiest first. */
export function groupPrograms(rows: ReadonlyArray<{ pid: number; name: string; connections: number }>): RunningProgram[] {
  const by = new Map<string, RunningProgram>();
  for (const r of rows) {
    const g = by.get(r.name) ?? { name: r.name, pids: [], connections: 0 };
    g.pids.push(r.pid);
    g.connections += r.connections;
    by.set(r.name, g);
  }
  return [...by.values()].sort((a, b) => b.connections - a.connections || a.name.localeCompare(b.name));
}

const text = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFileChecked(`program ${file}`, file, args, { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out))));

/** The running programs with connections right now (empty when the system will not say). */
export async function listRunningPrograms(): Promise<RunningProgram[]> {
  if (process.platform === 'win32') {
    const [net, tasks] = await Promise.all([text('netstat', ['-ano', '-p', 'tcp']), text('tasklist', ['/FO', 'CSV', '/NH'])]);
    const names = parseTasklist(tasks);
    return groupPrograms([...parseNetstat(net)].flatMap(([pid, connections]) => (names.get(pid) ? [{ pid, name: names.get(pid)!, connections }] : [])));
  }
  return groupPrograms(parseLsof(await text('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpcf'])));
}
