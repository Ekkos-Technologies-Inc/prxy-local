/**
 * Cheap token estimation. ~4 chars/token is the rule of thumb for English.
 * Good enough for budget guards and compression triggers; modules that need
 * exact accounting should use the provider's own tokenizer post-response.
 */

import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  ContentBlock,
  SystemBlock,
} from '../types/canonical.js';

const CHARS_PER_TOKEN = 4;

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'tool_use':
      return estimateTextTokens(block.name + JSON.stringify(block.input ?? {}));
    case 'tool_result': {
      if (typeof block.content === 'string') return estimateTextTokens(block.content);
      return block.content.reduce((sum, c) => sum + estimateContentBlockTokens(c), 0);
    }
    case 'image':
      // ~1300 tokens for a typical image (Anthropic's published rate-of-thumb).
      return 1300;
    default:
      return 0;
  }
}

export function estimateMessageTokens(msg: CanonicalMessage): number {
  if (typeof msg.content === 'string') return estimateTextTokens(msg.content);
  return msg.content.reduce((sum, c) => sum + estimateContentBlockTokens(c), 0);
}

export function estimateSystemTokens(system: CanonicalRequest['system']): number {
  if (!system) return 0;
  if (typeof system === 'string') return estimateTextTokens(system);
  return system.reduce((sum: number, b: SystemBlock) => sum + estimateTextTokens(b.text), 0);
}

export function estimateToolTokens(tools: CanonicalTool[] | undefined): number {
  if (!tools?.length) return 0;
  return tools.reduce(
    (sum, t) =>
      sum + estimateTextTokens(t.name + (t.description ?? '') + JSON.stringify(t.inputSchema ?? {})),
    0,
  );
}

export function estimateRequestTokens(req: CanonicalRequest): number {
  return (
    estimateSystemTokens(req.system) +
    estimateToolTokens(req.tools) +
    req.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  );
}

/**
 * Per-model context window. Conservative defaults; modules can override.
 */
export function getModelContextSize(model: string): number {
  if (model.startsWith('claude-')) return 200_000;
  if (model.startsWith('gpt-4o') || model.startsWith('gpt-4-turbo')) return 128_000;
  if (model.startsWith('gpt-4')) return 8_192;
  if (model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 200_000;
  if (model.startsWith('gemini-1.5')) return 1_000_000;
  if (model.startsWith('gemini-2')) return 2_000_000;
  if (model.startsWith('llama-3')) return 128_000;
  return 32_000;
}
