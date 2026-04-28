/**
 * Anthropic provider client.
 *
 * Translates between the canonical request/response format and the Anthropic
 * Messages API. Supports both buffered (`complete()`) and streaming (`stream()`)
 * paths via the official `@anthropic-ai/sdk`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  ContentBlock,
  SystemBlock,
} from '../types/canonical.js';

import type { ProviderClient } from './types.js';

export const anthropicClient: ProviderClient = {
  async complete(req: CanonicalRequest, apiKey: string): Promise<CanonicalResponse> {
    const client = makeClient(apiKey);
    const params = canonicalToAnthropic(req, false);
    const message = await client.messages.create(params);
    return anthropicResponseToCanonical(message);
  },

  async *stream(req: CanonicalRequest, apiKey: string): AsyncIterable<CanonicalChunk> {
    const client = makeClient(apiKey);
    const params = canonicalToAnthropic(req, true);
    const stream = await client.messages.create(params);

    for await (const event of stream as AsyncIterable<Anthropic.RawMessageStreamEvent>) {
      const chunk = anthropicStreamEventToCanonical(event);
      if (chunk) yield chunk;
    }
  },
};

function makeClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

type AnthropicCreateParams =
  | Anthropic.MessageCreateParamsNonStreaming
  | Anthropic.MessageCreateParamsStreaming;

export function canonicalToAnthropic(
  req: CanonicalRequest,
  stream: false,
): Anthropic.MessageCreateParamsNonStreaming;
export function canonicalToAnthropic(
  req: CanonicalRequest,
  stream: true,
): Anthropic.MessageCreateParamsStreaming;
export function canonicalToAnthropic(
  req: CanonicalRequest,
  stream: boolean,
): AnthropicCreateParams {
  const messages: Anthropic.MessageParam[] = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: canonicalContentToAnthropic(m.content),
    }));

  const extras: {
    system?: string | Anthropic.TextBlockParam[];
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    tools?: Anthropic.ToolUnion[];
  } = {};

  if (req.system !== undefined) extras.system = canonicalSystemToAnthropic(req.system);
  if (req.temperature !== undefined) extras.temperature = req.temperature;
  if (req.topP !== undefined) extras.top_p = req.topP;
  if (req.topK !== undefined) extras.top_k = req.topK;
  if (req.stopSequences && req.stopSequences.length > 0) extras.stop_sequences = req.stopSequences;
  if (req.tools && req.tools.length > 0) extras.tools = canonicalToolsToAnthropic(req.tools);

  if (stream) {
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
      ...extras,
      stream: true,
    } satisfies Anthropic.MessageCreateParamsStreaming;
  }
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages,
    ...extras,
  } satisfies Anthropic.MessageCreateParamsNonStreaming;
}

function canonicalContentToAnthropic(
  content: CanonicalMessage['content'],
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') return content;
  return content.map(canonicalBlockToAnthropic);
}

function canonicalBlockToAnthropic(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      };
    case 'tool_result': {
      const toolContent =
        typeof block.content === 'string'
          ? block.content
          : block.content
              .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
              .map((c) => ({ type: 'text' as const, text: c.text }));
      const param: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: toolContent,
      };
      if (block.isError) param.is_error = true;
      return param;
    }
    case 'image': {
      if (block.source.type === 'base64') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: (block.source.mediaType ?? 'image/png') as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: block.source.data,
          },
        };
      }
      return {
        type: 'image',
        source: { type: 'url', url: block.source.data },
      };
    }
  }
}

function canonicalSystemToAnthropic(
  system: string | SystemBlock[],
): string | Anthropic.TextBlockParam[] {
  if (typeof system === 'string') return system;
  return system.map((b) => {
    const block: Anthropic.TextBlockParam = { type: 'text', text: b.text };
    if (b.cacheControl) block.cache_control = b.cacheControl;
    return block;
  });
}

function canonicalToolsToAnthropic(tools: CanonicalTool[]): Anthropic.ToolUnion[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export function anthropicResponseToCanonical(msg: Anthropic.Message): CanonicalResponse {
  return {
    id: msg.id,
    model: msg.model,
    role: 'assistant',
    content: msg.content.map(anthropicBlockToCanonical),
    stopReason: mapAnthropicStopReason(msg.stop_reason),
    stopSequence: msg.stop_sequence ?? undefined,
    usage: {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? undefined,
      cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? undefined,
    },
  };
}

function anthropicBlockToCanonical(block: Anthropic.ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    default:
      return { type: 'text', text: '' };
  }
}

function mapAnthropicStopReason(
  reason: Anthropic.Message['stop_reason'],
): CanonicalResponse['stopReason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

export function anthropicStreamEventToCanonical(
  event: Anthropic.RawMessageStreamEvent,
): CanonicalChunk | null {
  switch (event.type) {
    case 'message_start':
      return {
        type: 'message_start',
        message: {
          id: event.message.id,
          model: event.message.model,
          role: 'assistant',
          content: [],
          usage: {
            inputTokens: event.message.usage.input_tokens,
            outputTokens: event.message.usage.output_tokens,
          },
        },
      };
    case 'content_block_start':
      return {
        type: 'content_block_start',
        index: event.index,
        contentBlock: anthropicBlockToCanonical(event.content_block as Anthropic.ContentBlock),
      };
    case 'content_block_delta': {
      const d = event.delta;
      if (d.type === 'text_delta') {
        return {
          type: 'content_block_delta',
          index: event.index,
          delta: { type: 'text_delta', text: d.text },
        };
      }
      if (d.type === 'input_json_delta') {
        return {
          type: 'content_block_delta',
          index: event.index,
          delta: { type: 'input_json_delta', partialJson: d.partial_json },
        };
      }
      return null;
    }
    case 'content_block_stop':
      return { type: 'content_block_stop', index: event.index };
    case 'message_delta':
      return {
        type: 'message_delta',
        delta: {
          stopReason: event.delta.stop_reason
            ? mapAnthropicStopReason(event.delta.stop_reason)
            : undefined,
          stopSequence: event.delta.stop_sequence ?? undefined,
        },
        usage: event.usage
          ? {
              outputTokens: event.usage.output_tokens,
            }
          : undefined,
      };
    case 'message_stop':
      return { type: 'message_stop' };
    default:
      return null;
  }
}
