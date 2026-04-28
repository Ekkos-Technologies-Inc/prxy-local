import { afterEach, describe, expect, it } from 'vitest';

import {
  _uninstallAirgap,
  airgap,
  isAirgapInstalled,
} from '../../src/modules/airgap.js';
import { FakeStorage, makeContext, makeRequest } from '../_helpers.js';

afterEach(() => {
  _uninstallAirgap();
});

describe('airgap module', () => {
  it('installs a fetch guard at init()', async () => {
    const mod = airgap();
    const storage = new FakeStorage();
    expect(isAirgapInstalled()).toBe(false);
    await mod.init!(storage);
    expect(isAirgapInstalled()).toBe(true);
  });

  it('blocks outbound requests to non-allowed hosts', async () => {
    const mod = airgap({ allowedHosts: ['api.anthropic.com'] });
    await mod.init!(new FakeStorage());
    await expect(fetch('https://example.com/foo')).rejects.toThrow(/airgap/);
  });

  it('allows requests to whitelisted hosts (suffix match)', async () => {
    // Replace fetch BEFORE airgap installs, so the guard captures our mock
    // as the "original fetch" it will delegate allowed calls to. This avoids
    // hitting the real network from a test.
    const originalFetch = globalThis.fetch;
    let downstreamCalled = false;
    globalThis.fetch = (async () => {
      downstreamCalled = true;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const mod = airgap({ allowedHosts: ['anthropic.com'] });
      await mod.init!(new FakeStorage());

      const res = await fetch('https://api.anthropic.com/anything');
      expect(res.status).toBe(200);
      expect(downstreamCalled).toBe(true);
    } finally {
      _uninstallAirgap();
      globalThis.fetch = originalFetch;
    }
  });

  it('denyAll blocks even allowed hosts', async () => {
    const mod = airgap({
      allowedHosts: ['api.anthropic.com'],
      denyAll: true,
    });
    await mod.init!(new FakeStorage());
    await expect(fetch('https://api.anthropic.com/foo')).rejects.toThrow(/denyAll/);
  });

  it('pre() records telemetry without making network calls', async () => {
    const mod = airgap();
    await mod.init!(new FakeStorage());
    const ctx = makeContext(makeRequest());
    const r = await mod.pre!(ctx);
    expect(r.continue).toBe(true);
    expect(ctx.metadata.get('airgap.installed')).toBe(true);
    expect(Array.isArray(ctx.metadata.get('airgap.allowed'))).toBe(true);
  });
});
