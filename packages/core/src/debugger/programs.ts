import { execFile } from 'node:child_process';

/** A program found behind a client port. */
export interface ProgramInfo {
  name: string;
  pid?: number;
  /** The account the program runs as (DOMAIN\\user on Windows). */
  user?: string;
}

const SPAWN = { timeout: 5000, windowsHide: true };

/**
 * Which program owns a TCP connection, by its local port. Programs come and go faster than a process listing takes,
 * so a burst of connections shares one snapshot: on Windows one `netstat` (every connection's owner) and one `tasklist`
 * (every process's name) run side by side and answer all the lookups of the next 250 ms; a port the snapshot does not
 * know yet waits for the next one. On other platforms `lsof` answers per port.
 */
export function applicationOfPort(port: number): Promise<ProgramInfo | undefined> {
  if (process.platform !== 'win32') return lsofPort(port);
  return windowsSnapshot().then(async (s) => {
    let pid = s.owners.get(port);
    if (!pid && Date.now() - s.at > 50) pid = (await windowsSnapshot(true)).owners.get(port);
    if (!pid) return undefined;
    const name = (await windowsSnapshot()).names.get(pid);
    return name ? { name, pid } : undefined;
  });
}

interface WindowsSnapshot {
  at: number;
  /** local port → owning PID (established connections first; PID 0, a closed connection, is nobody) */
  owners: Map<number, number>;
  /** PID → process name as Get-Process names it ("chrome", "node") */
  names: Map<number, string>;
}
let snapshot: WindowsSnapshot | undefined;
let snapshotPending: Promise<WindowsSnapshot> | undefined;

function windowsSnapshot(fresh = false): Promise<WindowsSnapshot> {
  if (!fresh && snapshot && Date.now() - snapshot.at < 250) return Promise.resolve(snapshot);
  if (snapshotPending) return snapshotPending;
  snapshotPending = Promise.all([
    spawnText('netstat', ['-ano', '-p', 'tcp']).then((out) => {
      const owners = new Map<number, number>();
      for (const m of out.matchAll(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+(\S+)\s+(\d+)\s*$/gm)) {
        const local = Number(m[1]);
        const pid = Number(m[3]);
        if (pid > 0 && (m[2] === 'ESTABLISHED' || !owners.has(local))) owners.set(local, pid);
      }
      return owners;
    }),
    spawnText('tasklist', ['/FO', 'CSV', '/NH']).then((out) => {
      const names = new Map<number, string>();
      for (const m of out.matchAll(/^"([^"]+)","(\d+)"/gm)) names.set(Number(m[2]), m[1]!.replace(/\.exe$/i, ''));
      return names;
    }),
  ])
    .then(([owners, names]) => (snapshot = { at: Date.now(), owners, names }))
    .finally(() => (snapshotPending = undefined));
  return snapshotPending;
}

function lsofPort(port: number): Promise<ProgramInfo | undefined> {
  return spawnText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpc']).then((out) => {
    const name = /^c(.+)$/m.exec(out)?.[1]?.trim();
    const pid = Number(/^p(\d+)$/m.exec(out)?.[1]) || undefined;
    return name ? { name, pid } : undefined;
  });
}

/** The account a process runs as (DOMAIN\\user on Windows, from CIM: Get-Process -IncludeUserName needs an elevated shell). */
export function ownerOfProcess(pid: number): Promise<string | undefined> {
  const id = Math.trunc(pid);
  const cmd =
    process.platform === 'win32'
      ? [
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$o = Get-CimInstance Win32_Process -Filter "ProcessId=${id}" -ErrorAction SilentlyContinue | Invoke-CimMethod -MethodName GetOwner -ErrorAction SilentlyContinue; if ($o.User) { if ($o.Domain) { "$($o.Domain)\\$($o.User)" } else { $o.User } }`,
          ],
        ]
      : ['ps', ['-o', 'user=', '-p', String(id)]];
  return spawnText(cmd[0] as string, cmd[1] as string[], 8000).then((out) => out.trim() || undefined);
}

/** A command's stdout, or '' when it fails (a lookup that cannot be made answers "unknown"). */
function spawnText(file: string, args: string[], timeout = SPAWN.timeout): Promise<string> {
  return new Promise((resolve) => execFile(file, args, { ...SPAWN, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out))));
}
