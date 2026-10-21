import type { WorkspaceStore } from '../storage/workspace.js';
import { prefetchEnvironmentSecrets } from '../vars/external-secrets.js';
import { allowProductionFor } from '../net/production-guard.js';
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
  /** When to use it, when not, and an example call (tool-docs.ts has them for the fixed tools; a generated tool brings its own). */
  doc?: ToolDoc;
  /** The shape of its structured result (MCP outputSchema); tool-contract.ts has them for the run / send / check tools. */
  outputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/**
 * The second half of a tool's description, so every tool reads the same way: what it does (the description), when to
 * use it, when not (and what to use instead), and one example call. `narrow` says how to ask for less when a result is
 * cut ("filter by `status`, or page with `cursor`").
 */
export interface ToolDoc {
  when: string;
  whenNot: string;
  example: Record<string, unknown>;
  narrow?: string;
}

/** A `limit` argument: a whole number from 1 to `max`, `fallback` when it is missing or not a number. */
export const limitArg = (v: unknown, fallback: number, max: number): number => Math.min(Math.max(Number(v) || fallback, 1), max);

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

/**
 * The production guard on the MCP server (WF-06): a tool that sends or runs with an `environment` takes
 * `allowProduction`, and data-changing requests to an environment marked as production go out only when the server was
 * started with --allow-production **and** the call passes `allowProduction: true` (the engine refuses them otherwise,
 * whatever the tool). One wrapper for every tool, so a new tool cannot forget it.
 */
export function withProductionConsent(tools: Tool[], serverAllows: boolean): Tool[] {
  const prop = { type: 'boolean', description: 'Allow data-changing requests to an environment marked as production (the server must be started with --allow-production too). Ask the user first.' };
  return tools.map((t) => {
    const takes = !!t.write && (Object.hasOwn(t.inputSchema.properties, 'environment') || t.name === 'run_monitor');
    return {
      ...t,
      ...(takes ? { inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, allowProduction: prop } } } : {}),
      run: (args) => allowProductionFor(serverAllows && takes && args.allowProduction === true, () => t.run(args)),
    };
  });
}
