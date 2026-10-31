/**
 * Is this MCP server easy for an AI agent to use? A check of what a server lists, by the habits that make agents pick the right tool and
 * fill its arguments right (Anthropic's "writing tools for agents", the MCP spec's annotations): every tool has a description that says
 * when to use it, every parameter says what it is, a destructive tool says so, names are ones a client accepts, and the whole list does
 * not eat the context window. Pure: it reads a discovery and says words, so the CLI (`testpion mcp --lint`), the MCP tool
 * `mcp_server_tools` and the app say the same.
 */
export interface LintTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export type LintLevel = 'error' | 'warn' | 'tip';

export interface ToolFinding {
  level: LintLevel;
  /** The tool it is about; absent for the server as a whole. */
  tool?: string;
  /** A stable name for the finding. */
  code: string;
  /** One sentence for people, with what to do. */
  text: string;
}

export interface ToolLint {
  tools: number;
  errors: number;
  warnings: number;
  tips: number;
  /** About how many tokens the tool list takes in an agent's context every time (4 characters a token). */
  listTokens: number;
  findings: ToolFinding[];
  /** "12 tools: 1 error, 4 warnings, 3 tips. The list takes about 3,400 tokens of an agent's context." */
  text: string;
}

const NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/;
const DESTRUCTIVE = /\b(delete|remove|drop|destroy|wipe|purge|truncate|erase|overwrite|reset|revoke|kill|terminate)\b/i;
const SHORT = 25;
const LONG = 1500;
const MANY = 50;
const TOO_MANY = 100;
const BIG_LIST_TOKENS = 20_000;

const words = (s: string) => s.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

export interface LintPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string }>;
}

export interface LintResource {
  name: string;
  uri?: string;
  description?: string;
}

export function lintMcpTools(tools: LintTool[], o: { instructions?: string; prompts?: LintPrompt[]; resources?: LintResource[] } = {}): ToolLint {
  const findings: ToolFinding[] = [];
  const add = (level: LintLevel, code: string, text: string, tool?: string) => findings.push({ level, code, text, ...(tool ? { tool } : {}) });

  const seen = new Map<string, string>();
  for (const t of tools) {
    const name = t.name ?? '';
    const d = (t.description ?? '').trim();
    if (!NAME_OK.test(name)) add('error', 'name', `"${name}" is not a name every client accepts (letters, digits, _ and - only, at most 64): some clients drop or rename the tool.`, name);
    else if (/[A-Z]/.test(name) && name.includes('_')) add('tip', 'name-style', `"${name}" mixes camelCase and snake_case: pick one style for the whole server.`, name);

    if (!d) add('error', 'no-description', `${name} has no description: an agent chooses tools by their descriptions, so this one is never picked for the right reason.`, name);
    else {
      if (d.length < SHORT) add('warn', 'short-description', `The description of ${name} is only ${d.length} characters. Say what it does, when to use it, and when not to.`, name);
      if (d.length > LONG) add('warn', 'long-description', `The description of ${name} is ${d.length.toLocaleString('en-US')} characters: it is in the context of every request. Keep what decides the choice, move the rest into a resource or the parameters.`, name);
      if (d.toLowerCase().replace(/\W+/g, ' ') === words(name).toLowerCase().replace(/\W+/g, ' ')) add('warn', 'description-repeats-name', `The description of ${name} only repeats its name.`, name);
      const key = d.toLowerCase();
      if (seen.has(key)) add('warn', 'same-description', `${name} has the same description as ${seen.get(key)}: an agent cannot tell them apart.`, name);
      else seen.set(key, name);
    }

    const schema = t.inputSchema ?? {};
    if (schema.type !== 'object') add('error', 'schema-type', `The input schema of ${name} is not an object schema (type: object): clients cannot build its arguments.`, name);
    const props = (schema.properties ?? {}) as Record<string, { description?: string; type?: unknown; enum?: unknown }>;
    const keys = Object.keys(props);
    const undescribed = keys.filter((k) => !String(props[k]?.description ?? '').trim());
    if (keys.length && undescribed.length === keys.length) add('warn', 'no-parameter-descriptions', `No parameter of ${name} has a description (${undescribed.slice(0, 4).join(', ')}${undescribed.length > 4 ? ' …' : ''}): an agent guesses what each one means.`, name);
    else if (undescribed.length) add('tip', 'some-parameter-descriptions', `${undescribed.length} of ${keys.length} parameters of ${name} have no description: ${undescribed.slice(0, 4).join(', ')}.`, name);
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : undefined;
    if (keys.length && !required) add('tip', 'no-required', `${name} does not say which parameters are required: an agent may omit one it needs, or fill one it need not.`, name);
    const bad = (required ?? []).filter((r) => typeof r === 'string' && !keys.includes(r));
    if (bad.length) add('error', 'required-unknown', `${name} requires ${bad.join(', ')}, which is not one of its parameters.`, name);

    const a = t.annotations ?? {};
    const sounds = DESTRUCTIVE.test(words(name)) || DESTRUCTIVE.test(d);
    if (sounds && a.readOnlyHint !== true && a.destructiveHint === undefined) add('warn', 'destructive-unmarked', `${name} sounds destructive but has no destructiveHint annotation: a client cannot ask before it runs.`, name);
    if (a.readOnlyHint === undefined && a.destructiveHint === undefined && !sounds) add('tip', 'no-annotations', `${name} has no readOnlyHint: say when it only reads, so a client can run it without asking.`, name);
    if (!t.outputSchema) add('tip', 'no-output-schema', `${name} has no output schema: an agent reads its result as free text.`, name);
  }

  // prompts and resources are read by agents too: a name alone does not say when to use them
  for (const p of o.prompts ?? []) {
    if (!(p.description ?? '').trim()) add('warn', 'prompt-no-description', `The prompt ${p.name} has no description: a client cannot tell when to offer it.`, p.name);
    const bare = (p.arguments ?? []).filter((a) => !(a.description ?? '').trim());
    if (bare.length) add('tip', 'prompt-argument-no-description', `${bare.length} argument${bare.length === 1 ? '' : 's'} of the prompt ${p.name} ${bare.length === 1 ? 'has' : 'have'} no description: ${bare.slice(0, 4).map((a) => a.name).join(', ')}.`, p.name);
  }
  const bareResources = (o.resources ?? []).filter((r) => !(r.description ?? '').trim());
  if (bareResources.length) add('tip', 'resource-no-description', `${bareResources.length} resource${bareResources.length === 1 ? '' : 's'} ${bareResources.length === 1 ? 'has' : 'have'} no description: ${bareResources.slice(0, 4).map((r) => r.name || r.uri).join(', ')}${bareResources.length > 4 ? ' …' : ''}.`);

  const listTokens = Math.round(JSON.stringify(tools).length / 4);
  if (tools.length > TOO_MANY) add('error', 'too-many-tools', `${tools.length} tools is too many: agents pick worse the more they are offered. Group them, or offer a smaller set per task.`);
  else if (tools.length > MANY) add('warn', 'many-tools', `${tools.length} tools: agents pick worse the more they are offered (past about ${MANY}). Group them, or offer a smaller set per task.`);
  if (listTokens > BIG_LIST_TOKENS) add('warn', 'big-list', `The tool list takes about ${listTokens.toLocaleString('en-US')} tokens of an agent's context every time. Shorten descriptions, or offer fewer tools.`);
  if (!o.instructions?.trim() && tools.length > 8) add('tip', 'no-instructions', `The server gives no instructions: with ${tools.length} tools, a few lines on how they fit together help an agent plan.`);

  const rank = { error: 0, warn: 1, tip: 2 } as const;
  findings.sort((a, b) => rank[a.level] - rank[b.level]);
  const errors = findings.filter((f) => f.level === 'error').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  const tips = findings.filter((f) => f.level === 'tip').length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const text = `${plural(tools.length, 'tool')}: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${plural(tips, 'tip')}. The list takes about ${listTokens.toLocaleString('en-US')} tokens of an agent's context.`;
  return { tools: tools.length, errors, warnings, tips, listTokens, findings, text };
}
