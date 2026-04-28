/**
 * Helpers to extract / serialize bits of a CanonicalRequest.
 */

import type {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  ContentBlock,
} from '../types/canonical.js';

export function findLastUserMessage(messages: CanonicalMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    return contentToText(m.content);
  }
  return '';
}

export function contentToText(content: CanonicalMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b: ContentBlock) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[tool_use:${b.name}]`;
      if (b.type === 'tool_result') {
        return typeof b.content === 'string' ? b.content : contentToText(b.content);
      }
      if (b.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function responseToText(response: CanonicalResponse): string {
  return response.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Stable canonical serialization for hashing or embedding. We exclude the
 * `stream` flag (the response is the same either way) and ignore order of
 * keys outside `messages` so two semantically identical requests hash equal.
 */
export function serializeRequestStable(req: CanonicalRequest): string {
  const norm = {
    model: req.model,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
    topP: req.topP,
    topK: req.topK,
    stopSequences: req.stopSequences,
    system: req.system,
    tools: req.tools,
    messages: req.messages,
  };
  return JSON.stringify(norm, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of sortedKeys) out[k] = (value as Record<string, unknown>)[k];
    return out;
  }
  return value;
}

/**
 * Compact representation suitable for semantic embedding. Strips system and
 * tools (those are usually noise relative to the user's question) and joins
 * the message stream.
 */
export function serializeForSemantic(req: CanonicalRequest): string {
  return req.messages.map((m) => `${m.role}: ${contentToText(m.content)}`).join('\n\n');
}

/**
 * Insert a text snippet into the system prompt. If system is missing it
 * becomes the new system. If it's a string we prepend with a separator. If
 * it's a SystemBlock array we add a new block at the front.
 */
export function injectIntoSystem(
  system: CanonicalRequest['system'],
  injection: string,
): CanonicalRequest['system'] {
  if (!system) return injection;
  if (typeof system === 'string') return `${injection}\n\n---\n\n${system}`;
  return [{ type: 'text', text: injection }, ...system];
}
