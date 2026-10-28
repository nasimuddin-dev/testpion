import { Transform, type TransformCallback } from 'node:stream';

/**
 * Network speed (FG-1): the Debugger's global "Network speed" switch. While one is on, every request and response the proxy
 * forwards is paced to the speed's bandwidth and every request waits one round trip's latency. Only the exchanges that go
 * through the proxy as HTTP are paced (an opaque HTTPS tunnel and a WebSocket's frames are not); nothing is paced while it is off.
 */
export interface NetworkSpeed {
  /** The preset's id, or `custom`. */
  preset: string;
  /** Kilobits per second the program downloads at (the response), and uploads at (the request body). */
  downKbps: number;
  upKbps: number;
  /** Added once to every request before it is sent on. */
  latencyMs: number;
}

/** The ready-made speeds (the numbers browsers' throttling menus use, where they have one). */
export const NETWORK_SPEEDS: Array<NetworkSpeed & { label: string }> = [
  { preset: 'modem', label: 'Modem (56 kbit/s)', downKbps: 56, upKbps: 33, latencyMs: 150 },
  { preset: 'edge', label: 'Edge (240 kbit/s)', downKbps: 240, upKbps: 200, latencyMs: 300 },
  { preset: 'slow-3g', label: 'Slow 3G (400 kbit/s)', downKbps: 400, upKbps: 400, latencyMs: 400 },
  { preset: '3g', label: '3G (1.6 Mbit/s)', downKbps: 1600, upKbps: 750, latencyMs: 300 },
  { preset: 'slow-4g', label: 'Slow 4G (4 Mbit/s)', downKbps: 4000, upKbps: 3000, latencyMs: 100 },
];

export const MAX_KBPS = 10_000_000;
export const MAX_LATENCY_MS = 30_000;

/**
 * A speed from a preset id (`3g`), or from numbers (`custom`): kilobits per second, down and up, and the latency in ms.
 * `off` / undefined is no speed. Throws an Error that says what is valid.
 */
export function parseNetworkSpeed(input: { preset?: string; downKbps?: number; upKbps?: number; latencyMs?: number } | string | undefined): NetworkSpeed | undefined {
  const o = typeof input === 'string' ? { preset: input } : (input ?? {});
  const id = (o.preset ?? '').trim().toLowerCase();
  if (!id && o.downKbps === undefined) return undefined;
  if (id === 'off' || id === 'none') return undefined;
  if (id && id !== 'custom') {
    const hit = NETWORK_SPEEDS.find((s) => s.preset === id);
    if (!hit) throw new Error(`No network speed "${id}": off, ${NETWORK_SPEEDS.map((s) => s.preset).join(', ')}, or custom with downKbps / upKbps / latencyMs`);
    return { preset: hit.preset, downKbps: hit.downKbps, upKbps: hit.upKbps, latencyMs: hit.latencyMs };
  }
  const down = Number(o.downKbps);
  const up = o.upKbps === undefined ? down : Number(o.upKbps);
  const latency = Number(o.latencyMs ?? 0);
  if (!Number.isFinite(down) || down < 1 || down > MAX_KBPS) throw new Error(`The download speed is 1 to ${MAX_KBPS} kbit/s`);
  if (!Number.isFinite(up) || up < 1 || up > MAX_KBPS) throw new Error(`The upload speed is 1 to ${MAX_KBPS} kbit/s`);
  if (!Number.isFinite(latency) || latency < 0 || latency > MAX_LATENCY_MS) throw new Error(`The latency is 0 to ${MAX_LATENCY_MS} ms`);
  return { preset: 'custom', downKbps: Math.round(down), upKbps: Math.round(up), latencyMs: Math.round(latency) };
}

/** One line for the status bar and the CLI: "3G: 1600 down / 750 up kbit/s, 300 ms". */
export function describeNetworkSpeed(s: NetworkSpeed | undefined): string {
  if (!s) return 'Off (full speed)';
  const name = NETWORK_SPEEDS.find((x) => x.preset === s.preset)?.label.replace(/ \(.*\)$/, '') ?? 'Custom';
  return `${name}: ${s.downKbps} down / ${s.upKbps} up kbit/s, ${s.latencyMs} ms`;
}

interface PacerOptions {
  /** Test seams: the clock (ms) and the wait. */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Lets bytes through at `kbps` kilobits per second: a chunk is cut into pieces of about 50 ms of traffic, each released when
 * the bytes before it have had time to pass. The first piece goes at once. Memory is the chunk being paced, nothing more.
 */
export class Pacer extends Transform {
  private readonly bytesPerMs: number;
  private readonly slice: number;
  private next = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private release: (() => void) | undefined;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(kbps: number, o: PacerOptions = {}) {
    super();
    this.bytesPerMs = (Math.max(1, kbps) * 125) / 1000;
    this.slice = Math.max(128, Math.floor(this.bytesPerMs * 50));
    this.now = o.now ?? Date.now;
    this.wait =
      o.wait ??
      ((ms) =>
        new Promise<void>((resolve) => {
          this.release = resolve;
          this.timer = setTimeout(resolve, ms);
        }));
  }

  _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    void this.pace(buf).then(
      () => cb(),
      (err: Error) => cb(err),
    );
  }

  private async pace(buf: Buffer): Promise<void> {
    for (let at = 0; at < buf.length; at += this.slice) {
      if (this.destroyed) return;
      const piece = buf.subarray(at, at + this.slice);
      const t = this.now();
      if (this.next > t) await this.wait(this.next - t);
      if (this.destroyed) return;
      this.push(piece);
      this.next = Math.max(this.next, this.now()) + piece.length / this.bytesPerMs;
    }
  }

  _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.release?.();
    cb(err);
  }
}

/** Bytes as a stream paced to `kbps`: a request body to send on, or a response to write to the client. */
export function pacedBody(body: Buffer | NodeJS.ReadableStream, kbps: number): Pacer {
  const p = new Pacer(kbps);
  if (Buffer.isBuffer(body)) p.end(body);
  else body.pipe(p);
  return p;
}

/** Sleeps for the speed's latency. */
export const latencyOf = (s: NetworkSpeed | undefined): number => s?.latencyMs ?? 0;
