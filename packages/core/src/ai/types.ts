import type { ProviderConfig, ResponseFormat, TokenUsage } from '../model/types.js';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}

/**
 * An image sent to a vision model AS DATA (base64), never as a URL the provider would fetch. Only a user message carries
 * them; the provider maps them to its own image part. `sha256` identifies the bytes in the cache key and the ledger: the
 * bytes themselves are never logged or stored in a result.
 */
export interface ChatImage {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';
  /** Base64 of the bytes (without the `data:` prefix). */
  data: string;
  sha256: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Images beside the text of a user message (vision models only; see ai/vision.ts). */
  images?: ChatImage[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  seed?: number;
  tools?: ToolDefinition[];
  responseFormat?: ResponseFormat;
  stream?: boolean;
  signal?: AbortSignal;
  /** Receives streamed text deltas. */
  onDelta?: (text: string) => void;
}

interface ChatTiming {
  startedAt: number;
  /** Time to first token (streaming only). */
  firstTokenMs?: number;
  totalMs: number;
  /** Mean time between streamed deltas. */
  interTokenMsAvg?: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** True when usage was estimated rather than reported by the provider. */
  usageEstimated?: boolean;
  finishReason?: string;
  model: string;
  timing: ChatTiming;
  raw?: unknown;
}

export interface LlmProvider {
  readonly config: ProviderConfig;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed?(texts: string[], model?: string, signal?: AbortSignal): Promise<number[][]>;
  listModels?(signal?: AbortSignal): Promise<string[]>;
}

/** Rough token estimate (~4 chars/token) used only when a provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}
