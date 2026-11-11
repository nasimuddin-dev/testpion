import { MINIMAL_TOOLS } from './tools/search-tools.js';

/**
 * What the `minimal` profile lists: the tools of the common jobs, the workspace's own flows exposed as tools (what the
 * team chose to offer), and the tools the agent found with search_tools or called by name, which join the list for the
 * rest of the session. Every tool can be called whatever is listed.
 */
export class MinimalList {
  private readonly found = new Set<string>();
  /** The workspace's flows exposed as tools. */
  own = new Set<string>();

  has = (name: string): boolean => MINIMAL_TOOLS.has(name) || this.own.has(name) || this.found.has(name);

  /** Adds tools to the list; true when one of them was not listed before. */
  add(names: string[], exists: (name: string) => boolean): boolean {
    const fresh = names.filter((n) => !this.has(n) && exists(n));
    for (const n of fresh) this.found.add(n);
    return fresh.length > 0;
  }
}

/**
 * `search_tools { name, arguments }` calls the named tool: for a client that offers its model only the tools listed at
 * the start. Returns the call it stands for, or the call as it is.
 */
export function throughSearchTools<T extends { name: string; arguments?: Record<string, unknown> }>(params: T): T {
  const a = params.name === 'search_tools' ? params.arguments : undefined;
  if (a && typeof a.name === 'string' && a.name !== 'search_tools' && a.arguments && typeof a.arguments === 'object' && !Array.isArray(a.arguments))
    return { ...params, name: a.name, arguments: a.arguments as Record<string, unknown> };
  return params;
}

/** The tools a call brought up: the ones search_tools found (or the one it described), else the tool that was called. */
export function toolsOfCall(tool: string, result: unknown): string[] {
  if (tool !== 'search_tools') return [tool];
  const r = result as { tools?: Array<{ name: string }>; name?: string } | undefined;
  return [...(r?.tools ?? []).map((t) => t.name), ...(typeof r?.name === 'string' ? [r.name] : [])];
}
