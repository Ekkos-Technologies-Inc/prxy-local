/**
 * ipc — Inter-Prompt Compression (basic).
 *
 * If the request is over the target utilization of the model's context window,
 * keep the last N turns verbatim and replace older messages with a single
 * summary message.
 */

import { contentToText } from '../lib/messages.js';
import {
  estimateMessageTokens,
  estimateRequestTokens,
  getModelContextSize,
} from '../lib/tokens.js';
import type { CanonicalMessage } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface IpcConfig {
  /** Compress when request fills more than this fraction of context. Default 0.75. */
  targetUtilization?: number;
  /** Always keep this many most-recent messages verbatim. Default 6. */
  keepRecent?: number;
  /** Override the context window size detection. */
  contextSize?: number;
}

export function ipc(config: IpcConfig = {}): Module {
  const targetUtilization = config.targetUtilization ?? 0.75;
  const keepRecent = config.keepRecent ?? 6;

  return {
    name: 'ipc',
    version: '1.0.0',

    async pre(ctx) {
      const contextSize = config.contextSize ?? getModelContextSize(ctx.request.model);
      const before = estimateRequestTokens(ctx.request);
      const target = Math.floor(contextSize * targetUtilization);

      ctx.metadata.set('ipc.tokens.before', before);
      ctx.metadata.set('ipc.target', target);

      if (before <= target) return { continue: true };

      const compressed = compressMessages(ctx.request.messages, keepRecent);
      ctx.request.messages = compressed;

      const after = estimateRequestTokens(ctx.request);
      ctx.metadata.set('ipc.tokens.after', after);
      ctx.metadata.set('ipc.tokens.saved', before - after);
      ctx.metadata.set('ipc.compressed', true);

      return { continue: true };
    },
  };
}

/**
 * Strategy: keep the last `keepRecent` messages, summarize all earlier
 * messages into a single "earlier conversation summary" message. The summary
 * is purely extractive (first sentence per turn).
 */
export function compressMessages(
  messages: CanonicalMessage[],
  keepRecent: number,
): CanonicalMessage[] {
  if (messages.length <= keepRecent) return messages;

  const earlier = messages.slice(0, messages.length - keepRecent);
  const recent = messages.slice(messages.length - keepRecent);

  const summary = summarize(earlier);
  if (!summary) return recent;

  const summaryMsg: CanonicalMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          '<earlier-conversation-summary>\n' +
          summary +
          '\n</earlier-conversation-summary>',
      },
    ],
  };

  return [summaryMsg, ...recent];
}

function summarize(messages: CanonicalMessage[]): string {
  if (messages.length === 0) return '';
  const lines: string[] = [];
  let totalTokens = 0;
  for (const m of messages) {
    const text = contentToText(m.content).trim();
    if (!text) continue;
    const firstSentence = extractFirstSentence(text);
    const line = `- ${m.role}: ${firstSentence}`;
    lines.push(line);
    totalTokens += estimateMessageTokens({ role: m.role, content: firstSentence });
    if (totalTokens > 2000) {
      lines.push('- [... older context truncated]');
      break;
    }
  }
  return lines.join('\n');
}

function extractFirstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = /^.{1,200}?[.!?](?:\s|$)/.exec(cleaned);
  if (match) return match[0].trim();
  return cleaned.slice(0, 200);
}
