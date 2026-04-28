import { describe, expect, it } from 'vitest';

import { router } from '../../src/modules/router.js';
import {
  FakeStorage,
  makeContext,
  makeRequest,
  makeResponse,
  makeResponseContext,
} from '../_helpers.js';

describe('router', () => {
  it('no-op when no chain or prefer is configured', async () => {
    const mod = router();
    const ctx = makeContext(makeRequest({ model: 'claude-sonnet-4' }));
    const result = await mod.pre!(ctx);
    expect(result.continue).toBe(true);
    expect(ctx.request.model).toBe('claude-sonnet-4');
    expect(ctx.metadata.get('router.requested_model')).toBe('claude-sonnet-4');
    expect(ctx.metadata.get('router.selected_model')).toBe('claude-sonnet-4');
  });

  it('cheapest-first picks the cheapest from the chain', async () => {
    const mod = router({
      strategy: 'cheapest-first',
      fallback_chain: ['claude-opus-4', 'gpt-4o-mini', 'claude-sonnet-4'],
    });
    const ctx = makeContext(makeRequest({ model: 'claude-opus-4' }));
    await mod.pre!(ctx);
    expect(ctx.request.model).toBe('gpt-4o-mini');
  });

  it('fallback strategy picks the first model in the chain', async () => {
    const mod = router({
      strategy: 'fallback',
      fallback_chain: ['claude-sonnet-4', 'gpt-4o-mini'],
    });
    const ctx = makeContext(makeRequest({ model: 'claude-opus-4' }));
    await mod.pre!(ctx);
    expect(ctx.request.model).toBe('claude-sonnet-4');
  });

  it('prefer list takes precedence over fallback chain', async () => {
    const mod = router({
      strategy: 'fallback',
      prefer: ['claude-haiku-4'],
      fallback_chain: ['claude-sonnet-4'],
    });
    const ctx = makeContext(makeRequest({ model: 'claude-opus-4' }));
    await mod.pre!(ctx);
    expect(ctx.request.model).toBe('claude-haiku-4');
  });

  it('budget_per_request filters models that cost too much', async () => {
    const mod = router({
      strategy: 'cheapest-first',
      fallback_chain: ['claude-opus-4', 'gpt-4o-mini'],
      budget_per_request: 0.001,
    });
    const ctx = makeContext(makeRequest({ model: 'claude-opus-4' }));
    await mod.pre!(ctx);
    expect(ctx.request.model).toBe('gpt-4o-mini');
  });

  it('q-learning cold start falls back to cheapest', async () => {
    const mod = router({
      strategy: 'q-learning',
      fallback_chain: ['claude-opus-4', 'gpt-4o-mini'],
    });
    const ctx = makeContext(makeRequest({ model: 'claude-opus-4' }));
    await mod.pre!(ctx);
    expect(ctx.request.model).toBe('gpt-4o-mini');
  });

  it('q-learning post hook updates the success counter', async () => {
    const mod = router({
      strategy: 'q-learning',
      fallback_chain: ['claude-sonnet-4', 'gpt-4o-mini'],
    });
    const storage = new FakeStorage();
    const request = makeRequest({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'translate this please' }],
    });

    const preCtx = makeContext(request, storage);
    await mod.pre!(preCtx);
    const selected = preCtx.metadata.get('router.selected_model') as string;
    expect(selected).toBe('gpt-4o-mini');

    const response = makeResponse({ stopReason: 'end_turn' });
    const postCtx = makeResponseContext(request, response, storage);
    postCtx.metadata.set('router.selected_model', selected);
    await mod.post!(postCtx);

    const keys = [...storage.kv.store.keys()];
    const qKeys = keys.filter((k) => k.startsWith('router:q:'));
    expect(qKeys.length).toBeGreaterThan(0);
    const stat = JSON.parse(storage.kv.store.get(qKeys[0])!.value);
    expect(stat).toEqual({ n: 1, s: 1 });
  });

  it('q-learning post records failures (s does not increment)', async () => {
    const mod = router({
      strategy: 'q-learning',
      fallback_chain: ['gpt-4o-mini'],
    });
    const storage = new FakeStorage();
    const request = makeRequest({
      messages: [{ role: 'user', content: 'do the thing' }],
    });

    const preCtx = makeContext(request, storage);
    await mod.pre!(preCtx);

    const errorResp = makeResponse({ stopReason: 'error' });
    const postCtx = makeResponseContext(request, errorResp, storage);
    postCtx.metadata.set('router.selected_model', 'gpt-4o-mini');
    await mod.post!(postCtx);

    const qKeys = [...storage.kv.store.keys()].filter((k) => k.startsWith('router:q:'));
    const stat = JSON.parse(storage.kv.store.get(qKeys[0])!.value);
    expect(stat).toEqual({ n: 1, s: 0 });
  });

  it('q-learning picks the model with highest success rate after observations', async () => {
    const mod = router({
      strategy: 'q-learning',
      fallback_chain: ['claude-sonnet-4', 'gpt-4o-mini'],
    });
    const storage = new FakeStorage();
    const request = makeRequest({
      messages: [{ role: 'user', content: 'parse the data' }],
    });

    await storage.kv.set(
      'router:q:parse-the-data:gpt-4o-mini',
      JSON.stringify({ n: 5, s: 1 }),
    );
    await storage.kv.set(
      'router:q:parse-the-data:claude-sonnet-4',
      JSON.stringify({ n: 5, s: 4 }),
    );

    const preCtx = makeContext(request, storage);
    await mod.pre!(preCtx);
    expect(preCtx.request.model).toBe('claude-sonnet-4');
  });

  it('reports name + version', () => {
    const mod = router();
    expect(mod.name).toBe('router');
    expect(mod.version).toBe('1.0.0');
  });
});
