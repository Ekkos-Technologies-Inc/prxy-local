/**
 * Tests for the Bedrock provider client (prxy-local edition).
 *
 * Asserts the canonical ↔ Converse API translation, streaming, error paths,
 * credential parsing, and that `detectProvider` routes `bedrock/*` model names
 * correctly. The AWS SDK is fully mocked — no live API calls.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockClientCtor = vi.fn();

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class ConverseCommand {
    constructor(public readonly input: unknown) {}
  }
  class ConverseStreamCommand {
    constructor(public readonly input: unknown) {}
  }
  class BedrockRuntimeClient {
    constructor(cfg: unknown) {
      mockClientCtor(cfg);
    }
    send = mockSend;
  }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand };
});

import { bedrockClient, encodeBedrockCredentials } from '../../src/providers/bedrock.js';
import { detectProvider } from '../../src/providers/index.js';
import type { CanonicalRequest } from '../../src/types/canonical.js';

beforeEach(() => {
  mockSend.mockReset();
  mockClientCtor.mockReset();
});

function baseRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
    maxTokens: 256,
    stream: false,
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

const credsBlob = encodeBedrockCredentials({
  accessKeyId: 'AKIA-fake',
  secretAccessKey: 'secret-fake',
  region: 'us-east-1',
});

describe('bedrockClient.complete', () => {
  it('translates request and response through Converse', async () => {
    mockSend.mockResolvedValueOnce({
      $metadata: { requestId: 'req-1' },
      output: {
        message: { role: 'assistant', content: [{ text: 'hi from bedrock' }] },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 3 },
    });

    const res = await bedrockClient.complete(baseRequest(), credsBlob);
    expect(res.id).toBe('req-1');
    expect(res.model).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    expect(res.content).toEqual([{ type: 'text', text: 'hi from bedrock' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 });

    const cmd = mockSend.mock.calls[0][0] as { input: unknown; constructor: { name: string } };
    expect(cmd.constructor.name).toBe('ConverseCommand');
    const sent = cmd.input as { modelId: string; messages: unknown[]; inferenceConfig: { maxTokens: number } };
    expect(sent.modelId).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
    expect(sent.inferenceConfig.maxTokens).toBe(256);
  });

  it('round-trips tool calls', async () => {
    mockSend.mockResolvedValueOnce({
      $metadata: { requestId: 'req-tool' },
      output: {
        message: {
          role: 'assistant',
          content: [
            { toolUse: { toolUseId: 'tu_1', name: 'add', input: { a: 1, b: 2 } } },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 8, outputTokens: 12 },
    });
    const res = await bedrockClient.complete(
      baseRequest({
        tools: [
          {
            name: 'add',
            description: 'Add two numbers',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
          },
        ],
      }),
      credsBlob,
    );
    expect(res.stopReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'add', input: { a: 1, b: 2 } },
    ]);
  });

  it('forwards system prompt as Bedrock system blocks', async () => {
    mockSend.mockResolvedValueOnce({
      $metadata: { requestId: 'req-sys' },
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 1 },
    });
    await bedrockClient.complete(baseRequest({ system: 'be concise' }), credsBlob);
    const cmd = mockSend.mock.calls[0][0] as { input: unknown };
    const sent = cmd.input as { system: Array<{ text: string }> };
    expect(sent.system).toEqual([{ text: 'be concise' }]);
  });

  it('passes credentials when provided', async () => {
    mockSend.mockResolvedValueOnce({
      $metadata: { requestId: 'req-creds' },
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await bedrockClient.complete(baseRequest(), credsBlob);
    const cfg = mockClientCtor.mock.calls[0][0];
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.credentials).toEqual({ accessKeyId: 'AKIA-fake', secretAccessKey: 'secret-fake' });
  });

  it('falls back to default credential chain when only region is provided', async () => {
    mockSend.mockResolvedValueOnce({
      $metadata: { requestId: 'req-bare' },
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await bedrockClient.complete(baseRequest(), 'us-west-2');
    const cfg = mockClientCtor.mock.calls[0][0];
    expect(cfg.region).toBe('us-west-2');
    expect(cfg.credentials).toBeUndefined();
  });

  it('rejects credentials JSON without a region', async () => {
    await expect(
      bedrockClient.complete(baseRequest(), JSON.stringify({ accessKeyId: 'x', secretAccessKey: 'y' })),
    ).rejects.toThrow(/region is required/i);
  });
});

describe('bedrockClient.stream', () => {
  it('yields canonical chunks from a streamed Converse response', async () => {
    async function* fakeStream() {
      yield { messageStart: { role: 'assistant' } };
      yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hel' } } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'lo' } } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: 'end_turn' } };
    }
    mockSend.mockResolvedValueOnce({ stream: fakeStream() });
    const events = [];
    for await (const e of bedrockClient.stream(baseRequest({ stream: true }), credsBlob)) {
      events.push(e);
    }
    expect(events[0]).toMatchObject({ type: 'message_start' });
    const deltas = events.filter((e) => e.type === 'content_block_delta');
    expect(deltas).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    const cmd = mockSend.mock.calls[0][0] as { constructor: { name: string } };
    expect(cmd.constructor.name).toBe('ConverseStreamCommand');
  });
});

describe('detectProvider routes Bedrock model names', () => {
  it('routes the bedrock/ prefix', () => {
    expect(detectProvider('bedrock/anthropic.claude-sonnet-4-20250514-v1:0')).toBe('bedrock');
    expect(detectProvider('bedrock/meta.llama3-70b-instruct-v1:0')).toBe('bedrock');
    expect(detectProvider('bedrock/amazon.titan-text-express-v1')).toBe('bedrock');
  });
  it('takes precedence over plain claude-/llama- routing', () => {
    expect(detectProvider('bedrock/claude-3-5-sonnet-20241022')).toBe('bedrock');
    expect(detectProvider('claude-3-5-sonnet-20241022')).toBe('anthropic');
    expect(detectProvider('llama-3.3-70b-versatile')).toBe('groq');
    expect(detectProvider('bedrock/llama-3.3-70b-instruct')).toBe('bedrock');
  });
});
