import { Plus, Trash2, Wrench } from 'lucide-react';
import type { MockTool } from '@testpion/core';
import { useRpc } from '../../lib/use-rpc';
import { Button, Empty, IconButton, Input } from '../ui';

/** The text of a tool's fixed result: JSON as written, text as it is. */
const resultText = (r: unknown): string => (r === undefined ? '' : typeof r === 'string' ? r : JSON.stringify(r));
/** The result a person typed: JSON when it is valid JSON, else plain text. */
const resultOf = (t: string): unknown => {
  if (!t.trim()) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const argsText = (t: MockTool): string => Object.keys(((t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as object).join(', ');
const schemaOf = (names: string): Record<string, unknown> => {
  const list = names.split(',').map((x) => x.trim()).filter(Boolean);
  return { type: 'object', properties: Object.fromEntries(list.map((n) => [n, { type: 'string' }])) };
};

const EXAMPLE_TOOLS: MockTool[] = [
  { name: 'search_docs', description: 'Search the help pages', inputSchema: schemaOf('q'), result: { hits: 2, top: 'Opening hours' } },
  { name: 'delete_record', description: 'Delete a customer record', inputSchema: schemaOf('id'), result: { deleted: true } },
];

/**
 * The tools an agent evaluation offers the agent (AU-19): mock tools that answer every call with a fixed result (`{{args.name}}`
 * is filled from the call), and the tools of MCP servers set up in the MCP view (a mock server designed there with the toolset
 * editor works too). The agent only ever calls these; nothing else is reached. The checks then ask which tools it called.
 */
export function AgentToolsEditor({ tools, mcpServers, onChange }: { tools: MockTool[]; mcpServers: string[]; onChange(next: { tools: MockTool[]; mcpServers: string[] }): void }) {
  const servers = useRpc<Array<{ id: string; name: string }>>('mcp.servers', undefined, { keep: true, reloadOn: ['data.changed'] }) ?? [];
  const setTool = (i: number, p: Partial<MockTool>) => onChange({ mcpServers, tools: tools.map((t, j) => (j === i ? { ...t, ...p } : t)) });
  const add = () => {
    const names = new Set(tools.map((t) => t.name));
    let n = 1;
    while (names.has(`tool_${n}`)) n++;
    onChange({ mcpServers, tools: [...tools, { name: `tool_${n}`, description: '', result: { ok: true } }] });
  };
  return (
    <div className="flex flex-col gap-2" data-agent-tools>
      <div className="flex items-center gap-2 text-sm">
        <Wrench size={14} className="text-muted" />
        <span className="font-medium">Tools the agent can use</span>
        <span className="text-xs text-muted">Each mock tool answers every call with the result you write. The checks then say which tools were called.</span>
      </div>
      {tools.length === 0 && (
        <div className="h-44 border border-line rounded-lg">
          <Empty title="No tools yet" actions={[{ label: 'Add the example tools', onClick: () => onChange({ mcpServers, tools: EXAMPLE_TOOLS }) }, { label: 'Add a tool', icon: <Plus size={13} />, onClick: add }]}>
            Without tools the agent can only answer in words. Add a mock tool, or tick a server of the MCP view below.
          </Empty>
        </div>
      )}
      {tools.length > 0 && (
        <div className="grid grid-cols-[10rem_1fr_1fr_9rem_2rem] gap-2 text-xs text-fg/80 font-medium">
          <span>Name</span>
          <span>What it does (the agent reads this)</span>
          <span>Result it returns</span>
          <span>Arguments</span>
          <span />
        </div>
      )}
      {tools.map((t, i) => (
        <div key={i} className="grid grid-cols-[10rem_1fr_1fr_9rem_2rem] gap-2 items-center [&>*]:min-w-0" data-agent-tool={t.name}>
          <Input className="mono" value={t.name} onChange={(e) => setTool(i, { name: e.target.value.replace(/\s+/g, '_') })} aria-label={`Tool ${i + 1} name`} />
          <Input value={t.description ?? ''} onChange={(e) => setTool(i, { description: e.target.value })} aria-label={`Tool ${i + 1} description`} />
          <Input className="mono" value={resultText(t.result)} placeholder='{"ok": true}' onChange={(e) => setTool(i, { result: resultOf(e.target.value) })} aria-label={`Tool ${i + 1} result`} />
          <Input className="mono" value={argsText(t)} placeholder="q, limit" onChange={(e) => setTool(i, { inputSchema: schemaOf(e.target.value) })} aria-label={`Tool ${i + 1} arguments`} />
          <IconButton label={`Remove tool ${t.name}`} size="sm" onClick={() => onChange({ mcpServers, tools: tools.filter((_x, j) => j !== i) })}>
            <Trash2 />
          </IconButton>
        </div>
      ))}
      {tools.length > 0 && (
        <div>
          <Button size="sm" icon={<Plus size={12} />} onClick={add} data-agent-tool-add>
            Add a tool
          </Button>
        </div>
      )}
      <div className="text-sm" data-agent-servers>
        <div className="text-xs text-muted mb-1">{servers.length ? 'Tools of MCP servers (set up in the MCP view, a mock server too):' : 'No MCP servers are set up. Add one in the MCP view to give the agent its real or mock tools.'}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {servers.map((s) => (
            <label key={s.id} className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={mcpServers.includes(s.name)} onChange={(e) => onChange({ tools, mcpServers: e.target.checked ? [...mcpServers, s.name] : mcpServers.filter((x) => x !== s.name) })} aria-label={`Use the tools of ${s.name}`} />
              {s.name}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

export const AGENT_EXAMPLE_TOOLS = EXAMPLE_TOOLS;
