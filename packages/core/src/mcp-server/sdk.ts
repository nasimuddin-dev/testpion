import { nodeRequire } from '../util/lazy-require.js';

/**
 * The MCP SDK's modules, loaded at first use (an MCP connection, a mock or the workspace server), not when the engine
 * is imported: with zod they are a large part of the desktop app's start (see util/lazy-require.ts).
 * Every module of the SDK the engine uses is loaded here, so there is one copy of it.
 *
 * Both sides are the v2 SDK (@modelcontextprotocol/client and /server), which speaks the 2026-07-28 revision and the
 * earlier ones: a server made here serves a client of either, and says per connection which it is.
 */
type ClientIndex = typeof import('@modelcontextprotocol/client');
type ClientStdio = typeof import('@modelcontextprotocol/client/stdio');
type ServerIndex = typeof import('@modelcontextprotocol/server');
type ServerStdio = typeof import('@modelcontextprotocol/server/stdio');

const has = typeof require === 'function';

/**
 * The server side of the SDK (the server, stdio) as one file, when the build made one (packages/cli/dist/mcp-sdk.cjs): loading it
 * is several times faster than loading its module files, even with a warm compile cache. Set once at start; the client modules and
 * everything else still load as files.
 */
let sdkBundle: { server: ServerIndex; stdio: ServerStdio } | undefined;
let sdkBundlePath: string | undefined;
export function useMcpSdkBundle(path: string | undefined): void {
  sdkBundlePath = path;
  sdkBundle = undefined;
}
const bundled = () => (sdkBundlePath ? (sdkBundle ??= nodeRequire(sdkBundlePath) as NonNullable<typeof sdkBundle>) : undefined);
let clientIndex: ClientIndex | undefined;
let clientStdio: ClientStdio | undefined;
let serverIndex: ServerIndex | undefined;
let serverStdio: ServerStdio | undefined;

export const mcpClient = (): ClientIndex => (clientIndex ??= has ? require('@modelcontextprotocol/client') : nodeRequire('@modelcontextprotocol/client'));
export const mcpClientStdio = (): ClientStdio => (clientStdio ??= has ? require('@modelcontextprotocol/client/stdio') : nodeRequire('@modelcontextprotocol/client/stdio'));
export const mcpServer = (): ServerIndex => (serverIndex ??= bundled()?.server ?? (has ? require('@modelcontextprotocol/server') : nodeRequire('@modelcontextprotocol/server')));
export const mcpServerStdio = (): ServerStdio => (serverStdio ??= bundled()?.stdio ?? (has ? require('@modelcontextprotocol/server/stdio') : nodeRequire('@modelcontextprotocol/server/stdio')));
