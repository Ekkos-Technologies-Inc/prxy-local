import { describe, expect, it } from 'vitest';

import {
  compactionBridge,
  scoreCompaction,
} from '../../src/modules/compaction-bridge.js';
import type { CanonicalMessage } from '../../src/types/canonical.js';
import { FakeStorage, makeContext, makeRequest } from '../_helpers.js';

function archiveBlob(messages: CanonicalMessage[], evictedAt = Date.now()): string {
  return JSON.stringify({ messages, evictedAt });
}

describe('scoreCompaction', () => {
  it('scores a normal multi-turn conversation low', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'How are you' },
      { role: 'assistant', content: 'Good' },
      { role: 'user', content: 'Tell me about Python' },
    ];
    expect(scoreCompaction(messages, undefined)).toBeLessThan(0.6);
  });

  it('scores a short request with a continuation marker high', () => {
    const messages: CanonicalMessage[] = [
      {
        role: 'user',
        content: 'Continuing from where we left off, finish the implementation',
      },
    ];
    expect(scoreCompaction(messages, undefined)).toBeGreaterThanOrEqual(0.6);
  });

  it('scores a short prompt with file references + short system high', () => {
    const messages: CanonicalMessage[] = [
      { role: 'user', content: 'Apply the fix to apps/proxy/src/gateway.ts' },
    ];
    expect(scoreCompaction(messages, 'You are an assistant.')).toBeGreaterThanOrEqual(0.6);
  });
});

describe('compaction-bridge module', () => {
  it('is a no-op when confidence is below threshold', async () => {
    const mod = compactionBridge();
    const storage = new FakeStorage();
    await storage.blob.put(
      'evictions/test-user/1700000000000-0.json',
      archiveBlob([{ role: 'user', content: 'past stuff' }]),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
          { role: 'assistant', content: 'd' },
          { role: 'user', content: 'fresh question' },
        ],
      }),
      storage,
    );
    await mod.pre!(ctx);
    expect(ctx.metadata.get('compaction-bridge.recovered')).toBe(false);
    expect(ctx.request.system).toBeUndefined();
  });

  it('is a no-op when no eviction archives exist', async () => {
    const mod = compactionBridge();
    const ctx = makeContext(
      makeRequest({
        messages: [
          {
            role: 'user',
            content: 'continuing from where we left off, ship the patch',
          },
        ],
      }),
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.metadata.get('compaction-bridge.recovered')).toBe(false);
  });

  it('does not throw when blob.list throws', async () => {
    const mod = compactionBridge();
    const storage = new FakeStorage();
    storage.blob.list = async () => {
      throw new Error('R2 outage');
    };
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'continuing from where we left off' }],
      }),
      storage,
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.metadata.get('compaction-bridge.recovered')).toBe(false);
  });

  it('recovers state and injects a recovery block when detection fires', async () => {
    const mod = compactionBridge();
    const storage = new FakeStorage();

    const archived: CanonicalMessage[] = [
      { role: 'user', content: 'Edit packages/web/src/page.tsx to fix the loading state.' },
      {
        role: 'assistant',
        content: 'The issue was a missing await. The fix is to add await before fetch().',
      },
      { role: 'user', content: 'Always use semicolons. Never use var.' },
    ];

    await storage.blob.put(
      `evictions/test-user/${Date.now() - 60_000}-0.json`,
      archiveBlob(archived),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [
          { role: 'user', content: 'continuing from where we left off, what is the next step?' },
        ],
      }),
      storage,
    );
    await mod.pre!(ctx);

    expect(ctx.metadata.get('compaction-bridge.recovered')).toBe(true);
    expect(ctx.metadata.get('compaction-bridge.turns_restored')).toBeGreaterThan(0);
    const sys = ctx.request.system as string;
    expect(sys).toContain('compaction-bridge-recovery');
    expect(sys).toContain('packages/web/src/page.tsx');
    expect(sys).toContain('Recent decisions:');
    expect(sys).toContain('User directives:');
  });

  it('honors preserveActiveFiles=false', async () => {
    const mod = compactionBridge({ preserveActiveFiles: false });
    const storage = new FakeStorage();
    await storage.blob.put(
      `evictions/test-user/${Date.now()}-0.json`,
      archiveBlob([
        { role: 'user', content: 'edit src/foo.ts please' },
      ]),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'continuing from where we left off' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    const sys = (ctx.request.system as string) ?? '';
    expect(sys).not.toContain('Active files:');
    expect(ctx.metadata.get('compaction-bridge.files_restored')).toBe(0);
  });

  it('honors preserveDirectives=false', async () => {
    const mod = compactionBridge({ preserveDirectives: false });
    const storage = new FakeStorage();
    await storage.blob.put(
      `evictions/test-user/${Date.now()}-0.json`,
      archiveBlob([
        { role: 'user', content: 'always use TypeScript strict mode' },
      ]),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'continuing from where we left off' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    const sys = (ctx.request.system as string) ?? '';
    expect(sys).not.toContain('User directives:');
    expect(ctx.metadata.get('compaction-bridge.directives_restored')).toBe(0);
  });

  it('handles malformed archive JSON without throwing', async () => {
    const mod = compactionBridge();
    const storage = new FakeStorage();
    await storage.blob.put('evictions/test-user/1700000000000-0.json', '{not json');

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'continuing from where we left off' }],
      }),
      storage,
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.metadata.get('compaction-bridge.recovered')).toBe(false);
  });

  it('does not collide with patterns or rehydrator metadata keys', async () => {
    const mod = compactionBridge();
    const storage = new FakeStorage();
    await storage.blob.put(
      `evictions/test-user/${Date.now()}-0.json`,
      archiveBlob([{ role: 'user', content: 'past' }]),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'continuing from where we left off' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    for (const key of ctx.metadata.keys()) {
      expect(key.startsWith('patterns.')).toBe(false);
      expect(key.startsWith('rehydrator.')).toBe(false);
    }
  });

  it('restores at most preserveLastTurns turns', async () => {
    const mod = compactionBridge({ preserveLastTurns: 2 });
    const storage = new FakeStorage();

    const archived: CanonicalMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `message ${i}`,
    }));
    await storage.blob.put(
      `evictions/test-user/${Date.now()}-0.json`,
      archiveBlob(archived),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'continuing from where we left off' }],
      }),
      storage,
    );
    await mod.pre!(ctx);
    expect(ctx.metadata.get('compaction-bridge.turns_restored')).toBe(2);
  });
});
