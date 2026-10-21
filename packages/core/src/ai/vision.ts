/**
 * Which models can look at an image (planning/rag-testing.md §4j). A provider lists them (`visionModels`), else the kind and
 * the model's name decide: the hosted families that accept images, the local models that are known to (llava, the Qwen-VL
 * and Gemma 3 families, Llama 3.2 vision …). A text-only judge is never sent an image: the multimodal metrics stop with
 * the setup message instead of scoring a prompt that silently lost the pictures.
 */
import type { ProviderConfig } from '../model/types.js';

const HOSTED: Partial<Record<ProviderConfig['kind'], RegExp>> = {
  anthropic: /claude/i,
  gemini: /gemini/i,
  bedrock: /claude|nova-(pro|lite)|pixtral/i,
  'openai-compatible': /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|^o[134]|vision|pixtral|llava|(^|[-_:])vl([-_:]|$)|gemma-?3|llama-?3\.2-.*(11b|90b)|llama-?4|minicpm-v|qwen.*vl/i,
  'azure-openai': /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|^o[134]/i,
  ollama: /llava|vision|(^|[-_:])vl([-_:]|$)|gemma-?3|minicpm-v|moondream|bakllava|llama-?3\.2-vision|llama-?4|qwen.*vl|pixtral|granite3\.2-vision/i,
};

/** Whether `model` of this provider takes images. */
export function visionCapable(config: Pick<ProviderConfig, 'kind' | 'visionModels'>, model: string): boolean {
  if (config.kind === 'mock') return true;
  if (config.visionModels?.length) return config.visionModels.some((m) => m === model || (m.includes('*') && new RegExp(`^${m.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(model)));
  return HOSTED[config.kind]?.test(model) ?? false;
}
