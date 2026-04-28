/**
 * mcp-optimizer — prune MCP tools to the ones actually relevant to the user's
 * last message. The 67k-tokens-of-MCP-tools problem.
 *
 * Strategy: embed each tool's name + description, embed the user's last
 * message, score by cosine similarity, drop tools below threshold (unless
 * preserved). Tool embeddings are KV-cached by content hash so this is cheap
 * after warmup.
 */

import { cosineSimilarity, getEmbedding } from '../lib/embed.js';
import { findLastUserMessage } from '../lib/messages.js';
import { estimateToolTokens } from '../lib/tokens.js';
import type { CanonicalTool } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface McpOptimizerConfig {
  /** Min cosine similarity for a tool to be kept. Default 0.6. */
  relevanceThreshold?: number;
  /** Tool names that are always kept regardless of score. */
  preserveTools?: string[];
  /** Skip optimization if there are fewer than this many tools. Default 5. */
  minToolsToOptimize?: number;
  /** Force-bypass embedding (use stub) — escape hatch for offline. */
  forceStubEmbedding?: boolean;
}

export function mcpOptimizer(config: McpOptimizerConfig = {}): Module {
  const threshold = config.relevanceThreshold ?? 0.6;
  const preserve = new Set(config.preserveTools ?? []);
  const minTools = config.minToolsToOptimize ?? 5;

  return {
    name: 'mcp-optimizer',
    version: '1.0.0',

    async pre(ctx) {
      const tools = ctx.request.tools ?? [];
      if (tools.length < minTools) {
        ctx.metadata.set('mcp.skipped', 'below-min');
        return { continue: true };
      }

      const lastUserMsg = findLastUserMessage(ctx.request.messages);
      if (!lastUserMsg.trim()) {
        ctx.metadata.set('mcp.skipped', 'no-user-message');
        return { continue: true };
      }

      const queryEmbed = await getEmbedding(lastUserMsg, ctx.storage, {
        provider: config.forceStubEmbedding ? 'stub' : undefined,
      });

      const scored = await Promise.all(
        tools.map(async (tool) => {
          const toolText = `${tool.name}: ${tool.description ?? ''}`;
          const toolEmbed = await getEmbedding(toolText, ctx.storage, {
            provider: config.forceStubEmbedding ? 'stub' : undefined,
          });
          return { tool, score: cosineSimilarity(queryEmbed, toolEmbed) };
        }),
      );

      const kept: CanonicalTool[] = scored
        .filter((s) => s.score >= threshold || preserve.has(s.tool.name))
        .map((s) => s.tool);

      // Always keep at least one tool — degenerate case where everything scored
      // low would make tool-using requests fail. Keep the highest-scoring one.
      if (kept.length === 0 && scored.length > 0) {
        const top = scored.reduce((a, b) => (a.score >= b.score ? a : b));
        kept.push(top.tool);
      }

      const before = tools.length;
      const tokensBefore = estimateToolTokens(tools);
      const tokensAfter = estimateToolTokens(kept);

      ctx.metadata.set('mcp.tools.before', before);
      ctx.metadata.set('mcp.tools.after', kept.length);
      ctx.metadata.set('mcp.tokens.saved', tokensBefore - tokensAfter);

      ctx.request.tools = kept;
      return { continue: true };
    },
  };
}
