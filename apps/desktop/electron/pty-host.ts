import { app } from 'electron';
import { join } from 'node:path';
import { nodePtyHost, type NodePty } from '../backend/node-pty-host.js';

/**
 * node-pty for the Terminal panel, loaded when the first terminal opens. The installer ships the platform's package
 * outside app.asar (resources/node-pty, see electron-builder.yml): its .node files, conpty.dll and OpenConsole.exe must
 * be real files.
 */
let mod: NodePty | undefined;
export const ptyHost = nodePtyHost(
  () =>
    (mod ??= app.isPackaged
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require(join(process.resourcesPath, 'node-pty', 'lib', 'index.js')) as NodePty)
      : // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('@lydell/node-pty') as NodePty)),
);
