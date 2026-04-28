import { describe, expect, it } from 'vitest';

import { stubEmbed } from '../../src/lib/embed.js';
import { semanticCache } from '../../src/modules/semantic-cache.js';
import { FakeStorage, makeContext, makeRequest, makeResponseContext } from '../_helpers.js';

describe('semantic-cache', () => {
  it('writes embedding + response on post when no hit', async () => {
    const storage = new FakeStorage();
    const mod = semanticCache({ similarity: 0.9 });
    const req = makeRequest();
    const ctx = makeContext(req, storage);
    const r = await mod.pre!(ctx);
    expect(r.continue).toBe(true);
    expect(ctx.metadata.get('cache.semantic.hit')).toBe(false);

    const respCtx = makeResponseContext(req, undefined, storage);
    respCtx.metadata = ctx.metadata;
    await mod.post!(respCtx);

    const rows = storage.db.rows('semantic_cache');
    expect(rows.length).toBe(1);
    expect(Array.isArray(rows[0].embedding)).toBe(true);
  });

  it('hits on a near-identical query', async () => {
    const storage = new FakeStorage();
    // Pre-seed with a known embedding so we don't depend on stub vector quality.
    const fakeResp = JSON.stringify({
      id: 'msg_cached',
      model: 'claude-sonnet-4',
      role: 'assistant',
      content: [{ type: 'text', text: 'cached' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const embed = stubEmbed('user: hello world');
    storage.db.rows('semantic_cache').push({
      embedding: embed,
      response: fakeResp,
      model: 'claude-sonnet-4',
      created_at: Date.now(),
    });

    const mod = semanticCache({ similarity: 0.5 });
    const req = makeRequest({
      messages: [{ role: 'user', content: 'hello world' }],
    });
    const ctx = makeContext(req, storage);
    const r = await mod.pre!(ctx);
    expect(r.continue).toBe(false);
    if (!r.continue) {
      expect(r.response.id).toBe('msg_cached');
    }
  });
});
