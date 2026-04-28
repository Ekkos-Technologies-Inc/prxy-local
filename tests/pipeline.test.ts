/**
 * Pipeline executor + loader integration tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRequestContext, executePipeline } from '../src/pipeline/executor.js';
import { loadPipeline, parsePipeline } from '../src/pipeline/loader.js';
import type {
  ApiKeyInfo,
  CanonicalRequest,
  CanonicalResponse,
} from '../src/types/canonical.js';
import type { Module } from '../src/types/sdk.js';
import { FakeStorage, noopLogger } from './_helpers.js';

const apiKey: ApiKeyInfo = {
  keyId: 'k',
  userId: 'u',
  tier: 'local',
  revoked: false,
};

const baseRequest: CanonicalRequest = {
  model: 'claude-sonnet-4',
  maxTokens: 100,
  stream: false,
  messages: [{ role: 'user', content: 'hi' }],
};

const baseResponse: CanonicalResponse = {
  id: 'msg_provider',
  model: 'claude-sonnet-4',
  role: 'assistant',
  content: [{ type: 'text', text: 'from provider' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 5, outputTokens: 3 },
};

function recordingModule(
  name: string,
  calls: string[],
  opts: {
    shortCircuit?: CanonicalResponse;
    throwInPre?: boolean;
    throwInPost?: boolean;
  } = {},
): Module {
  return {
    name,
    version: '1.0.0',
    async pre() {
      calls.push(`pre:${name}`);
      if (opts.throwInPre) throw new Error(`pre boom in ${name}`);
      if (opts.shortCircuit) return { continue: false, response: opts.shortCircuit };
      return { continue: true };
    },
    async post() {
      calls.push(`post:${name}`);
      if (opts.throwInPost) throw new Error(`post boom in ${name}`);
    },
  };
}

describe('executePipeline', () => {
  it('runs pre-modules in declared order then provider', async () => {
    const calls: string[] = [];
    const modules = [
      recordingModule('a', calls),
      recordingModule('b', calls),
      recordingModule('c', calls),
    ];
    const ctx = buildRequestContext({
      request: baseRequest,
      apiKey,
      storage: new FakeStorage(),
      logger: noopLogger,
    });
    const res = await executePipeline({
      modules,
      ctx,
      callProvider: async () => {
        calls.push('provider');
        return baseResponse;
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(res.response.id).toBe('msg_provider');
    expect(res.shortCircuitedBy).toBeNull();
    expect(calls.slice(0, 4)).toEqual(['pre:a', 'pre:b', 'pre:c', 'provider']);
    expect(calls.filter((c) => c.startsWith('post:')).sort()).toEqual([
      'post:a',
      'post:b',
      'post:c',
    ]);
  });

  it('short-circuit halts the pipeline and skips provider', async () => {
    const calls: string[] = [];
    const cached: CanonicalResponse = { ...baseResponse, id: 'msg_cached' };
    const modules = [
      recordingModule('a', calls),
      recordingModule('cache', calls, { shortCircuit: cached }),
      recordingModule('c', calls),
    ];
    const ctx = buildRequestContext({
      request: baseRequest,
      apiKey,
      storage: new FakeStorage(),
      logger: noopLogger,
    });
    let providerCalled = false;
    const res = await executePipeline({
      modules,
      ctx,
      callProvider: async () => {
        providerCalled = true;
        return baseResponse;
      },
    });
    expect(res.shortCircuitedBy).toBe('cache');
    expect(res.response.id).toBe('msg_cached');
    expect(providerCalled).toBe(false);
    expect(calls).not.toContain('pre:c');
  });

  it('module errors in pre() do not break the pipeline', async () => {
    const calls: string[] = [];
    const modules = [
      recordingModule('good', calls),
      recordingModule('boom', calls, { throwInPre: true }),
      recordingModule('also-good', calls),
    ];
    const ctx = buildRequestContext({
      request: baseRequest,
      apiKey,
      storage: new FakeStorage(),
      logger: noopLogger,
    });
    const res = await executePipeline({
      modules,
      ctx,
      callProvider: async () => baseResponse,
    });
    expect(res.preFailed).toEqual(['boom']);
    expect(res.response.id).toBe('msg_provider');
    expect(calls).toContain('pre:also-good');
  });

  it('post errors do not propagate', async () => {
    const calls: string[] = [];
    const modules = [recordingModule('boom', calls, { throwInPost: true })];
    const ctx = buildRequestContext({
      request: baseRequest,
      apiKey,
      storage: new FakeStorage(),
      logger: noopLogger,
    });
    const res = await executePipeline({
      modules,
      ctx,
      callProvider: async () => baseResponse,
    });
    expect(res.response.id).toBe('msg_provider');
    await new Promise((r) => setImmediate(r));
  });
});

describe('loadPipeline', () => {
  beforeEach(() => {
    delete process.env.PRXY_PIPE;
    delete process.env.PRXY_PIPE_FILE;
  });
  afterEach(() => {
    delete process.env.PRXY_PIPE;
    delete process.env.PRXY_PIPE_FILE;
  });

  it('returns the default pipeline when nothing is configured', async () => {
    const modules = await loadPipeline(apiKey);
    const names = modules.map((m) => m.name);
    expect(names).toContain('mcp-optimizer');
    expect(names).toContain('semantic-cache');
    expect(names).toContain('patterns');
  });

  it('reads PRXY_PIPE env var', async () => {
    process.env.PRXY_PIPE = 'exact-cache,cost-guard';
    const modules = await loadPipeline(apiKey);
    expect(modules.map((m) => m.name)).toEqual(['exact-cache', 'cost-guard']);
  });

  it('per-request override beats env var', async () => {
    process.env.PRXY_PIPE = 'exact-cache';
    const modules = await loadPipeline(apiKey, { override: 'patterns,ipc' });
    expect(modules.map((m) => m.name)).toEqual(['patterns', 'ipc']);
  });

  it('per-key config beats env var when no override given', async () => {
    process.env.PRXY_PIPE = 'exact-cache';
    const modules = await loadPipeline({ ...apiKey, pipelineConfig: 'patterns' });
    expect(modules.map((m) => m.name)).toEqual(['patterns']);
  });

  it('falls back to default on unknown module name', async () => {
    const modules = await loadPipeline(apiKey, { override: 'no-such-module' });
    const names = modules.map((m) => m.name);
    expect(names).toContain('mcp-optimizer');
  });

  it('does NOT auto-append usage-tracker (cloud-only)', async () => {
    const modules = await loadPipeline(apiKey, { override: 'patterns' });
    const names = modules.map((m) => m.name);
    expect(names).toEqual(['patterns']);
    expect(names).not.toContain('usage-tracker');
  });

  it('resolves the airgap module', async () => {
    const modules = await loadPipeline(apiKey, { override: 'airgap' });
    expect(modules[0].name).toBe('airgap');
  });
});

describe('parsePipeline', () => {
  it('parses a simple comma list', () => {
    const mods = parsePipeline('mcp-optimizer,exact-cache');
    expect(mods.map((m) => m.name)).toEqual(['mcp-optimizer', 'exact-cache']);
  });

  it('parses a YAML list with parameterized config', () => {
    const yaml = `
- module: cost-guard
  config:
    perRequest: 1.5
- exact-cache
`;
    const mods = parsePipeline(yaml);
    expect(mods.map((m) => m.name)).toEqual(['cost-guard', 'exact-cache']);
  });

  it('throws on unknown module name', () => {
    expect(() => parsePipeline('nope')).toThrow(/Unknown module/);
  });
});

describe('integration: full pipeline through executor', () => {
  it('runs all 7 local modules without errors and returns a real response', async () => {
    const modules = parsePipeline(
      'airgap,mcp-optimizer,exact-cache,semantic-cache,cost-guard,patterns,ipc',
    );
    // airgap installs the global guard, which would block the embedding fetches
    // semantic-cache + patterns issue. The stub embed fallback still works.
    const storage = new FakeStorage();
    const ctx = buildRequestContext({
      request: baseRequest,
      apiKey,
      storage,
      logger: noopLogger,
    });

    // Initialize modules so airgap can install its guard.
    for (const mod of modules) {
      if (mod.init) await mod.init(storage);
    }

    const res = await executePipeline({
      modules,
      ctx,
      callProvider: async () => baseResponse,
    });
    expect(res.response.id).toBe('msg_provider');
    expect(res.shortCircuitedBy).toBeNull();
    expect(res.preFailed).toEqual([]);

    // Cleanup the airgap guard for other tests.
    const { _uninstallAirgap } = await import('../src/modules/airgap.js');
    _uninstallAirgap();
  });
});
