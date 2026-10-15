import type { PtyProcess, PtySpawnOptions, TerminalHost } from './terminal.js';

/**
 * A TerminalHost over node-pty (@lydell/node-pty: prebuilt for Windows, macOS and Linux, N-API so no rebuild for
 * Electron). `load` returns the module; the desktop app passes one that loads it at the first terminal (never at start).
 */
export interface NodePty {
  spawn(file: string, args: string[], opts: PtySpawnOptions & { name?: string; useConptyDll?: boolean }): PtyProcess & { _agent?: WindowsAgent; on?(event: 'error', cb: (e: Error) => void): void };
}
/** node-pty's Windows internals released after the shell exits (else a worker thread and a socket stay open per terminal). */
interface WindowsAgent {
  _conoutSocketWorker?: { dispose(): void };
  _inSocket?: { destroy(): void };
  _outSocket?: { destroy(): void };
}

export function nodePtyHost(load: () => NodePty, platform: NodeJS.Platform = process.platform): TerminalHost {
  return {
    spawn(file, args, opts) {
      const win = platform === 'win32';
      // ConPTY from the bundled conpty.dll (as VS Code): no child process forked to list the console's processes, which
      // would need ELECTRON_RUN_AS_NODE (turned off in the packaged app by its fuses)
      const p = load().spawn(file, args, { ...opts, name: 'xterm-256color', ...(win ? { useConptyDll: true } : {}) });
      // node-pty throws a read error of the pty (other than the shell going away) unless someone listens: the session
      // then ends through its exit event like any other, not with an exception in the main process
      p.on?.('error', (e) => console.warn(`[terminal] ${e.message}`));
      if (win)
        p.onExit(() => {
          const a = p._agent;
          try {
            a?._conoutSocketWorker?.dispose();
          } catch {
            /* already disposed */
          }
          a?._inSocket?.destroy();
          a?._outSocket?.destroy();
        });
      return p;
    },
  };
}
