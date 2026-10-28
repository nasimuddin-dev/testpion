import { ApsError } from '../../errors.js';
import { executeHttp } from '../../protocols/http/client.js';
import { cleanReplayOptions, isReplayLocalHost, replayMany, requestOfExchange } from '../../debugger/replay.js';
import { listRunningPrograms } from '../../debugger/process-list.js';
import type { DebuggerExchange } from '../../debugger/proxy.js';
import type { HttpRequestSpec } from '../../model/types.js';
import type { Redactor } from '../../util/redact.js';
import type { Tool } from '../tool.js';
import { str } from '../tool.js';

/**
 * Replay many (FG-2) and the running-program list (FG-16) for agents. The sends are real requests: more than one to a host
 * that is not on this computer needs `confirm_remote: true`, and 200 sends is the most.
 */
export function debuggerReplayTools(d: { session: DebuggerExchange[]; redactor: Redactor; readOnly?: boolean }): Tool[] {
  return [
    {
      name: 'debugger_replay',
      write: true,
      description:
        'Send captured requests again: `times` sends in all (1 to 200), `concurrency` at once (1 to 20), `delay_ms` between sends in a lane, optionally `stop_on_failure`. Several ids are sent in the order given and round again. Returns the status counts, the fastest / middle / slowest time and each send. More than one send to a host that is not on this computer needs `confirm_remote: true`.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'The exchange ids (from debugger_exchanges), sent in this order' },
          times: { type: 'number', description: 'How many sends in all (default: one per id)' },
          concurrency: { type: 'number', description: 'How many at once (default 1)' },
          delay_ms: { type: 'number', description: 'Wait between the start of one send and the next in a lane' },
          stop_on_failure: { type: 'boolean', description: 'Stop starting sends after the first error or status of 400 and up' },
          confirm_remote: { type: 'boolean', description: 'Allow several sends to a host that is not on this computer' },
        },
        required: ['ids'],
      },
      run: async (a) => {
        if (d.readOnly) throw new ApsError('ValidationError', 'This server is read-only: it cannot send requests');
        const ids = Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : [];
        const picked = ids.map((id) => {
          const e = d.session.find((x) => x.id === id);
          if (!e) throw new ApsError('ValidationError', `No exchange ${id} in the session`);
          return e;
        });
        const real = picked.filter((e) => e.kind !== 'tunnel');
        if (!real.length) throw new ApsError('ValidationError', 'Give the ids of requests (an HTTPS tunnel is not a request)');
        const opts = cleanReplayOptions({ count: a.times === undefined ? real.length : Number(a.times), concurrency: Number(a.concurrency), delayMs: Number(a.delay_ms), stopOnFailure: a.stop_on_failure === true });
        const remote = [...new Set(real.filter((e) => !isReplayLocalHost(e.host)).map((e) => e.host))];
        if (opts.count > 1 && remote.length && a.confirm_remote !== true) throw new ApsError('ValidationError', `This sends ${opts.count} requests to ${remote.join(', ')}, which is not on this computer. Pass confirm_remote: true if the server is yours or you have permission.`);
        const summary = await replayMany(opts, async (i) => {
          const e = real[i % real.length]!;
          const started = Date.now();
          try {
            const { response } = await executeHttp(requestOfExchange(e) as HttpRequestSpec, { redactor: d.redactor, maxPreviewBytes: 1024 });
            return { status: response.status, ms: response.durationMs ?? Date.now() - started };
          } catch (err) {
            return { error: (err as Error).message, ms: Date.now() - started };
          }
        });
        return { options: opts, targets: real.map((e) => ({ id: e.id, method: e.method, url: d.redactor.redactUrl(e.url) })), remote, ...summary };
      },
    },
    {
      name: 'debugger_programs',
      description: 'The programs running now that hold network connections (name, process ids, connection count), busiest first: the names the Application column and a Capture only rule use.',
      inputSchema: { type: 'object', properties: { text: str('Only programs whose name contains this') } },
      run: async (a) => {
        const text = typeof a.text === 'string' ? a.text.toLowerCase() : '';
        return { programs: (await listRunningPrograms()).filter((p) => p.name.toLowerCase().includes(text)).slice(0, 200) };
      },
    },
  ];
}
