/**
 * semantic-cache — embed the request, vector-search for similar past requests,
 * return their cached response if similarity is high enough.
 *
 * Backed by `storage.db.from('semantic_cache').vectorSearch(...)`. The local
 * adapter implements vector search via sqlite-vec (or falls back to a JS
 * cosine scan if sqlite-vec isn't available).
 */

import { getEmbedding } from '../lib/embed.js';
import { serializeForSemantic } from '../lib/messages.js';
import type { CanonicalResponse } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface SemanticCacheConfig {
  /** Min cosine similarity to consider a hit. Default 0.92. */
  similarity?: number;
  /** Cache lifetime in seconds. Default 1 hour. */
  ttlSeconds?: number;
  /** DB table name. Default 'semantic_cache'. */
  table?: string;
}

interface SemanticCacheRow {
  response: string;
  model: string;
  created_at: number;
}

export function semanticCache(config: SemanticCacheConfig = {}): Module {
  const similarity = config.similarity ?? 0.92;
  const ttl = config.ttlSeconds ?? 3600;
  const table = config.table ?? 'semantic_cache';

  return {
    name: 'semantic-cache',
    version: '1.0.0',

    async pre(ctx) {
      const query = serializeForSemantic(ctx.request);
      if (!query.trim()) return { continue: true };

      const embedding = await getEmbedding(query, ctx.storage);

      const matches = await ctx.storage.db
        .from(table)
        .vectorSearch('embedding', embedding, { limit: 1, minScore: similarity });

      const hit = matches[0];
      if (hit) {
        try {
          const row = hit.data as SemanticCacheRow;
          // Respect TTL — drop stale rows on read.
          if (row.created_at && Date.now() - row.created_at > ttl * 1000) {
            ctx.metadata.set('cache.semantic.hit', false);
            ctx.metadata.set('cache.semantic.embedding', embedding);
            return { continue: true };
          }
          const response = JSON.parse(row.response) as CanonicalResponse;
          ctx.logger.info(`semantic-cache HIT score=${hit.score.toFixed(3)}`);
          ctx.metadata.set('cache.semantic.hit', true);
          ctx.metadata.set('cache.semantic.score', hit.score);
          return { continue: false, response };
        } catch {
          // Malformed row — fall through to provider.
        }
      }

      ctx.metadata.set('cache.semantic.hit', false);
      ctx.metadata.set('cache.semantic.embedding', embedding);
      return { continue: true };
    },

    async post(ctx) {
      if (ctx.metadata.get('cache.semantic.hit')) return;
      const embedding = ctx.metadata.get('cache.semantic.embedding') as
        | number[]
        | undefined;
      if (!embedding) return;
      if (ctx.response.stopReason === 'error') return;

      await ctx.storage.db.from(table).insert({
        embedding,
        response: JSON.stringify(ctx.response),
        model: ctx.response.model,
        created_at: Date.now(),
      });
    },
  };
}
