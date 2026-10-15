/** RPC handlers: the bottom panel's Terminal (shells in pseudo-terminals; see ../terminal.ts). Desktop host only. */
import { join } from 'node:path';
import type { Backend, Handlers } from '../backend.js';
import { TerminalManager } from '../terminal.js';

export type { TerminalHost, TerminalManager } from '../terminal.js';

/** The backend's terminals: shells only when the host provides a pty; `testpion` runs the host's own CLI (mcpCommand). */
export function createTerminals(be: Backend): TerminalManager {
  return new TerminalManager({
    host: be.host.terminal,
    emit: (channel, payload) => be.host.emit(channel, payload),
    workspaceRoot: () => be.store?.root,
    binDir: join(be.host.appDir, 'terminal-bin'),
    cli: be.host.mcpCommand,
  });
}

export function terminalHandlers(be: Backend): Handlers {
  const t = () => be.terminals;
  return {
    /** Whether this host runs shells, and which ones (the default first). Empty on a host without a terminal (cloud). */
    'terminal.shells': () => ({
      available: t().available,
      shells: t()
        .shells()
        .map(({ id, label, path }) => ({ id, label, path })),
    }),
    /** Open a shell (default: the first of terminal.shells) in the workspace folder; output comes as terminal.data events. */
    'terminal.create': ({ shell, cols, rows, cwd }: { shell?: string; cols?: number; rows?: number; cwd?: string }) => t().create({ shell, cols, rows, cwd }),
    /** Type into a terminal (keys, a paste). */
    'terminal.write': ({ id, data }: { id: string; data: string }) => t().write(id, data),
    /** The window drew a terminal's output up to `parsed` characters (absolute, within replay `epoch`): flow control. */
    'terminal.ack': ({ id, parsed, epoch }: { id: string; parsed: number; epoch?: number }) => t().ack(id, parsed, epoch ?? 0),
    'terminal.resize': ({ id, cols, rows }: { id: string; cols: number; rows: number }) => t().resize(id, cols, rows),
    /** End a terminal's shell and close it. */
    'terminal.kill': ({ id }: { id: string }) => t().kill(id),
    /** The open terminals; `withOutput` adds each one's last output (up to 1 MB), for a window that reloads. */
    'terminal.list': ({ withOutput }: { withOutput?: boolean } = {}) => t().list(!!withOutput),
  };
}
