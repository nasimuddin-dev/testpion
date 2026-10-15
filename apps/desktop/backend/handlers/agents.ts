/** RPC handlers: connecting AI agents (Claude, Cursor, VS Code, Codex …) to the open workspace over MCP. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_TARGETS, ApsError, exposedFlows, initAgentFiles, McpSession, parseAgentTargets } from '@testpion/core';
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
        // which agent files the workspace has (the app ticks those to refresh)
        agentFiles: Object.fromEntries(Object.entries(AGENT_TARGETS).map(([t, p]) => [t, existsSync(join(be.ws.root, ...p.split('/')))])),
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
    /**
     * Write (or refresh) the agent files in the workspace folder: AGENTS.md, and with `targets` a CLAUDE.md pointer and
     * the Cursor rule. Only TestPion's marked part of each is replaced; what happened to each file comes back.
     */
    'agents.init': ({ targets, force, dryRun }: { targets?: string[]; force?: boolean; dryRun?: boolean } = {}) => initAgentFiles(be.ws, { targets: parseAgentTargets(targets), force, dryRun }),
    /** 0.45: AGENTS.md alone (agents.init with its default target). */
    'agents.writeAgentsMd': () => {
      const r = initAgentFiles(be.ws, { targets: ['agents'] });
      const f = r.files[0]!;
      if (f.status === 'skipped') throw new ApsError('ValidationError', `AGENTS.md was not written: ${f.reason}`);
      return { path: join(be.ws.root, f.path), updated: f.status !== 'created', status: f.status };
    },
  };
}
