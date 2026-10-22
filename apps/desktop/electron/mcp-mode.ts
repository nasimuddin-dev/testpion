import { safeStorage } from 'electron';
import { join } from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { ChainSecretStore, EncryptedFileSecretStore, EnvSecretStore, ENGINE_VERSION, safeStorageCipher, serveTestPionMcp, setNetworkPolicy, WorkspaceManager, type SafeStorageLike, type SecretStore } from '@testpion/core';

/**
 * `TestPion --mcp-server`: the installed app serves a workspace to AI agents over MCP (stdio), the same as
 * `testpion mcp-server` but without installing the CLI, and with the secrets saved in the app (decrypted with
 * the OS key store). No window opens; stdout carries the protocol, everything else goes to stderr.
 */
export interface McpModeOptions {
  workspace?: string;
  readOnly: boolean;
  allowProduction: boolean;
  blockPrivateNetworks: boolean;
  allowHosts: string[];
}

/** The options when the app was started with --mcp-server, else null. */
export function parseMcpMode(argv: string[]): McpModeOptions | null {
  if (!argv.includes('--mcp-server')) return null;
  const value = (flag: string, short?: string) => {
    const i = argv.findIndex((a) => a === flag || (short && a === short));
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    return eq?.slice(flag.length + 1);
  };
  const hosts: string[] = [];
  argv.forEach((a, i) => a === '--allow-host' && argv[i + 1] && hosts.push(argv[i + 1]!));
  return {
    workspace: value('--workspace', '-w'),
    readOnly: argv.includes('--read-only'),
    allowProduction: argv.includes('--allow-production'),
    blockPrivateNetworks: argv.includes('--block-private-networks'),
    allowHosts: hosts,
  };
}

/** Serve until the agent disconnects; resolves with the exit code. */
export async function runMcpMode(o: McpModeOptions, appDir: string): Promise<number> {
  try {
    if (o.blockPrivateNetworks) setNetworkPolicy({ blockPrivateNetworks: true, allowHosts: o.allowHosts });
    const mgr = new WorkspaceManager(appDir);
    const settings = mgr.loadSettings();
    // the workspace asked for, else the one the app last opened
    const ref = o.workspace ?? settings.lastWorkspace;
    if (!ref) throw new Error('No workspace: pass --workspace <name or folder> (or open one in TestPion first)');
    const store = mgr.open(ref);
    const stores: SecretStore[] = [];
    const cipher = safeStorageCipher(safeStorage as unknown as SafeStorageLike);
    if (cipher.isAvailable()) stores.push(new EncryptedFileSecretStore(join(appDir, 'secrets.json'), cipher));
    stores.push(new EnvSecretStore());
    console.error(`TestPion MCP server for "${store.workspace.name}"${o.readOnly ? ' (read-only)' : ''} on stdio`);
    try {
      // the pipes themselves: Electron's process.stdin reads nothing on Windows
      const stdio = { input: createReadStream('', { fd: 0 }), output: createWriteStream('', { fd: 1 }) };
      await serveTestPionMcp({ store, secrets: new ChainSecretStore(stores), settings, readOnly: o.readOnly, allowProduction: o.allowProduction, version: ENGINE_VERSION, stdio });
    } finally {
      store.close();
    }
    return 0;
  } catch (e) {
    console.error(`TestPion MCP server: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
