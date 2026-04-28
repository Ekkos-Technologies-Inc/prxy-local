/**
 * Translates inbound Anthropic-shaped HTTP requests/responses to canonical and
 * back. Mirrors what the provider client does outbound, but for the gateway's
 * own `/v1/messages` endpoint so clients targeting Anthropic see an identical
 * surface.
 */

import { z } from 'zod';

import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  ContentBlock,
  SystemBlock,
} from '../types/canonical.js';

// ─────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────

const TextBlockIn = z.object({ type: z.literal('text'), text: z.string() });

const ImageBlockIn = z.object({
  type: z.literal('image'),
  source: z.union([
    z.object({
      type: z.literal('base64'),
      media_type: z.string().optional(),
      data: z.string(),
    }),
    z.object({ type: z.literal('url'), url: z.string() }),
  ]),
});

const ToolUseBlockIn = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

const ToolResultBlockIn = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.any())]),
  is_error: z.boolean().optional(),
});

const ContentBlockIn = z.union([TextBlockIn, ImageBlockIn, ToolUseBlockIn, ToolResultBlockIn]);

const MessageIn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(ContentBlockIn)]),
});

const SystemBlockIn = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: z.object({ type: z.literal('ephemeral') }).optional(),
});

const ToolIn = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()),
});

export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number().int().positive(),
  messages: z.array(MessageIn).min(1),
  system: z.union([z.string(), z.array(SystemBlockIn)]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z.array(ToolIn).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;

// ─────────────────────────────────────────────────────────────────
// Shape -> canonical
// ─────────────────────────────────────────────────────────────────

export function anthropicRequestToCanonical(body: AnthropicMessagesRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map(blockInToCanonical),
  }));

  const system: CanonicalRequest['system'] = (() => {
    if (body.system === undefined) return undefined;
    if (typeof body.system === 'string') return body.system;
    return body.system.map<SystemBlock>((b) => ({
      type: 'text',
      text: b.text,
      ...(b.cache_control && { cacheControl: b.cache_control }),
    }));
  })();

  const tools: CanonicalTool[] | undefined = body.tools?.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: t.input_schema,
  }));

  return {
    model: body.model,
    maxTokens: body.max_tokens,
    messages,
    stream: body.stream ?? false,
    ...(system !== undefined && { system }),
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { topP: body.top_p }),
    ...(body.top_k !== undefined && { topK: body.top_k }),
    ...(body.stop_sequences && { stopSequences: body.stop_sequences }),
    ...(tools && { tools }),
    ...(body.metadata && { metadata: body.metadata }),
  };
}

function blockInToCanonical(block: z.infer<typeof ContentBlockIn>): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      if (block.source.type === 'base64') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: block.source.media_type,
            data: block.source.data,
          },
        };
      }
      return { type: 'image', source: { type: 'url', data: block.source.url } };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        content:
          typeof block.content === 'string'
            ? block.content
            : (block.content as ContentBlock[]),
        ...(block.is_error && { isError: true }),
      };
  }
}

// ─────────────────────────────────────────────────────────────────
// Canonical -> shape (response)
// ─────────────────────────────────────────────────────────────────

export function canonicalResponseToAnthropic(res: CanonicalResponse): Record<string, unknown> {
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content: res.content.map(canonicalBlockToShape),
    stop_reason: res.stopReason,
    stop_sequence: res.stopSequence ?? null,
    usage: {
      input_tokens: res.usage.inputTokens,
      output_tokens: res.usage.outputTokens,
      ...(res.usage.cacheReadInputTokens !== undefined && {
        cache_read_input_tokens: res.usage.cacheReadInputTokens,
      }),
      ...(res.usage.cacheCreationInputTokens !== undefined && {
        cache_creation_input_tokens: res.usage.cacheCreationInputTokens,
      }),
    },
  };
}

function canonicalBlockToShape(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError && { is_error: true }),
      };
    case 'image':
      return {
        type: 'image',
        source:
          block.source.type === 'base64'
            ? {
                type: 'base64',
                media_type: block.source.mediaType ?? 'image/png',
                data: block.source.data,
              }
            : { type: 'url', url: block.source.data },
      };
  }
}

// ─────────────────────────────────────────────────────────────────
// Canonical -> shape (streaming events)
//
// The Anthropic Messages SSE stream uses event-typed envelopes with snake_case
// fields. We re-encode each canonical chunk into the format clients expect.
// ─────────────────────────────────────────────────────────────────

export function canonicalChunkToAnthropicSSE(chunk: CanonicalChunk): {
  event: string;
  data: Record<string, unknown>;
} {
  switch (chunk.type) {
    case 'message_start':
      return {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: chunk.message.id ?? '',
            type: 'message',
            role: 'assistant',
            model: chunk.message.model ?? '',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: chunk.message.usage?.inputTokens ?? 0,
              output_tokens: chunk.message.usage?.outputTokens ?? 0,
            },
          },
        },
      };
    case 'content_block_start':
      return {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: chunk.index,
          content_block: canonicalBlockToShape(chunk.contentBlock),
        },
      };
    case 'content_block_delta':
      return {
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: chunk.index,
          delta:
            chunk.delta.type === 'text_delta'
              ? { type: 'text_delta', text: chunk.delta.text }
              : { type: 'input_json_delta', partial_json: chunk.delta.partialJson },
        },
      };
    case 'content_block_stop':
      return {
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: chunk.index },
      };
    case 'message_delta':
      return {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            ...(chunk.delta.stopReason !== undefined && { stop_reason: chunk.delta.stopReason }),
            ...(chunk.delta.stopSequence !== undefined && {
              stop_sequence: chunk.delta.stopSequence,
            }),
          },
          ...(chunk.usage && {
            usage: {
              ...(chunk.usage.inputTokens !== undefined && {
                input_tokens: chunk.usage.inputTokens,
              }),
              ...(chunk.usage.outputTokens !== undefined && {
                output_tokens: chunk.usage.outputTokens,
              }),
            },
          }),
        },
      };
    case 'message_stop':
      return { event: 'message_stop', data: { type: 'message_stop' } };
  }
}
