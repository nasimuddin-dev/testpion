import type { WorkspaceStore } from '../storage/workspace.js';
import { prefetchEnvironmentSecrets } from '../vars/external-secrets.js';
/**
 * The contract of one MCP tool of the TestPion server. Tools live in modules by subject (git-tools.ts,
 * workspace-edit-tools.ts, …) and testpion-mcp.ts composes them; a new tool goes into the module of its subject,
 * or a new module, with its name added to the pinned list in tests/integration/workspace-run.test.ts.
 */
export interface Tool {
  /** snake_case; the agent sees it. */
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  write?: boolean;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/** A string property of an input schema. */
export const str = (description: string) => ({ type: 'string', description });

/**
 * Tools that take an `environment` read its secret manager references (op://, vault:// …) first: those the workspace
 * is trusted to read on this computer (an agent can't allow a new one; the person does, in the app).
 */
export function withEnvironmentSecrets(store: WorkspaceStore, tools: Tool[]): Tool[] {
  return tools.map((t) => ({
    ...t,
    run: async (args) => {
      if (typeof args.environment === 'string' && args.environment) await prefetchEnvironmentSecrets(store, args.environment);
      return t.run(args);
    },
  }));
}
