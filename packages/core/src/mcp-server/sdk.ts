import { nodeRequire } from '../util/lazy-require.js';

/**
 * The MCP SDK's modules, loaded at first use (an MCP connection, a mock or the workspace server), not when the engine
 * is imported: with zod and its HTTP server they are a large part of the desktop app's start (see util/lazy-require.ts).
 * Every module of the SDK the engine uses is loaded here, so there is one copy of it.
 */
type Types = typeof import('@modelcontextprotocol/sdk/types.js');
type ClientIndex = typeof import('@modelcontextprotocol/sdk/client/index.js');
type ClientStdio = typeof import('@modelcontextprotocol/sdk/client/stdio.js');
type ClientHttp = typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js');
type ClientSse = typeof import('@modelcontextprotocol/sdk/client/sse.js');
type InMemory = typeof import('@modelcontextprotocol/sdk/inMemory.js');
type ServerIndex = typeof import('@modelcontextprotocol/sdk/server/index.js');
type ServerStdio = typeof import('@modelcontextprotocol/sdk/server/stdio.js');
type ServerHttp = typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js');

const has = typeof require === 'function';
let types: Types | undefined;
let clientIndex: ClientIndex | undefined;
let clientStdio: ClientStdio | undefined;
let clientHttp: ClientHttp | undefined;
let clientSse: ClientSse | undefined;
let inMemory: InMemory | undefined;
let serverIndex: ServerIndex | undefined;
let serverStdio: ServerStdio | undefined;
let serverHttp: ServerHttp | undefined;

export const mcpTypes = (): Types => (types ??= has ? require('@modelcontextprotocol/sdk/types.js') : nodeRequire('@modelcontextprotocol/sdk/types.js'));
export const mcpClient = (): ClientIndex => (clientIndex ??= has ? require('@modelcontextprotocol/sdk/client/index.js') : nodeRequire('@modelcontextprotocol/sdk/client/index.js'));
export const mcpClientStdio = (): ClientStdio => (clientStdio ??= has ? require('@modelcontextprotocol/sdk/client/stdio.js') : nodeRequire('@modelcontextprotocol/sdk/client/stdio.js'));
export const mcpClientHttp = (): ClientHttp => (clientHttp ??= has ? require('@modelcontextprotocol/sdk/client/streamableHttp.js') : nodeRequire('@modelcontextprotocol/sdk/client/streamableHttp.js'));
export const mcpClientSse = (): ClientSse => (clientSse ??= has ? require('@modelcontextprotocol/sdk/client/sse.js') : nodeRequire('@modelcontextprotocol/sdk/client/sse.js'));
export const mcpInMemory = (): InMemory => (inMemory ??= has ? require('@modelcontextprotocol/sdk/inMemory.js') : nodeRequire('@modelcontextprotocol/sdk/inMemory.js'));
export const mcpServer = (): ServerIndex => (serverIndex ??= has ? require('@modelcontextprotocol/sdk/server/index.js') : nodeRequire('@modelcontextprotocol/sdk/server/index.js'));
export const mcpServerStdio = (): ServerStdio => (serverStdio ??= has ? require('@modelcontextprotocol/sdk/server/stdio.js') : nodeRequire('@modelcontextprotocol/sdk/server/stdio.js'));
export const mcpServerHttp = (): ServerHttp => (serverHttp ??= has ? require('@modelcontextprotocol/sdk/server/streamableHttp.js') : nodeRequire('@modelcontextprotocol/sdk/server/streamableHttp.js'));
