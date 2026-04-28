/**
 * Tests for the Groq provider client.
 *
 * Groq's API is OpenAI-compatible — the canonical translation reuses the
 * OpenAI translator. These tests assert the SDK boundary still behaves
 * correctly with mocked groq-sdk and that `detectProvider` routes Groq
 * model names properly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGroqCreate = vi.fn();

vi.mock('groq-sdk', () => {
  class Groq {
    chat = { completions: { create: mockGroqCreate } };
    constructor(_opts?: unknown) {}
  }
  return { default: Groq, Groq };
});

import { groqClient } from '../../src/providers/groq.js';
import { detectProvider } from '../../src/providers/index.js';
import type { CanonicalRequest } from '../../src/types/canonical.js';

beforeEach(() => {
  mockGroqCreate.mockReset();
});

function baseRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'llama-3.3-70b-versatile',
    maxTokens: 256,
    stream: false,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

describe('groqClient.complete', () => {
  it('translates request and response through the OpenAI bridge', async () => {
    mockGroqCreate.mockResolvedValueOnce({
      id: 'cmpl_g_1',
      model: 'llama-3.3-70b-versatile',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi from groq' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const res = await groqClient.complete(baseRequest(), 'fake-key');

    expect(res.id).toBe('cmpl_g_1');
    expect(res.content).toEqual([{ type: 'text', text: 'hi from groq' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 });

    const sentParams = mockGroqCreate.mock.calls[0][0];
    expect(sentParams.model).toBe('llama-3.3-70b-versatile');
    expect(sentParams.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(sentParams.stream).toBe(false);
  });

  it('round-trips tool calls', async () => {
    mockGroqCreate.mockResolvedValueOnce({
      id: 'cmpl_g_tool',
      model: 'llama-3.3-70b-versatile',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'add', arguments: '{"a":1,"b":2}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    });

    const res = await groqClient.complete(
      baseRequest({
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: {
              type: 'object',
              properties: { a: { type: 'number' }, b: { type: 'number' } },
              required: ['a', 'b'],
            },
          },
        ],
      }),
      'fake-key',
    );

    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'add', input: { a: 1, b: 2 } },
    ]);
  });

  it('forwards system prompts as a leading system message', async () => {
    mockGroqCreate.mockResolvedValueOnce({
      id: 'cmpl_g_sys',
      model: 'llama-3.3-70b-versatile',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });

    await groqClient.complete(baseRequest({ system: 'be concise' }), 'fake-key');
    const sentParams = mockGroqCreate.mock.calls[0][0];
    expect(sentParams.messages[0]).toEqual({ role: 'system', content: 'be concise' });
    expect(sentParams.messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });
});

describe('groqClient.stream', () => {
  it('yields canonical chunks from a streamed response', async () => {
    async function* fakeStream() {
      yield {
        id: 'cmpl_g_stream',
        model: 'llama-3.3-70b-versatile',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }],
      };
      yield {
        id: 'cmpl_g_stream',
        model: 'llama-3.3-70b-versatile',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
      };
      yield {
        id: 'cmpl_g_stream',
        model: 'llama-3.3-70b-versatile',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      };
    }
    mockGroqCreate.mockResolvedValueOnce(fakeStream());

    const events = [];
    for await (const e of groqClient.stream(baseRequest({ stream: true }), 'fake-key')) {
      events.push(e);
    }

    expect(events[0].type).toBe('message_start');
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });
});

describe('detectProvider routes Groq model names', () => {
  it('routes llama models', () => {
    expect(detectProvider('llama-3.3-70b-versatile')).toBe('groq');
    expect(detectProvider('llama-3.1-8b')).toBe('groq');
  });
  it('routes the groq/ prefix', () => {
    expect(detectProvider('groq/whisper-large-v3')).toBe('groq');
  });
  it('routes mixtral', () => {
    expect(detectProvider('mixtral-8x7b-32768')).toBe('groq');
  });
});
