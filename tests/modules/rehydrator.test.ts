import { describe, expect, it } from 'vitest';

import { rehydrator } from '../../src/modules/rehydrator.js';
import type { CanonicalMessage } from '../../src/types/canonical.js';
import { FakeStorage, makeContext, makeRequest } from '../_helpers.js';

function archiveBlob(messages: CanonicalMessage[], evictedAt = Date.now()): string {
  return JSON.stringify({ messages, evictedAt });
}

describe('rehydrator module', () => {
  it('is a no-op when the user message has no trigger phrase', async () => {
    const mod = rehydrator();
    const storage = new FakeStorage();
    await storage.blob.put(
      'evictions/test-user/1700000000000-0.json',
      archiveBlob([{ role: 'user', content: 'something old' }]),
    );

    const ctx = makeContext(
      makeRequest({ messages: [{ role: 'user', content: 'How do I sort an array?' }] }),
      storage,
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.metadata.get('rehydrator.matched')).toBe(0);
    expect(ctx.metadata.get('rehydrator.trigger')).toBeUndefined();
    expect(ctx.request.system).toBeUndefined();
  });

  it('is a no-op when blob storage is empty (ipc not in pipeline)', async () => {
    const mod = rehydrator();
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'Remember when we talked about caching?' }],
      }),
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.metadata.get('rehydrator.matched')).toBe(0);
  });

  it('does not throw when blob.list throws', async () => {
    const mod = rehydrator();
    const storage = new FakeStorage();
    storage.blob.list = async () => {
      throw new Error('blob backend down');
    };
    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'Remember the issue we hit earlier?' }],
      }),
      storage,
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.metadata.get('rehydrator.matched')).toBe(0);
  });

  it('rehydrates archived turns when a trigger fires and similar content exists', async () => {
    const mod = rehydrator({ similarityThreshold: 0.0, maxRehydrated: 3 });
    const storage = new FakeStorage();

    const archived: CanonicalMessage[] = [
      { role: 'user', content: 'How do I configure semantic-cache TTL settings' },
      { role: 'assistant', content: 'You can set ttlSeconds in the config.' },
    ];
    await storage.blob.put(
      'evictions/test-user/1700000000000-0.json',
      archiveBlob(archived),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'Remember when we were talking about TTL?' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    expect(ctx.metadata.get('rehydrator.trigger')).toBe('remember');
    expect(ctx.metadata.get('rehydrator.matched')).toBeGreaterThan(0);
    const sys = ctx.request.system as string;
    expect(sys).toContain('rehydrated-context');
    expect(sys).toContain('Earlier in this conversation');
  });

  it('skips archives older than searchDepthDays', async () => {
    const mod = rehydrator({ similarityThreshold: 0.0, searchDepthDays: 1 });
    const storage = new FakeStorage();

    const tooOld = Date.now() - 10 * 24 * 60 * 60 * 1000;
    await storage.blob.put(
      `evictions/test-user/${tooOld}-0.json`,
      archiveBlob([{ role: 'user', content: 'ancient context here' }], tooOld),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'remember anything from before?' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    expect(ctx.metadata.get('rehydrator.matched')).toBe(0);
  });

  it('caps the number of injected turns at maxRehydrated', async () => {
    const mod = rehydrator({ similarityThreshold: 0.0, maxRehydrated: 2 });
    const storage = new FakeStorage();

    const many: CanonicalMessage[] = Array.from({ length: 8 }, (_, i) => ({
      role: 'user' as const,
      content: `historical message ${i} about caching configuration`,
    }));
    await storage.blob.put(
      'evictions/test-user/1700000000000-0.json',
      archiveBlob(many),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'remember our caching discussion?' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    expect(ctx.metadata.get('rehydrator.matched')).toBe(2);
  });

  it('does not collide with patterns module metadata keys', async () => {
    const mod = rehydrator({ similarityThreshold: 0.0 });
    const storage = new FakeStorage();
    await storage.blob.put(
      'evictions/test-user/1700000000000-0.json',
      archiveBlob([{ role: 'user', content: 'cache stuff' }]),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'remember our cache discussion?' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    for (const key of ctx.metadata.keys()) {
      expect(key.startsWith('patterns.')).toBe(false);
    }
  });

  it('handles malformed JSON in an archive blob without throwing', async () => {
    const mod = rehydrator({ similarityThreshold: 0.0 });
    const storage = new FakeStorage();
    await storage.blob.put('evictions/test-user/1700000000000-0.json', 'not json');

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'remember the issue?' }],
      }),
      storage,
    );
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.metadata.get('rehydrator.matched')).toBe(0);
  });

  it('respects custom triggerPhrases', async () => {
    const mod = rehydrator({
      triggerPhrases: ['shibboleet'],
      similarityThreshold: 0.0,
    });
    const storage = new FakeStorage();
    await storage.blob.put(
      'evictions/test-user/1700000000000-0.json',
      archiveBlob([{ role: 'user', content: 'historical' }]),
    );

    const ctx1 = makeContext(
      makeRequest({ messages: [{ role: 'user', content: 'remember earlier?' }] }),
      storage,
    );
    await mod.pre!(ctx1);
    expect(ctx1.metadata.get('rehydrator.matched')).toBe(0);

    const ctx2 = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'shibboleet — pull stuff back' }],
      }),
      storage,
    );
    await mod.pre!(ctx2);
    expect(ctx2.metadata.get('rehydrator.trigger')).toBe('shibboleet');
  });

  it('reorders rehydrated turns chronologically by evictedAt', async () => {
    const mod = rehydrator({ similarityThreshold: 0.0, maxRehydrated: 5 });
    const storage = new FakeStorage();

    const t1 = Date.now() - 5 * 60 * 1000;
    const t2 = Date.now() - 2 * 60 * 1000;

    await storage.blob.put(
      `evictions/test-user/${t2}-0.json`,
      archiveBlob([{ role: 'user', content: 'second-in-time message about caching' }], t2),
    );
    await storage.blob.put(
      `evictions/test-user/${t1}-0.json`,
      archiveBlob([{ role: 'user', content: 'first-in-time message about caching' }], t1),
    );

    const ctx = makeContext(
      makeRequest({
        messages: [{ role: 'user', content: 'remember our caching discussion?' }],
      }),
      storage,
    );
    await mod.pre!(ctx);

    const sys = ctx.request.system as string;
    const firstIdx = sys.indexOf('first-in-time');
    const secondIdx = sys.indexOf('second-in-time');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
