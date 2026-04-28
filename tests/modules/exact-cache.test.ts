import { describe, expect, it } from 'vitest';

import { exactCache } from '../../src/modules/exact-cache.js';
import { FakeStorage, makeContext, makeRequest, makeResponseContext } from '../_helpers.js';

describe('exact-cache', () => {
  it('misses on first request, hits on identical second', async () => {
    const storage = new FakeStorage();
    const mod = exactCache({ ttlSeconds: 60 });

    const req = makeRequest();
    const ctx1 = makeContext(req, storage);
    const r1 = await mod.pre!(ctx1);
    expect(r1.continue).toBe(true);
    expect(ctx1.metadata.get('cache.exact.hit')).toBe(false);

    // Simulate provider returning a response, then post-cache it.
    const respCtx = makeResponseContext(req, undefined, storage);
    respCtx.metadata = ctx1.metadata;
    await mod.post!(respCtx);

    // Second identical request should hit.
    const ctx2 = makeContext(req, storage);
    const r2 = await mod.pre!(ctx2);
    expect(r2.continue).toBe(false);
    expect(ctx2.metadata.get('cache.exact.hit')).toBe(true);
  });

  it('does not cache error responses', async () => {
    const storage = new FakeStorage();
    const mod = exactCache();
    const ctx = makeContext(makeRequest(), storage);
    await mod.pre!(ctx);

    const respCtx = makeResponseContext();
    respCtx.metadata = ctx.metadata;
    respCtx.storage = storage;
    respCtx.response.stopReason = 'error';
    await mod.post!(respCtx);

    const key = ctx.metadata.get('cache.exact.key') as string;
    expect(await storage.kv.get(key)).toBeNull();
  });
});
