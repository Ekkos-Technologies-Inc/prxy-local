import { describe, expect, it } from 'vitest';

import { costGuard } from '../../src/modules/cost-guard.js';
import { FakeStorage, makeContext, makeRequest, makeResponseContext } from '../_helpers.js';

describe('cost-guard', () => {
  it('lets requests through under the per-request cap', async () => {
    const storage = new FakeStorage();
    const mod = costGuard({ perRequest: 1.0 });
    const ctx = makeContext(makeRequest(), storage);
    const r = await mod.pre!(ctx);
    expect(r.continue).toBe(true);
    expect(typeof ctx.metadata.get('cost.estimated')).toBe('number');
  });

  it('blocks a request that exceeds the per-request cap', async () => {
    const storage = new FakeStorage();
    const mod = costGuard({ perRequest: 0.0000001 });
    // Tiny limit forces the block.
    const ctx = makeContext(
      makeRequest({ model: 'claude-opus-4', maxTokens: 4096 }),
      storage,
    );
    const r = await mod.pre!(ctx);
    expect(r.continue).toBe(false);
    if (!r.continue) {
      expect(r.response.stopReason).toBe('error');
      const text = (r.response.content[0] as { text: string }).text;
      expect(text).toContain('cost_limit_per_request');
    }
  });

  it('post() increments the day bucket on success', async () => {
    const storage = new FakeStorage();
    const mod = costGuard({ perDay: 100 });
    const ctx = makeContext(makeRequest(), storage);
    await mod.pre!(ctx);
    const respCtx = makeResponseContext(ctx.request, undefined, storage);
    respCtx.metadata = ctx.metadata;
    await mod.post!(respCtx);

    // The day bucket key should now be in KV.
    const keys = [...(storage.kv as unknown as { store: Map<string, unknown> }).store.keys()];
    expect(keys.some((k) => k.startsWith('cost:spend:'))).toBe(true);
  });
});
