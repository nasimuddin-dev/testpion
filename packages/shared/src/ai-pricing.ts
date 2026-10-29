/**
 * What an AI call cost, as an estimate (FG-18). A small table of list prices in US dollars per million tokens, matched by model
 * name prefix. Prices change and plans differ, so the answer is always labelled an estimate; a model that is not in the table
 * has no cost (never a guess). Local models (Ollama) cost nothing.
 */
export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Input tokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Input tokens written to the prompt cache (Anthropic). */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface Price {
  match: RegExp;
  input: number;
  output: number;
  /** Per million cached input tokens; defaults to a tenth of the input price. */
  cached?: number;
}

const PRICES: Price[] = [
  { match: /^gpt-4o-mini/, input: 0.15, output: 0.6, cached: 0.075 },
  { match: /^gpt-4o/, input: 2.5, output: 10, cached: 1.25 },
  { match: /^gpt-4\.1-nano/, input: 0.1, output: 0.4, cached: 0.025 },
  { match: /^gpt-4\.1-mini/, input: 0.4, output: 1.6, cached: 0.1 },
  { match: /^gpt-4\.1/, input: 2, output: 8, cached: 0.5 },
  { match: /^o4-mini|^o3-mini/, input: 1.1, output: 4.4, cached: 0.275 },
  { match: /^o3/, input: 2, output: 8, cached: 0.5 },
  { match: /^claude-.*haiku/, input: 0.8, output: 4 },
  { match: /^claude-.*opus/, input: 15, output: 75 },
  { match: /^claude-.*sonnet/, input: 3, output: 15 },
  { match: /^gemini-.*flash-lite/, input: 0.1, output: 0.4 },
  { match: /^gemini-.*flash/, input: 0.3, output: 2.5 },
  { match: /^gemini-.*pro/, input: 1.25, output: 10 },
  { match: /^text-embedding-3-small/, input: 0.02, output: 0 },
  { match: /^text-embedding-3-large/, input: 0.13, output: 0 },
];

export interface AiCost {
  usd: number;
  /** Always says it is an estimate, and for what. */
  note: string;
}

/** The estimated cost of one call, or undefined when the model has no known price or the usage is not known. */
export function aiCostOf(provider: string, model: string | undefined, u: AiUsage | undefined): AiCost | undefined {
  if (!u) return undefined;
  if (provider === 'ollama') return { usd: 0, note: 'A local model: no charge.' };
  if (!model) return undefined;
  const p = PRICES.find((x) => x.match.test(model.toLowerCase().replace(/^models\//, '').replace(/^.*\//, '')));
  if (!p || (u.inputTokens === undefined && u.outputTokens === undefined)) return undefined;
  const cached = Math.min(u.cachedInputTokens ?? 0, u.inputTokens ?? 0);
  // Anthropic reports cached tokens beside the input count, OpenAI and Gemini inside it
  const inside = provider !== 'anthropic';
  const fresh = Math.max(0, (u.inputTokens ?? 0) - (inside ? cached : 0));
  const cachedPrice = p.cached ?? p.input / 10;
  const writes = (u.cacheWriteTokens ?? 0) * p.input * 1.25;
  const usd = (fresh * p.input + cached * cachedPrice + writes + (u.outputTokens ?? 0) * p.output) / 1_000_000;
  return { usd, note: 'An estimate from list prices per million tokens; your plan or the current price may differ.' };
}

/** Secrets that show up as text inside prompts, headers echoed in tool results and the like. */
const SECRET_SHAPES: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const SECRET_KEY = /^(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|client[-_]?secret|password|passwd|bearer|private[-_]?key|cookie|set-cookie)$/i;

/** Text with anything shaped like an API key, token or bearer credential replaced. */
export function scrubSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_SHAPES) out = out.replace(re, (m, scheme) => (scheme ? `${scheme} ***` : '***'));
  return out;
}

/** A value (tool arguments, results) with secret-looking keys masked and secret-shaped strings replaced. Bounded in depth and size. */
export function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return scrubSecrets(v.length > 4000 ? `${v.slice(0, 4000)}…` : v);
  if (v === null || typeof v !== 'object') return v;
  if (depth > 8) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) out[k] = SECRET_KEY.test(k) ? '***' : scrubValue(x, depth + 1);
  return out;
}
