import { describe, expect, it } from 'vitest';

import { mcpOptimizer } from '../../src/modules/mcp-optimizer.js';
import type { CanonicalTool } from '../../src/types/canonical.js';
import { FakeStorage, makeContext, makeRequest } from '../_helpers.js';

const tools: CanonicalTool[] = [
  { name: 'send_email', description: 'Send an email to a recipient', inputSchema: {} },
  { name: 'read_file', description: 'Read a file from disk', inputSchema: {} },
  { name: 'write_file', description: 'Write a file to disk', inputSchema: {} },
  { name: 'browser_screenshot', description: 'Take a screenshot of a webpage', inputSchema: {} },
  { name: 'database_query', description: 'Run a SQL query', inputSchema: {} },
  { name: 'unrelated_thing', description: 'Some unrelated function', inputSchema: {} },
];

describe('mcp-optimizer', () => {
  it('skips when below the min-tools threshold', async () => {
    const storage = new FakeStorage();
    const mod = mcpOptimizer({ minToolsToOptimize: 10, forceStubEmbedding: true });
    const ctx = makeContext(
      makeRequest({
        tools,
        messages: [{ role: 'user', content: 'send a message' }],
      }),
      storage,
    );
    await mod.pre!(ctx);
    expect(ctx.metadata.get('mcp.skipped')).toBe('below-min');
    expect(ctx.request.tools?.length).toBe(tools.length);
  });

  it('records before/after tool counts', async () => {
    const storage = new FakeStorage();
    const mod = mcpOptimizer({
      minToolsToOptimize: 1,
      relevanceThreshold: 0.0,
      forceStubEmbedding: true,
    });
    const ctx = makeContext(
      makeRequest({
        tools,
        messages: [{ role: 'user', content: 'I want to read a file' }],
      }),
      storage,
    );
    await mod.pre!(ctx);
    expect(typeof ctx.metadata.get('mcp.tools.before')).toBe('number');
    expect(typeof ctx.metadata.get('mcp.tools.after')).toBe('number');
  });

  it('always keeps at least one tool', async () => {
    const storage = new FakeStorage();
    // Threshold above any plausible cosine value forces empty kept-list, then
    // the always-keep-one fallback should kick in.
    const mod = mcpOptimizer({
      minToolsToOptimize: 1,
      relevanceThreshold: 1.5,
      forceStubEmbedding: true,
    });
    const ctx = makeContext(
      makeRequest({
        tools,
        messages: [{ role: 'user', content: 'totally unrelated query' }],
      }),
      storage,
    );
    await mod.pre!(ctx);
    expect(ctx.request.tools?.length).toBeGreaterThanOrEqual(1);
  });

  it('respects preserveTools', async () => {
    const storage = new FakeStorage();
    const mod = mcpOptimizer({
      minToolsToOptimize: 1,
      relevanceThreshold: 1.5,
      preserveTools: ['database_query'],
      forceStubEmbedding: true,
    });
    const ctx = makeContext(
      makeRequest({
        tools,
        messages: [{ role: 'user', content: 'totally unrelated query' }],
      }),
      storage,
    );
    await mod.pre!(ctx);
    const names = (ctx.request.tools ?? []).map((t) => t.name);
    expect(names).toContain('database_query');
  });
});
