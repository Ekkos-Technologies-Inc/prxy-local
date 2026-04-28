/**
 * Tests for the Google (Gemini) provider client.
 *
 * Strategy: mock `@google/genai` so we can assert the canonical → Gemini
 * translation in isolation, plus run the response/stream translators on
 * fixtures shaped like real Gemini SDK output. No network calls.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    };
    constructor(_opts?: unknown) {}
  }
  return { GoogleGenAI };
});

import {
  canonicalToGoogle,
  googleClient,
  googleResponseToCanonical,
  googleStreamToCanonical,
} from '../../src/providers/google.js';
import type { CanonicalRequest } from '../../src/types/canonical.js';

beforeEach(() => {
  mockGenerateContent.mockReset();
  mockGenerateContentStream.mockReset();
});

function baseRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gemini-2.0-flash',
    maxTokens: 256,
    stream: false,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

describe('canonicalToGoogle', () => {
  it('translates a basic user message', () => {
    const out = canonicalToGoogle(baseRequest());
    expect(out.model).toBe('gemini-2.0-flash');
    expect(out.contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
    expect(out.config?.maxOutputTokens).toBe(256);
  });

  it('maps assistant role to model role', () => {
    const out = canonicalToGoogle(
      baseRequest({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello back' },
          { role: 'user', content: 'next' },
        ],
      }),
    );
    expect(out.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello back' }] },
      { role: 'user', parts: [{ text: 'next' }] },
    ]);
  });

  it('puts system into config.systemInstruction (not in contents)', () => {
    const out = canonicalToGoogle(
      baseRequest({
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(out.config?.systemInstruction).toBe('You are a helpful assistant.');
    expect(out.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('translates tool_use and tool_result blocks', () => {
    const out = canonicalToGoogle(
      baseRequest({
        messages: [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Calling list_dir' },
              { type: 'tool_use', id: 'call_1', name: 'list_dir', input: { path: '/tmp' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'a.txt\nb.txt' },
            ],
          },
        ],
      }),
    );
    expect(out.contents).toHaveLength(3);
    expect(out.contents[1].role).toBe('model');
    expect(out.contents[1].parts).toEqual([
      { text: 'Calling list_dir' },
      { functionCall: { id: 'call_1', name: 'list_dir', args: { path: '/tmp' } } },
    ]);
    expect(out.contents[2].role).toBe('user');
    expect(out.contents[2].parts?.[0].functionResponse?.id).toBe('call_1');
    expect(out.contents[2].parts?.[0].functionResponse?.response).toEqual({
      output: 'a.txt\nb.txt',
    });
  });

  it('maps tools to functionDeclarations', () => {
    const out = canonicalToGoogle(
      baseRequest({
        tools: [
          {
            name: 'get_weather',
            description: 'Get the current weather',
            inputSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      }),
    );
    const decls = out.config?.tools?.[0].functionDeclarations;
    expect(decls).toHaveLength(1);
    expect(decls?.[0].name).toBe('get_weather');
  });

  it('inlines base64 images', () => {
    const out = canonicalToGoogle(
      baseRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'whats this' },
              { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      }),
    );
    expect(out.contents[0].parts).toEqual([
      { text: 'whats this' },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
    ]);
  });
});

describe('googleResponseToCanonical', () => {
  it('translates a text response', () => {
    const fixture = {
      modelVersion: 'gemini-2.0-flash-001',
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hello there!' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const canonical = googleResponseToCanonical(fixture as any, 'gemini-2.0-flash');
    expect(canonical.role).toBe('assistant');
    expect(canonical.model).toBe('gemini-2.0-flash-001');
    expect(canonical.content).toEqual([{ type: 'text', text: 'Hello there!' }]);
    expect(canonical.stopReason).toBe('end_turn');
    expect(canonical.usage.inputTokens).toBe(12);
    expect(canonical.usage.outputTokens).toBe(4);
  });

  it('translates a tool_use response', () => {
    const fixture = {
      modelVersion: 'gemini-2.0-pro',
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'Looking up...' },
              { functionCall: { id: 'call_42', name: 'get_weather', args: { city: 'Toronto' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 18 },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const canonical = googleResponseToCanonical(fixture as any, 'gemini-2.0-pro');
    expect(canonical.content).toHaveLength(2);
    expect(canonical.content[1]).toEqual({
      type: 'tool_use',
      id: 'call_42',
      name: 'get_weather',
      input: { city: 'Toronto' },
    });
  });

  it('maps finish reasons', () => {
    const make = (reason: string) =>
      googleResponseToCanonical(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { candidates: [{ content: { parts: [] }, finishReason: reason }] } as any,
        'g',
      ).stopReason;
    expect(make('STOP')).toBe('end_turn');
    expect(make('MAX_TOKENS')).toBe('max_tokens');
    expect(make('SAFETY')).toBe('error');
    expect(make('UNKNOWN')).toBe('end_turn');
  });
});

describe('googleStreamToCanonical', () => {
  it('emits message_start, text deltas, message_stop', async () => {
    const chunks = [
      {
        modelVersion: 'gemini-2.0-flash',
        candidates: [{ content: { parts: [{ text: 'Hel' }] } }],
      },
      { candidates: [{ content: { parts: [{ text: 'lo' }] } }] },
      {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      },
    ];

    async function* gen() {
      for (const c of chunks) yield c;
    }

    const out = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const e of googleStreamToCanonical(gen() as any, 'gemini-2.0-flash')) {
      out.push(e);
    }

    expect(out[0].type).toBe('message_start');
    expect(out.at(-1)).toEqual({ type: 'message_stop' });
  });
});

describe('googleClient end-to-end (mocked SDK)', () => {
  it('complete() round-trips through the translator', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      modelVersion: 'gemini-2.0-flash',
      candidates: [
        { content: { role: 'model', parts: [{ text: 'Mocked reply' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    });

    const res = await googleClient.complete(baseRequest(), 'fake-key');
    expect(res.content).toEqual([{ type: 'text', text: 'Mocked reply' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('stream() yields canonical chunks', async () => {
    mockGenerateContentStream.mockResolvedValueOnce(
      (async function* () {
        yield {
          modelVersion: 'gemini-2.0-flash',
          candidates: [{ content: { parts: [{ text: 'stream' }] } }],
        };
        yield { candidates: [{ finishReason: 'STOP' }] };
      })(),
    );

    const events = [];
    for await (const e of googleClient.stream(baseRequest(), 'fake-key')) {
      events.push(e);
    }
    expect(events[0].type).toBe('message_start');
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });
});
