import { nodeRequire } from '../util/lazy-require.js';

/**
 * The MCP SDK's modules, loaded at first use (an MCP connection, a mock or the workspace server), not when the engine
 * is imported: with zod and its HTTP server they are a large part of the desktop app's start (see util/lazy-require.ts).
 * Every module of the SDK the engine uses is loaded here, so there is one copy of it.
 */
type Types = typeof import('@modelcontextprotocol/sdk/types.js');
// the client is the v2 SDK (@modelcontextprotocol/client): it speaks the 2026-07-28 revision and the earlier ones
type ClientIndex = typeof import('@modelcontextprotocol/client');
type ClientStdio = typeof import('@modelcontextprotocol/client/stdio');
type ServerIndex = typeof import('@modelcontextprotocol/sdk/server/index.js');
type ServerStdio = typeof import('@modelcontextprotocol/sdk/server/stdio.js');
type ServerHttp = typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js');

const has = typeof require === 'function';

/**
 * The server side of the SDK (types, the server, stdio) as one file, when the build made one (packages/cli/dist/mcp-sdk.cjs): loading it
 * takes about 55 ms where its 500 module files take 210 ms with a warm compile cache. Set once at start; the client modules and
 * everything else still load as files.
 */
let sdkBundle: { types: Types; server: ServerIndex; stdio: ServerStdio } | undefined;
let sdkBundlePath: string | undefined;
export function useMcpSdkBundle(path: string | undefined): void {
  sdkBundlePath = path;
  sdkBundle = undefined;
}
const bundled = () => (sdkBundlePath ? (sdkBundle ??= nodeRequire(sdkBundlePath) as NonNullable<typeof sdkBundle>) : undefined);
let types: Types | undefined;
let clientIndex: ClientIndex | undefined;
let clientStdio: ClientStdio | undefined;
let serverIndex: ServerIndex | undefined;
let serverStdio: ServerStdio | undefined;
let serverHttp: ServerHttp | undefined;

export const mcpTypes = (): Types => (types ??= bundled()?.types ?? (has ? require('@modelcontextprotocol/sdk/types.js') : nodeRequire('@modelcontextprotocol/sdk/types.js')));
export const mcpClient = (): ClientIndex => (clientIndex ??= has ? require('@modelcontextprotocol/client') : nodeRequire('@modelcontextprotocol/client'));
export const mcpClientStdio = (): ClientStdio => (clientStdio ??= has ? require('@modelcontextprotocol/client/stdio') : nodeRequire('@modelcontextprotocol/client/stdio'));
export const mcpServer = (): ServerIndex => (serverIndex ??= bundled()?.server ?? (has ? require('@modelcontextprotocol/sdk/server/index.js') : nodeRequire('@modelcontextprotocol/sdk/server/index.js')));
export const mcpServerStdio = (): ServerStdio => (serverStdio ??= bundled()?.stdio ?? (has ? require('@modelcontextprotocol/sdk/server/stdio.js') : nodeRequire('@modelcontextprotocol/sdk/server/stdio.js')));
export const mcpServerHttp = (): ServerHttp => (serverHttp ??= has ? require('@modelcontextprotocol/sdk/server/streamableHttp.js') : nodeRequire('@modelcontextprotocol/sdk/server/streamableHttp.js'));
