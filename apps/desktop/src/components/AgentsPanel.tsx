import { CodeBlock } from './CodeBlock';
import { Bot, Check, Copy, FileText, PlugZap, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { toastError, useApp } from '../store';
import { Badge, Button, Tabs, Toggle } from './ui';
import { useCopied } from '../lib/clipboard';

interface AgentInfo {
  command: string;
  args: string[];
  commandLine: string;
  app: boolean;
  workspace: { name: string; path: string };
  agentsMd: boolean;
}

interface TestResult {
  ms: number;
  server?: { name: string; version: string };
  tools: number;
  readOnlyTools: number;
  resources: number;
  prompts: string[];
}

type Client = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode' | 'codex';

/** A test file or suite with an expose: block: a tool of its own on the server. */
interface ExposedFlow {
  tool: string;
  description?: string;
  file: string;
  kind: 'file' | 'suite';
  inputs: Array<{ name: string; description?: string; default?: string; required?: boolean }>;
  problem?: string;
}

/** Where each agent keeps its MCP servers, and the text to put there. */
function snippet(client: Client, i: AgentInfo): { where: string; text: string } {
  const server = { command: i.command, args: i.args };
  const json = (o: unknown) => JSON.stringify(o, null, 2);
  switch (client) {
    case 'claude-code':
      return { where: 'Run in a terminal (add --scope project to share it with the repository):', text: `claude mcp add testpion -- ${i.commandLine}` };
    case 'claude-desktop':
      return { where: 'Settings ▸ Developer ▸ Edit Config (claude_desktop_config.json), then restart Claude:', text: json({ mcpServers: { testpion: server } }) };
    case 'cursor':
      return { where: '~/.cursor/mcp.json (or .cursor/mcp.json in a project); Windsurf and Gemini CLI use the same format:', text: json({ mcpServers: { testpion: server } }) };
    case 'vscode':
      return { where: '.vscode/mcp.json in your project (GitHub Copilot agent mode), or MCP: Add Server…:', text: json({ servers: { testpion: { type: 'stdio', ...server } } }) };
    case 'codex':
      return { where: '~/.codex/config.toml:', text: `[mcp_servers.testpion]\ncommand = ${JSON.stringify(i.command)}\nargs = [${i.args.map((a) => JSON.stringify(a)).join(', ')}]` };
  }
}

/**
 * Settings ▸ AI agents: connect Claude, Cursor, VS Code, Codex … to this workspace over MCP. The app itself is the
 * server (`TestPion --mcp-server`), so nothing else needs installing; a test starts it the way an agent will.
 */
export function AgentsPanel() {
  const ws = useApp((s) => s.workspace);
  const [opts, setOpts] = useState({ readOnly: false, allowProduction: false });
  const [info, setInfo] = useState<AgentInfo>();
  const [client, setClient] = useState<Client>('claude-code');
  const { copied, copy: copyToClipboard } = useCopied();
  const [test, setTest] = useState<{ busy?: boolean; result?: TestResult; error?: string }>({});
  const [flows, setFlows] = useState<ExposedFlow[]>([]);
  useEffect(() => {
    void call<AgentInfo>('agents.info', opts).then(setInfo, (e) => toastError(e));
    setTest({});
  }, [opts.readOnly, opts.allowProduction, ws?.id]);
  useEffect(() => {
    void call<ExposedFlow[]>('agents.flows').then(setFlows, () => setFlows([]));
  }, [ws?.id]);
  if (!info) return null;
  const s = snippet(client, info);
  const copy = () => copyToClipboard(s.text);
  const runTest = async () => {
    setTest({ busy: true });
    try {
      setTest({ result: await call<TestResult>('agents.test', opts) });
    } catch (e) {
      setTest({ error: asError(e).message });
    }
  };
  const writeAgentsMd = async () => {
    try {
      const r = await call<{ path: string; updated: boolean }>('agents.writeAgentsMd', opts);
      useApp.getState().toast(`${r.updated ? 'Updated the TestPion part of' : 'Wrote'} ${r.path}`, 'success');
      setInfo({ ...info, agentsMd: true });
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center h-10 w-10 rounded-xl bg-accent-soft text-accent shrink-0">
          <Bot size={20} />
        </div>
        <div className="text-sm leading-relaxed">
          <div className="text-base font-semibold">Let AI agents use this workspace</div>
          Claude, Cursor, VS Code (Copilot), Codex and other agents can find your requests, send them, run collections and tests, read monitors and traces, and write checks and test files, over the{' '}
          <a className="text-accent hover:underline" href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">
            Model Context Protocol
          </a>
          . {info.app ? 'TestPion itself is the server: nothing else to install.' : 'Agents start it with the testpion CLI.'} Secret values never reach the agent; it sees variable names.
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-sm">
          Workspace <b>{info.workspace.name}</b> <span className="text-muted mono text-xs">{info.workspace.path}</span>
        </div>
        <Toggle checked={opts.readOnly} onChange={(readOnly) => setOpts({ ...opts, readOnly })} label="Read-only: the agent can look but not send requests or change files" />
        <Toggle checked={opts.allowProduction} onChange={(allowProduction) => setOpts({ ...opts, allowProduction })} label="Allow sending to environments marked as production" />
      </div>

      <div className="rounded-xl border border-line overflow-hidden">
        <Tabs
          value={client}
          onChange={setClient}
          tabs={[
            { id: 'claude-code', label: 'Claude Code' },
            { id: 'claude-desktop', label: 'Claude Desktop' },
            { id: 'cursor', label: 'Cursor / Windsurf' },
            { id: 'vscode', label: 'VS Code' },
            { id: 'codex', label: 'Codex' },
          ]}
        />
        <div className="p-3 flex flex-col gap-2">
          <div className="text-xs text-muted">{s.where}</div>
          <div className="relative">
            <CodeBlock className="mono text-xs bg-bg border border-line rounded-lg p-3 pr-20 whitespace-pre-wrap break-all" text={s.text} />
            <Button size="sm" className="absolute top-2 right-2" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="primary" icon={<PlugZap size={13} />} loading={test.busy} onClick={() => void runTest()}>
            Test connection
          </Button>
          <Button icon={<FileText size={13} />} onClick={() => void writeAgentsMd()} title="Coding agents (Claude Code, Codex, Cursor, Copilot) read AGENTS.md first when they open a folder">
            {info.agentsMd ? 'Update AGENTS.md' : 'Write AGENTS.md'}
          </Button>
        </div>
        {test.result && (
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <Badge tone="ok">Works</Badge>
            {test.result.server?.name} {test.result.server?.version} started in {(test.result.ms / 1000).toFixed(1)} s: {test.result.tools} tools ({test.result.readOnlyTools} read-only), {test.result.resources} resources, {test.result.prompts.length} prompts
            <span className="text-muted">({test.result.prompts.join(', ')})</span>
          </div>
        )}
        {test.error && <div className="text-sm text-bad">{test.error}</div>}
        <p className="text-xs text-muted leading-relaxed">
          Agents ask before running tools that send requests or change files (their annotations say which ones). Try the prompts <span className="mono">investigate_failures</span>, <span className="mono">write_tests</span> and{' '}
          <span className="mono">debug_request</span> (in Claude Code: type <span className="mono">/</span>). <b>AGENTS.md</b> tells coding agents that open this folder how to use it.
        </p>
      </div>

      <div className="flex flex-col gap-2" data-exposed-flows>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Workflow size={14} className="text-accent" /> Flows exposed as tools
        </div>
        {flows.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {flows.map((f) => (
              <li key={f.file} className="flex items-start gap-2 flex-wrap">
                <span className="mono">{f.tool || '(invalid)'}</span>
                {f.problem ? <Badge tone="bad">{f.problem}</Badge> : f.inputs.length ? <span className="text-muted text-xs">({f.inputs.map((i) => i.name).join(', ')})</span> : null}
                <span className="text-muted text-xs mono">tests/{f.file}</span>
                {f.description && <span className="text-muted text-xs basis-full">{f.description}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-muted">None yet.</div>
        )}
        <p className="text-xs text-muted leading-relaxed">
          A test file or suite with an <span className="mono">expose:</span> block (Tests ▸ a file's menu ▸ <b>Expose as MCP tool…</b>, or <span className="mono">testpion flows</span>) is a tool of its own: an agent calls it by name with the inputs as arguments and gets each step's result and the values
          the flow extracted. Agents already connected see a new or changed flow after they reconnect; <span className="mono">list_flows</span> lists them.
        </p>
      </div>
    </div>
  );
}
