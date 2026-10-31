import { useMemo } from 'react';
import { lintMcpTools, type LintTool } from '@testpion/shared';
import { Badge } from '../ui';

const TONE = { error: 'bad', warn: 'warn', tip: 'default' } as const;
const WORD = { error: 'Fix', warn: 'Check', tip: 'Tip' } as const;

/**
 * "For AI agents" (Server info): how easy this server's tools are for an agent to use, read from the tool list the app already has.
 * The same words as `testpion mcp --lint` and the MCP tool `mcp_server_tools`.
 */
export function AgentFriendly({ tools, instructions }: { tools: LintTool[]; instructions?: string }) {
  const lint = useMemo(() => lintMcpTools(tools, { instructions }), [tools, instructions]);
  return (
    <section className="px-3 py-2 border-b border-line text-sm" data-mcp-lint aria-label="For AI agents">
      <h3 className="font-medium">For AI agents</h3>
      <p className="text-muted text-xs mt-0.5" data-mcp-lint-text>
        {lint.text}
      </p>
      {lint.findings.length === 0 ? (
        <p className="text-xs mt-1">Every tool says what it does and what its parameters mean.</p>
      ) : (
        <ul className="mt-1 grid gap-1 max-h-60 overflow-auto">
          {lint.findings.map((f, i) => (
            <li key={`${f.code}-${f.tool ?? ''}-${i}`} className="flex items-start gap-2 text-xs" data-mcp-lint-finding={f.level}>
              <Badge tone={TONE[f.level]}>{WORD[f.level]}</Badge>
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
