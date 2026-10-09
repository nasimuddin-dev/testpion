/** RPC handlers: connecting AI agents (Claude, Cursor, VS Code, Codex …) to the open workspace over MCP. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, agentsMarkdown, ApsError, checkTypes, exposedFlows, McpSession, upsertAgentsMarkdown } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export interface AgentConnectOptions {
  readOnly?: boolean;
  allowProduction?: boolean;
}

/** Quote one argument for a command line the user pastes: on Windows paths keep their backslashes (cmd, PowerShell). */
const shellArg = (a: string) => (/^[\w./:@=-]+$/.test(a) ? a : process.platform === 'win32' ? `"${a.replace(/"/g, '\\"')}"` : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);

export function agentHandlers(be: Backend): Handlers {
  /** The command that serves the open workspace over MCP: this app with --mcp-server, or the CLI when it is not a desktop app. */
  const command = (o: AgentConnectOptions = {}) => {
    const self = be.host.mcpCommand;
    const flags = ['-w', be.ws.root, ...(o.readOnly ? ['--read-only'] : []), ...(o.allowProduction ? ['--allow-production'] : [])];
    return self ? { command: self.command, args: [...self.args, '--mcp-server', ...flags], app: true } : { command: 'testpion', args: ['mcp-server', ...flags], app: false };
  };
  return {
    /** What an agent needs to start this workspace's MCP server, and the command line to paste. */
    'agents.info': (o: AgentConnectOptions = {}) => {
      const c = command(o);
      return {
        ...c,
        commandLine: [c.command, ...c.args].map(shellArg).join(' '),
        workspace: { name: be.ws.workspace.name, path: be.ws.root },
        agentsMd: existsSync(join(be.ws.root, 'AGENTS.md')),
      };
    },
    /** Start the server the way an agent would and list what it offers (proves the setup works on this machine). */
    'agents.test': async (o: AgentConnectOptions = {}) => {
      const c = command(o);
      const s = new McpSession({ id: 'agent-test', name: 'testpion', transport: 'stdio', command: c.command, args: c.args, env: process.env.TESTPION_HOME ? { TESTPION_HOME: process.env.TESTPION_HOME } : undefined });
      const t0 = Date.now();
      try {
        await s.connect(30_000);
        const d = await s.discover();
        return { ms: Date.now() - t0, server: d.serverInfo, tools: d.tools.length, readOnlyTools: d.tools.filter((t) => (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint).length, resources: d.resources.length, prompts: d.prompts.map((p) => p.name) };
      } catch (e) {
        throw new ApsError('ConfigurationError', `The MCP server did not start: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        await s.close().catch(() => undefined);
      }
    },
    /** The flows (test files and suites with an expose: block) the server offers to agents as tools of their own. */
    'agents.flows': () => exposedFlows(be.ws),
    /** Write (or refresh) the TestPion part of AGENTS.md in the workspace folder, for coding agents that open it. */
    'agents.writeAgentsMd': () => {
      const path = join(be.ws.root, 'AGENTS.md');
      const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
      // the file may be committed with the workspace: no paths of this machine in it
      atomicWrite(path, upsertAgentsMarkdown(before, agentsMarkdown({ workspace: be.ws.workspace.name, checkTypes: checkTypes() })));
      return { path, updated: before !== undefined };
    },
  };
}
