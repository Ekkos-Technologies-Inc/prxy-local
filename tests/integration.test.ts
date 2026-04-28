/**
 * Integration tests — end-to-end through the Express app with the provider
 * clients mocked. Validates request validation, response shape translation,
 * and SSE streaming for both Anthropic and OpenAI endpoints.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
} from '../src/types/canonical.js';

const capturedRequests: CanonicalRequest[] = [];

let mockComplete: (req: CanonicalRequest) => CanonicalResponse = () => {
  throw new Error('mockComplete not configured');
};
let mockStreamChunks: (req: CanonicalRequest) => CanonicalChunk[] = () => {
  throw new Error('mockStreamChunks not configured');
};

vi.mock('../src/providers/index.js', async () => {
  const actual = await vi.importActual<typeof import('../src/providers/index.js')>(
    '../src/providers/index.js',
  );
  const fakeClient = {
    async complete(req: CanonicalRequest, _apiKey: string) {
      capturedRequests.push(req);
      return mockComplete(req);
    },
    async *stream(req: CanonicalRequest, _apiKey: string) {
      capturedRequests.push(req);
      for (const chunk of mockStreamChunks(req)) {
        yield chunk;
      }
    },
  };
  return {
    ...actual,
    getProviderClient: () => fakeClient,
    providerClients: {
      anthropic: fakeClient,
      openai: fakeClient,
      google: fakeClient,
      groq: fakeClient,
    },
  };
});

let app: import('express').Express;
let dataDir: string;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  process.env.OPENAI_API_KEY = 'test-openai';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  delete process.env.LOCAL_API_KEY;
  // Use cost-guard (no caching, no short-circuit at our usage levels) so a
  // prior test's provider response doesn't get returned by semantic-cache.
  process.env.PRXY_PIPE = 'cost-guard';

  dataDir = await fs.mkdtemp(join(tmpdir(), 'prxy-local-test-'));
  process.env.PRXY_DATA_DIR = dataDir;

  const adapterMod = await import('../src/storage/adapter.js');
  await adapterMod.initStorage({ dataDir, kvCleanupIntervalMs: 0 });

  const mod = await import('../src/app.js');
  app = mod.createApp();
});

afterAll(async () => {
  const adapterMod = await import('../src/storage/adapter.js');
  await adapterMod.resetStorage();
  if (dataDir) {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

afterEach(() => {
  capturedRequests.length = 0;
});

describe('GET /health', () => {
  it('returns ok with provider status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.edition).toBe('local');
    expect(res.body.providers).toMatchObject({
      anthropic: true,
      openai: true,
      google: false,
      groq: false,
    });
  });
});

describe('GET /v1/pipeline', () => {
  it('returns the active pipeline modules', async () => {
    const res = await request(app)
      .get('/v1/pipeline')
      .set('Authorization', 'Bearer prxy_test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.active)).toBe(true);
  });

  it('honors x-prxy-pipe override', async () => {
    const res = await request(app)
      .get('/v1/pipeline')
      .set('Authorization', 'Bearer prxy_test')
      .set('x-prxy-pipe', 'exact-cache');
    expect(res.status).toBe(200);
    expect(res.body.active.map((m: { name: string }) => m.name)).toEqual(['exact-cache']);
  });
});

describe('POST /v1/messages (Anthropic-compatible)', () => {
  it('rejects malformed body', async () => {
    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer prxy_test')
      .send({ model: 'claude-haiku-4-5' });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('invalid_request');
  });

  it('routes a non-streaming request and returns Anthropic-shaped response', async () => {
    mockComplete = (_req) => ({
      id: 'msg_test1',
      model: 'claude-haiku-4-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello world' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2 },
    });

    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer prxy_test')
      .send({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'say hi' }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'msg_test1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hello world' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toMatchObject({
      model: 'claude-haiku-4-5',
      maxTokens: 100,
      stream: false,
    });
  });

  it('streams SSE chunks end-to-end in Anthropic format', async () => {
    mockStreamChunks = () => [
      {
        type: 'message_start',
        message: {
          id: 'msg_stream1',
          model: 'claude-haiku-4-5',
          role: 'assistant',
          content: [],
          usage: { inputTokens: 3, outputTokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, contentBlock: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stopReason: 'end_turn' }, usage: { outputTokens: 2 } },
      { type: 'message_stop' },
    ];

    const res = await request(app)
      .post('/v1/messages')
      .set('Authorization', 'Bearer prxy_test')
      .send({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        stream: true,
        messages: [{ role: 'user', content: 'say hi' }],
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const body: string = res.text ?? '';
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_stop');
    expect(body).toContain('"text":"hello"');
    expect(body).toContain('"text":" world"');
  });
});

describe('POST /v1/chat/completions (OpenAI-compatible)', () => {
  it('routes a non-streaming request and returns OpenAI-shaped response', async () => {
    mockComplete = (_req) => ({
      id: 'cmpl_test1',
      model: 'gpt-4o-mini',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi from gpt' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 4, outputTokens: 3 },
    });

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer prxy_test')
      .send({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'say hi' }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'cmpl_test1',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi from gpt' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });
  });
});
