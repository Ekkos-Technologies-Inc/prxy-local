/**
 * rehydrator — pull archived context back when the user references it.
 *
 * Companion to the `ipc` module. When `ipc` compresses older turns it can
 * write the evicted blob to `storage.blob` under
 * `evictions/{user_id}/{ts}-{n}.json`. The rehydrator scans the latest user
 * message for trigger phrases ("remember when…", "earlier we…", "go back to…")
 * and, if any are present, semantically searches those evictions for the most
 * relevant turns and re-injects them into the system prompt.
 *
 * Hard rules:
 *   - If `ipc` isn't producing eviction archives, this is a no-op (never
 *     throws).
 *   - Metadata keys live under `rehydrator.*` so we don't collide with
 *     `patterns.*` keys.
 *   - The injection wraps the recovered turns in a clearly-labeled block so
 *     the model knows it's looking at recovered context, not new user input.
 */

import { cosineSimilarity, getEmbedding } from '../lib/embed.js';
import {
  contentToText,
  findLastUserMessage,
  injectIntoSystem,
} from '../lib/messages.js';
import type { CanonicalMessage } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface RehydratorConfig {
  /** Phrases that indicate the user is asking about earlier context. */
  triggerPhrases?: string[];
  /** Max archived turns to pull back. Default 5. */
  maxRehydrated?: number;
  /** Only consider archives newer than this (in days). Default 90. */
  searchDepthDays?: number;
  /** Min cosine similarity for a candidate turn to be re-injected. Default 0.7. */
  similarityThreshold?: number;
  /** Blob key prefix to scan. Default 'evictions'. */
  blobPrefix?: string;
  /** Hard cap on the number of archive blobs to scan per request. Default 50. */
  maxBlobsScanned?: number;
}

const DEFAULT_TRIGGERS = [
  'remember',
  'earlier',
  'previously',
  'before',
  'last time',
  'we discussed',
  'we were',
];

interface EvictionArchive {
  messages: CanonicalMessage[];
  summary?: string;
  evictedAt?: number;
  userId?: string;
  sessionId?: string;
}

interface ScoredTurn {
  message: CanonicalMessage;
  score: number;
  evictedAt: number;
}

export function rehydrator(config: RehydratorConfig = {}): Module {
  const triggers = (config.triggerPhrases ?? DEFAULT_TRIGGERS).map((p) =>
    p.toLowerCase(),
  );
  const maxRehydrated = config.maxRehydrated ?? 5;
  const searchDepthMs = (config.searchDepthDays ?? 90) * 24 * 60 * 60 * 1000;
  const minScore = config.similarityThreshold ?? 0.7;
  const blobPrefix = config.blobPrefix ?? 'evictions';
  const maxBlobs = config.maxBlobsScanned ?? 50;

  return {
    name: 'rehydrator',
    version: '1.0.0',

    async pre(ctx) {
      ctx.metadata.set('rehydrator.matched', 0);

      const userText = findLastUserMessage(ctx.request.messages);
      if (!userText.trim()) return { continue: true };

      const lower = userText.toLowerCase();
      const matchedTrigger = triggers.find((t) => lower.includes(t));
      if (!matchedTrigger) return { continue: true };

      ctx.metadata.set('rehydrator.trigger', matchedTrigger);

      const userId = ctx.apiKey.userId;
      const prefix = `${blobPrefix}/${userId}/`;

      let keys: string[] = [];
      try {
        keys = await ctx.storage.blob.list(prefix);
      } catch (err) {
        ctx.logger.warn('rehydrator: blob.list failed, skipping', err);
        return { continue: true };
      }
      if (keys.length === 0) return { continue: true };

      keys.sort((a, b) => (a < b ? 1 : -1));
      keys = keys.slice(0, maxBlobs);

      const cutoff = Date.now() - searchDepthMs;
      const queryEmbed = await getEmbedding(userText, ctx.storage);

      const candidates: ScoredTurn[] = [];

      for (const key of keys) {
        let blob: Buffer | null = null;
        try {
          blob = await ctx.storage.blob.get(key);
        } catch (err) {
          ctx.logger.debug('rehydrator: blob.get failed for', key, err);
          continue;
        }
        if (!blob) continue;

        let archive: EvictionArchive | null = null;
        try {
          archive = JSON.parse(blob.toString('utf8')) as EvictionArchive;
        } catch (err) {
          ctx.logger.debug('rehydrator: archive parse failed for', key, err);
          continue;
        }
        if (!archive || !Array.isArray(archive.messages)) continue;

        const evictedAt = archive.evictedAt ?? extractTimestampFromKey(key) ?? 0;
        if (evictedAt > 0 && evictedAt < cutoff) continue;

        for (const msg of archive.messages) {
          const text = contentToText(msg.content).trim();
          if (!text) continue;

          let msgEmbed: number[];
          try {
            msgEmbed = await getEmbedding(text, ctx.storage);
          } catch {
            continue;
          }
          const score = cosineSimilarity(queryEmbed, msgEmbed);
          if (score < minScore) continue;

          candidates.push({ message: msg, score, evictedAt });
        }
      }

      if (candidates.length === 0) {
        ctx.metadata.set('rehydrator.scanned_blobs', keys.length);
        return { continue: true };
      }

      candidates.sort((a, b) => b.score - a.score);
      const picked = candidates.slice(0, maxRehydrated);
      picked.sort((a, b) => a.evictedAt - b.evictedAt);

      const injection = formatRehydratedTurns(picked);
      ctx.request.system = injectIntoSystem(ctx.request.system, injection);

      ctx.metadata.set('rehydrator.matched', picked.length);
      ctx.metadata.set('rehydrator.scanned_blobs', keys.length);
      ctx.metadata.set(
        'rehydrator.scores',
        picked.map((p) => Number(p.score.toFixed(3))),
      );

      return { continue: true };
    },
  };
}

function formatRehydratedTurns(turns: ScoredTurn[]): string {
  const lines: string[] = [];
  lines.push('<rehydrated-context>');
  lines.push('Earlier in this conversation, you discussed:');
  for (const turn of turns) {
    const text = contentToText(turn.message.content).trim();
    if (!text) continue;
    lines.push('');
    lines.push(`- ${turn.message.role}: ${truncate(text, 800)}`);
  }
  lines.push('</rehydrated-context>');
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function extractTimestampFromKey(key: string): number | null {
  const tail = key.split('/').pop() ?? '';
  const match = /^(\d{10,16})/.exec(tail);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  return n;
}
