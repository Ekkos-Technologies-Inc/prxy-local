import { describe, expect, it } from 'vitest';

import { compressMessages, ipc } from '../../src/modules/ipc.js';
import { makeContext, makeRequest } from '../_helpers.js';

describe('compressMessages', () => {
  it('does nothing when message count is below keep threshold', () => {
    const msgs = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ];
    expect(compressMessages(msgs, 6)).toEqual(msgs);
  });

  it('keeps the last N messages and replaces older ones with a summary', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message body number ${i}.`,
    }));
    const out = compressMessages(msgs, 4);
    expect(out.length).toBe(5); // 1 summary + 4 recent
    const summaryText = Array.isArray(out[0].content)
      ? (out[0].content[0] as { type: 'text'; text: string }).text
      : out[0].content;
    expect(summaryText).toContain('earlier-conversation-summary');
    expect(out.slice(1)).toEqual(msgs.slice(-4));
  });
});

describe('ipc module', () => {
  it('does nothing when request is below target utilization', async () => {
    const mod = ipc({ contextSize: 100_000, targetUtilization: 0.75 });
    const ctx = makeContext(
      makeRequest({ messages: [{ role: 'user', content: 'short' }] }),
    );
    const before = ctx.request.messages.length;
    await mod.pre!(ctx);
    expect(ctx.request.messages.length).toBe(before);
    expect(ctx.metadata.get('ipc.compressed')).toBeUndefined();
  });

  it('compresses when request exceeds target utilization', async () => {
    const mod = ipc({ contextSize: 200, targetUtilization: 0.5, keepRecent: 2 });
    const long = (i: number) =>
      `Message ${i}. ` +
      'This is a much longer message body packed with extra context detail that will be dropped when the summary keeps only the first sentence. '.repeat(
        4,
      );
    const huge = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: long(i),
    }));
    const ctx = makeContext(makeRequest({ messages: huge }));
    await mod.pre!(ctx);
    expect(ctx.request.messages.length).toBe(3); // 1 summary + 2 recent
    expect(ctx.metadata.get('ipc.compressed')).toBe(true);
    expect(ctx.metadata.get('ipc.tokens.saved')).toBeGreaterThan(0);
  });

  it('records before/after metadata', async () => {
    const mod = ipc({ contextSize: 100_000 });
    const ctx = makeContext();
    await mod.pre!(ctx);
    expect(typeof ctx.metadata.get('ipc.tokens.before')).toBe('number');
    expect(typeof ctx.metadata.get('ipc.target')).toBe('number');
  });
});
