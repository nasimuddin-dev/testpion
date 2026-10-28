/**
 * The account each program runs as, asked in batches. A shell loop of `curl` is a new process for every request; asking
 * the system about each one is a PowerShell (300-500 ms of CPU) per request. Here the processes asked about in a short
 * window go in one query (`Get-CimInstance Win32_Process` for all of them), the queries run one at a time, and an answer is
 * kept for a few seconds by process id (with the start time the system gave, for a caller that wants to tell a reused id apart).
 */

/** What one process was found to be: its account and when it started (to tell a reused id from the old process). */
export interface OwnerAnswer {
  user?: string;
  startedAt?: string;
}

export interface OwnerBatcherOptions {
  /** One system query for these process ids; ids it does not know are left out of the answer. */
  query(pids: number[]): Promise<Map<number, OwnerAnswer>>;
  /** How long the first id waits for others to join it. */
  windowMs?: number;
  /** The most ids in one query. */
  maxBatch?: number;
  /** How long an answer is kept. */
  keepMs?: number;
  /** Clock and timer, replaceable in tests. */
  now?(): number;
}

/** A function that answers "who owns this process", batching what is asked within `windowMs` into one query. */
export function createOwnerBatcher(opts: OwnerBatcherOptions): (pid: number) => Promise<string | undefined> {
  const windowMs = opts.windowMs ?? 250;
  const maxBatch = opts.maxBatch ?? 200;
  const keepMs = opts.keepMs ?? 10_000;
  const now = opts.now ?? Date.now;
  // bounded: pending ids are drained by every batch; answers are dropped after keepMs and the map never passes 2,000
  const answers = new Map<number, { at: number; answer: OwnerAnswer }>();
  const waiting = new Map<number, Array<(u: string | undefined) => void>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const remember = (pid: number, answer: OwnerAnswer) => {
    answers.delete(pid);
    answers.set(pid, { at: now(), answer });
    if (answers.size > 2000) for (const k of answers.keys()) if (answers.size > 1500) answers.delete(k);
  };

  const run = async () => {
    running = true;
    try {
      while (waiting.size) {
        const batch = [...waiting.keys()].slice(0, maxBatch);
        const callbacks = batch.map((pid) => [pid, waiting.get(pid)!] as const);
        for (const pid of batch) waiting.delete(pid);
        let found = new Map<number, OwnerAnswer>();
        try {
          found = await opts.query(batch);
        } catch {
          /* a lookup that cannot be made answers "unknown" */
        }
        for (const [pid, cbs] of callbacks) {
          const a = found.get(pid);
          if (a) remember(pid, a);
          for (const cb of cbs) cb(a?.user);
        }
      }
    } finally {
      running = false;
    }
  };

  const schedule = () => {
    if (timer || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run().then(() => waiting.size && schedule());
    }, windowMs);
    timer.unref?.();
  };

  return (pid: number) => {
    const kept = answers.get(pid);
    if (kept && now() - kept.at < keepMs) return Promise.resolve(kept.answer.user);
    return new Promise<string | undefined>((resolve) => {
      const list = waiting.get(pid);
      if (list) list.push(resolve);
      else waiting.set(pid, [resolve]);
      schedule();
    });
  };
}

/** The Windows query: one PowerShell for every id, a line `pid<TAB>account<TAB>start` for each. */
export function windowsOwnerCommand(pids: number[]): [string, string[]] {
  const ids = pids.map((p) => Math.trunc(p)).filter((p) => Number.isFinite(p) && p > 0);
  const filter = ids.map((id) => `ProcessId=${id}`).join(' OR ');
  const script =
    `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `$o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue; ` +
    `$u = if ($o.User) { if ($o.Domain) { "$($o.Domain)\\$($o.User)" } else { $o.User } } else { '' }; ` +
    `"$($_.ProcessId)\`t$u\`t$($_.CreationDate.ToString('o'))" }`;
  return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', script]];
}

/** The other platforms' query: `ps` for all the ids at once. */
export function psOwnerCommand(pids: number[]): [string, string[]] {
  return ['ps', ['-o', 'pid=,user=', '-p', pids.map((p) => Math.trunc(p)).join(',')]];
}

/** Reads the output of either query. */
export function parseOwners(out: string): Map<number, OwnerAnswer> {
  const found = new Map<number, OwnerAnswer>();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const user = parts[1]?.trim();
    if (user) found.set(pid, { user, startedAt: parts[2]?.trim() || undefined });
  }
  return found;
}
