/**
 * OpenAI provider client.
 *
 * Translates between the canonical request/response format and the OpenAI Chat
 * Completions API. Supports both buffered (`complete()`) and streaming
 * (`stream()`) paths via the official `openai` SDK.
 */

import OpenAI from 'openai';
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

export const openaiClient: ProviderClient = {
  async complete(req: CanonicalRequest, apiKey: string): Promise<CanonicalResponse> {
    const client = makeClient(apiKey);
    const params = canonicalToOpenAI(req, false);
    const completion = await client.chat.completions.create(params);
    return openaiResponseToCanonical(completion);
  },

  async *stream(req: CanonicalRequest, apiKey: string): AsyncIterable<CanonicalChunk> {
    const client = makeClient(apiKey);
    const params = canonicalToOpenAI(req, true);
    const stream = await client.chat.completions.create(params);

    yield* openaiStreamToCanonical(stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>);
  },
};

function makeClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

type OpenAICreateParams =
  | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
  | OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

export function canonicalToOpenAI(
  req: CanonicalRequest,
  stream: false,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
export function canonicalToOpenAI(
  req: CanonicalRequest,
  stream: true,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
export function canonicalToOpenAI(req: CanonicalRequest, stream: boolean): OpenAICreateParams {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (req.system !== undefined) {
    messages.push({
      role: 'system',
      content: canonicalSystemToOpenAI(req.system),
    });
  }

  for (const m of req.messages) {
    messages.push(canonicalMessageToOpenAI(m));
  }

  const extras: {
    temperature?: number;
    top_p?: number;
    stop?: string[];
    tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  } = {};

  if (req.temperature !== undefined) extras.temperature = req.temperature;
  if (req.topP !== undefined) extras.top_p = req.topP;
  if (req.stopSequences && req.stopSequences.length > 0) extras.stop = req.stopSequences;
  if (req.tools && req.tools.length > 0) extras.tools = canonicalToolsToOpenAI(req.tools);

  if (stream) {
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
      ...extras,
      stream: true,
      stream_options: { include_usage: true },
    } satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
  }
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    messages,
    ...extras,
    stream: false,
  } satisfies OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
}

function canonicalMessageToOpenAI(
  m: CanonicalMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'system') {
    return {
      role: 'system',
      content: typeof m.content === 'string' ? m.content : flattenTextBlocks(m.content),
    };
  }

  if (m.role === 'user') {
    if (typeof m.content === 'string') {
      return { role: 'user', content: m.content };
    }
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const url =
          block.source.type === 'url'
            ? block.source.data
            : `data:${block.source.mediaType ?? 'image/png'};base64,${block.source.data}`;
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    return { role: 'user', content: parts };
  }

  // assistant
  if (typeof m.content === 'string') {
    return { role: 'assistant', content: m.content };
  }

  let text = '';
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
  for (const block of m.content) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: text || null,
  };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
}

function flattenTextBlocks(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function canonicalSystemToOpenAI(system: string | SystemBlock[]): string {
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

function canonicalToolsToOpenAI(tools: CanonicalTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export function openaiResponseToCanonical(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): CanonicalResponse {
  const choice = completion.choices[0];
  const content: ContentBlock[] = [];

  if (choice?.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice?.message.tool_calls) {
    for (const call of choice.message.tool_calls) {
      if (call.type === 'function') {
        let parsedInput: unknown = {};
        try {
          parsedInput = JSON.parse(call.function.arguments || '{}');
        } catch {
          parsedInput = { _raw: call.function.arguments };
        }
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parsedInput,
        });
      }
    }
  }

  return {
    id: completion.id,
    model: completion.model,
    role: 'assistant',
    content,
    stopReason: mapOpenAIFinishReason(choice?.finish_reason),
    usage: {
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

function mapOpenAIFinishReason(
  reason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] | undefined,
): CanonicalResponse['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'error';
    default:
      return 'end_turn';
  }
}

export async function* openaiStreamToCanonical(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
): AsyncIterable<CanonicalChunk> {
  let messageStarted = false;
  let textBlockStarted = false;
  const textIndex = 0;
  const toolBlocks = new Map<number, { canonicalIndex: number; started: boolean }>();
  let nextBlockIndex = 1;
  let finishReason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'] | null = null;
  let usage: OpenAI.CompletionUsage | null | undefined = null;

  for await (const chunk of stream) {
    if (!messageStarted) {
      messageStarted = true;
      yield {
        type: 'message_start',
        message: {
          id: chunk.id,
          model: chunk.model,
          role: 'assistant',
          content: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      };
    }

    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices[0];
    if (!choice) continue;

    const delta = choice.delta;

    if (delta?.content) {
      if (!textBlockStarted) {
        textBlockStarted = true;
        yield {
          type: 'content_block_start',
          index: textIndex,
          contentBlock: { type: 'text', text: '' },
        };
      }
      yield {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: delta.content },
      };
    }

    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) {
        let entry = toolBlocks.get(call.index);
        if (!entry) {
          entry = { canonicalIndex: nextBlockIndex++, started: false };
          toolBlocks.set(call.index, entry);
        }
        if (!entry.started) {
          entry.started = true;
          yield {
            type: 'content_block_start',
            index: entry.canonicalIndex,
            contentBlock: {
              type: 'tool_use',
              id: call.id ?? '',
              name: call.function?.name ?? '',
              input: {},
            },
          };
        }
        if (call.function?.arguments) {
          yield {
            type: 'content_block_delta',
            index: entry.canonicalIndex,
            delta: { type: 'input_json_delta', partialJson: call.function.arguments },
          };
        }
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  if (textBlockStarted) yield { type: 'content_block_stop', index: textIndex };
  for (const entry of toolBlocks.values()) {
    if (entry.started) yield { type: 'content_block_stop', index: entry.canonicalIndex };
  }

  yield {
    type: 'message_delta',
    delta: { stopReason: mapOpenAIFinishReason(finishReason ?? undefined) },
    usage: usage
      ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
      : undefined,
  };
  yield { type: 'message_stop' };
}
