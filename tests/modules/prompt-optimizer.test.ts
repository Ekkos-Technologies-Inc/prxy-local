import { describe, expect, it } from 'vitest';

import { promptOptimizer } from '../../src/modules/prompt-optimizer.js';
import { makeContext, makeRequest } from '../_helpers.js';

describe('promptOptimizer', () => {
  it('reports name + version', () => {
    const mod = promptOptimizer();
    expect(mod.name).toBe('prompt-optimizer');
    expect(mod.version).toBe('1.0.0');
  });

  it('off mode does nothing', async () => {
    const mod = promptOptimizer({ cacheControl: 'off' });
    const ctx = makeContext(
      makeRequest({
        system: 'a'.repeat(2048),
        tools: [
          { name: 'b_tool', description: '', inputSchema: {} },
          { name: 'a_tool', description: '', inputSchema: {} },
        ],
      }),
    );
    await mod.pre!(ctx);
    expect(ctx.request.tools?.[0].name).toBe('b_tool');
    expect(typeof ctx.request.system).toBe('string');
    expect(ctx.metadata.get('prompt-optimizer.applied')).toBe(false);
  });

  it('sorts tools alphabetically for stable cache prefix', async () => {
    const mod = promptOptimizer();
    const ctx = makeContext(
      makeRequest({
        tools: [
          { name: 'zebra', description: '', inputSchema: {} },
          { name: 'apple', description: '', inputSchema: {} },
          { name: 'mango', description: '', inputSchema: {} },
        ],
      }),
    );
    await mod.pre!(ctx);
    expect(ctx.request.tools!.map((t) => t.name)).toEqual(['apple', 'mango', 'zebra']);
    expect(ctx.metadata.get('prompt-optimizer.applied')).toBe(true);
  });

  it('lifts string system to a SystemBlock with cache marker when long enough', async () => {
    const mod = promptOptimizer({ minCacheableChars: 10 });
    const ctx = makeContext(makeRequest({ system: 'this is a system prompt long enough' }));
    await mod.pre!(ctx);
    expect(Array.isArray(ctx.request.system)).toBe(true);
    const blocks = ctx.request.system as Array<{ text: string; cacheControl?: { type: string } }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('marks the LAST system block when an array is provided', async () => {
    const mod = promptOptimizer({ minCacheableChars: 10 });
    const ctx = makeContext(
      makeRequest({
        system: [
          { type: 'text', text: 'first chunk of static prompt' },
          { type: 'text', text: 'second chunk of static prompt' },
        ],
      }),
    );
    await mod.pre!(ctx);
    const blocks = ctx.request.system as Array<{ cacheControl?: { type: string } }>;
    expect(blocks[0].cacheControl).toBeUndefined();
    expect(blocks[1].cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('skips marking system below minCacheableChars threshold', async () => {
    const mod = promptOptimizer({ minCacheableChars: 1024 });
    const ctx = makeContext(makeRequest({ system: 'short' }));
    await mod.pre!(ctx);
    expect(ctx.request.system).toBe('short');
  });

  it('records the assistant breakpoint index when markAssistantHistory is on', async () => {
    const mod = promptOptimizer({
      minCacheableChars: 10_000,
      markAssistantHistory: true,
    });
    const ctx = makeContext(
      makeRequest({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'next' },
          { role: 'assistant', content: 'sure' },
          { role: 'user', content: 'go' },
        ],
      }),
    );
    await mod.pre!(ctx);
    expect(ctx.metadata.get('prompt-optimizer.assistant_breakpoint_index')).toBe(3);
  });
});
