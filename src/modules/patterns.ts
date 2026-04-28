/**
 * patterns — basic Golden Loop.
 *   - Pre: vector search the `patterns` table for relevant past patterns,
 *     inject the top N into the system prompt.
 *   - Post: scan the conversation for "the issue was X, the fix is Y" markers
 *     and forge new patterns from them.
 */

import { getEmbedding } from '../lib/embed.js';
import {
  findLastUserMessage,
  injectIntoSystem,
  responseToText,
} from '../lib/messages.js';
import type { CanonicalRequest, CanonicalResponse } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface PatternsConfig {
  /** Max patterns to inject. Default 5. */
  maxInjected?: number;
  /** Min similarity score for retrieval. Default 0.7. */
  minScore?: number;
  /** Min historical success rate to inject. Default 0.6. */
  minSuccessRate?: number;
  /** Table name. Default 'patterns'. */
  table?: string;
}

interface PatternRow {
  id?: string;
  title?: string;
  problem: string;
  solution: string;
  tags?: string[];
  success_rate?: number;
  user_id?: string;
}

export function patterns(config: PatternsConfig = {}): Module {
  const maxInjected = config.maxInjected ?? 5;
  const minScore = config.minScore ?? 0.7;
  const minSuccess = config.minSuccessRate ?? 0.6;
  const table = config.table ?? 'patterns';

  return {
    name: 'patterns',
    version: '1.0.0',

    async pre(ctx) {
      const query = findLastUserMessage(ctx.request.messages);
      if (!query.trim()) return { continue: true };

      const queryEmbed = await getEmbedding(query, ctx.storage);

      const matches = await ctx.storage.db
        .from(table)
        .vectorSearch('embedding', queryEmbed, { limit: maxInjected, minScore });

      const relevant = matches
        .map((m) => m.data as PatternRow)
        .filter((p) => (p.success_rate ?? 1) >= minSuccess);

      if (relevant.length === 0) {
        ctx.metadata.set('patterns.injected', []);
        return { continue: true };
      }

      const injection = formatPatternsForPrompt(relevant);
      ctx.request.system = injectIntoSystem(ctx.request.system, injection);
      ctx.metadata.set(
        'patterns.injected',
        relevant.map((p) => p.id ?? p.title ?? '<unknown>'),
      );
      return { continue: true };
    },

    async post(ctx) {
      if (ctx.response.stopReason === 'error') return;
      const detected = detectPatternFromConversation(ctx.request, ctx.response);
      if (!detected) return;

      try {
        const embedding = await getEmbedding(detected.problem, ctx.storage);
        await ctx.storage.db.from(table).insert({
          ...detected,
          user_id: ctx.apiKey.userId,
          embedding,
          success_rate: 1.0,
          applied_count: 0,
          created_at: Date.now(),
        });
        ctx.metadata.set('patterns.forged', detected.title);
      } catch (err) {
        ctx.logger.warn('patterns.post forge failed', err);
      }
    },
  };
}

function formatPatternsForPrompt(patterns: PatternRow[]): string {
  const lines = ['## Relevant past patterns (auto-injected)'];
  for (const p of patterns) {
    lines.push(`\n### ${p.title ?? 'Untitled pattern'}`);
    lines.push(`- Problem: ${p.problem}`);
    lines.push(`- Solution: ${p.solution}`);
    if (p.tags?.length) lines.push(`- Tags: ${p.tags.join(', ')}`);
  }
  return lines.join('\n');
}

const FIX_PATTERNS: RegExp[] = [
  /the (?:issue|problem|bug) (?:was|is)\s+([^.\n]+?)[.\n].*?(?:the )?fix(?:ed it| is| was)\s+(?:by\s+)?([^.\n]+)/is,
  /turns out\s+([^.\n]+?)[.\n].*?(?:so I|so we|fixed by|fix is)\s+([^.\n]+)/is,
  /root cause:\s+([^.\n]+?)[.\n].*?(?:fix|solution):\s+([^.\n]+)/is,
];

interface DetectedPattern {
  title: string;
  problem: string;
  solution: string;
  tags?: string[];
}

export function detectPatternFromConversation(
  request: CanonicalRequest,
  response: CanonicalResponse,
): DetectedPattern | null {
  const text = responseToText(response);
  if (!text || text.length < 40) return null;

  for (const re of FIX_PATTERNS) {
    const match = re.exec(text);
    if (match) {
      const problem = match[1].trim();
      const solution = match[2].trim();
      if (!problem || !solution) continue;
      const userQuery = findLastUserMessage(request.messages);
      const title = userQuery.split('\n')[0].slice(0, 80) || problem.slice(0, 80);
      return { title, problem, solution };
    }
  }
  return null;
}
