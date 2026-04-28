/**
 * Translates inbound OpenAI-shaped HTTP requests/responses to canonical and
 * back. Allows clients targeting OpenAI's Chat Completions API to point at
 * the gateway with no changes.
 */

import { z } from 'zod';

import type {
  CanonicalChunk,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  ContentBlock,
} from '../types/canonical.js';

// ─────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────

const TextPart = z.object({ type: z.literal('text'), text: z.string() });
const ImagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string() }),
});

const SystemMessage = z.object({
  role: z.literal('system'),
  content: z.union([z.string(), z.array(TextPart)]),
});

const UserMessage = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(z.union([TextPart, ImagePart]))]),
});

const AssistantMessage = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
});

const ToolMessage = z.object({
  role: z.literal('tool'),
  content: z.union([z.string(), z.array(TextPart)]),
  tool_call_id: z.string(),
});

const MessageIn = z.union([SystemMessage, UserMessage, AssistantMessage, ToolMessage]);

const ToolIn = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const OpenAIChatCompletionsRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageIn).min(1),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  tools: z.array(ToolIn).optional(),
  user: z.string().optional(),
});

export type OpenAIChatCompletionsRequest = z.infer<typeof OpenAIChatCompletionsRequestSchema>;

// ─────────────────────────────────────────────────────────────────
// Shape -> canonical
// ─────────────────────────────────────────────────────────────────

export function openaiRequestToCanonical(body: OpenAIChatCompletionsRequest): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  let topSystem: string | undefined;

  for (const m of body.messages) {
    if (m.role === 'system') {
      const text =
        typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('\n');
      // Promote the first system message to the top-level `system` field; later
      // ones get inlined into the message stream as `role: system`.
      if (topSystem === undefined) {
        topSystem = text;
      } else {
        messages.push({ role: 'system', content: text });
      }
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') {
        messages.push({ role: 'user', content: m.content });
      } else {
        const blocks: ContentBlock[] = m.content.map((p) =>
          p.type === 'text'
            ? ({ type: 'text', text: p.text } satisfies ContentBlock)
            : ({
                type: 'image',
                source: { type: 'url', data: p.image_url.url },
              } satisfies ContentBlock),
        );
        messages.push({ role: 'user', content: blocks });
      }
    } else if (m.role === 'assistant') {
      const blocks: ContentBlock[] = [];
      if (typeof m.content === 'string' && m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      if (m.tool_calls) {
        for (const call of m.tool_calls) {
          let parsed: unknown = {};
          try {
            parsed = JSON.parse(call.function.arguments || '{}');
          } catch {
            parsed = { _raw: call.function.arguments };
          }
          blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parsed });
        }
      }
      messages.push({
        role: 'assistant',
        content: blocks.length === 0 ? '' : blocks,
      });
    } else {
      // tool message -> user-side tool_result block
      const text =
        typeof m.content === 'string' ? m.content : m.content.map((p) => p.text).join('\n');
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: m.tool_call_id, content: text }],
      });
    }
  }

  const tools: CanonicalTool[] | undefined = body.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    inputSchema: t.function.parameters ?? {},
  }));

  const stop =
    body.stop === undefined ? undefined : Array.isArray(body.stop) ? body.stop : [body.stop];

  return {
    model: body.model,
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? 1024,
    messages,
    stream: body.stream ?? false,
    ...(topSystem !== undefined && { system: topSystem }),
    ...(body.temperature !== undefined && { temperature: body.temperature }),
    ...(body.top_p !== undefined && { topP: body.top_p }),
    ...(stop && { stopSequences: stop }),
    ...(tools && { tools }),
  };
}

// ─────────────────────────────────────────────────────────────────
// Canonical -> shape (response)
// ─────────────────────────────────────────────────────────────────

export function canonicalResponseToOpenAI(res: CanonicalResponse): Record<string, unknown> {
  let text = '';
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  for (const block of res.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: text || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: res.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReasonToOpenAI(res.stopReason),
      },
    ],
    usage: {
      prompt_tokens: res.usage.inputTokens,
      completion_tokens: res.usage.outputTokens,
      total_tokens: res.usage.inputTokens + res.usage.outputTokens,
    },
  };
}

function mapStopReasonToOpenAI(reason: CanonicalResponse['stopReason']): string {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'stop_sequence':
      return 'stop';
    case 'error':
      return 'content_filter';
    default:
      return 'stop';
  }
}

// ─────────────────────────────────────────────────────────────────
// Canonical -> shape (streaming chunks)
// ─────────────────────────────────────────────────────────────────

interface OpenAIStreamState {
  id: string;
  model: string;
  created: number;
  toolIndexById: Map<number, number>;
}

export function makeOpenAIStreamState(): OpenAIStreamState {
  return {
    id: '',
    model: '',
    created: Math.floor(Date.now() / 1000),
    toolIndexById: new Map(),
  };
}

export function canonicalChunkToOpenAISSE(
  chunk: CanonicalChunk,
  state: OpenAIStreamState,
): Record<string, unknown> | null {
  switch (chunk.type) {
    case 'message_start': {
      state.id = chunk.message.id ?? state.id;
      state.model = chunk.message.model ?? state.model;
      return {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      };
    }
    case 'content_block_start': {
      if (chunk.contentBlock.type === 'tool_use') {
        const toolIndex = state.toolIndexById.size;
        state.toolIndexById.set(chunk.index, toolIndex);
        return {
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: chunk.contentBlock.id,
                    type: 'function',
                    function: { name: chunk.contentBlock.name, arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
      }
      return null;
    }
    case 'content_block_delta': {
      if (chunk.delta.type === 'text_delta') {
        return {
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [{ index: 0, delta: { content: chunk.delta.text }, finish_reason: null }],
        };
      }
      // input_json_delta -> tool_call argument streaming
      const toolIndex = state.toolIndexById.get(chunk.index);
      if (toolIndex === undefined) return null;
      return {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: toolIndex,
                  function: { arguments: chunk.delta.partialJson },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }
    case 'content_block_stop':
      return null;
    case 'message_delta': {
      const finishReason = chunk.delta.stopReason
        ? mapStopReasonToOpenAI(chunk.delta.stopReason)
        : null;
      const usage = chunk.usage
        ? {
            prompt_tokens: chunk.usage.inputTokens ?? 0,
            completion_tokens: chunk.usage.outputTokens ?? 0,
            total_tokens: (chunk.usage.inputTokens ?? 0) + (chunk.usage.outputTokens ?? 0),
          }
        : undefined;
      return {
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        ...(usage && { usage }),
      };
    }
    case 'message_stop':
      return null;
  }
}
