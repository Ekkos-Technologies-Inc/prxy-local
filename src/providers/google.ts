/**
 * Google (Gemini) provider client.
 *
 * Translates between the canonical request/response format and the Gemini
 * Generate Content API via the `@google/genai` SDK (the post-2024 unified
 * SDK that supersedes `@google/generative-ai`).
 *
 * Notable Gemini quirks the translator handles:
 *   - Gemini uses `contents[]` with `role: 'user' | 'model'` (not 'assistant').
 *   - System prompts go in `config.systemInstruction`, NOT in the messages array.
 *   - Tools are wrapped in `tools[].functionDeclarations[]`.
 *   - Tool calls land as `Part.functionCall` and tool results as `Part.functionResponse`.
 *   - Streaming uses `generateContentStream` and yields full `GenerateContentResponse`
 *     chunks (not deltas) — we synthesize Anthropic-style block events from them.
 *   - Token usage lives in `usageMetadata.{promptTokenCount, candidatesTokenCount}`.
 */

import {
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
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

export const googleClient: ProviderClient = {
  async complete(req: CanonicalRequest, apiKey: string): Promise<CanonicalResponse> {
    const client = makeClient(apiKey);
    const params = canonicalToGoogle(req);
    const response = await client.models.generateContent(params);
    return googleResponseToCanonical(response, req.model);
  },

  async *stream(req: CanonicalRequest, apiKey: string): AsyncIterable<CanonicalChunk> {
    const client = makeClient(apiKey);
    const params = canonicalToGoogle(req);
    const stream = await client.models.generateContentStream(params);
    yield* googleStreamToCanonical(stream, req.model);
  },
};

function makeClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

export function canonicalToGoogle(req: CanonicalRequest): GenerateContentParameters {
  const contents: Content[] = req.messages
    .filter((m) => m.role !== 'system')
    .map(canonicalMessageToGoogle);

  const config: GenerateContentConfig = {};

  if (req.system !== undefined) {
    config.systemInstruction = canonicalSystemToGoogle(req.system);
  }
  if (req.maxTokens !== undefined) config.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) config.temperature = req.temperature;
  if (req.topP !== undefined) config.topP = req.topP;
  if (req.topK !== undefined) config.topK = req.topK;
  if (req.stopSequences && req.stopSequences.length > 0) {
    config.stopSequences = req.stopSequences;
  }
  if (req.tools && req.tools.length > 0) {
    config.tools = [{ functionDeclarations: canonicalToolsToGoogle(req.tools) }];
  }

  return {
    model: req.model,
    contents,
    config,
  };
}

function canonicalMessageToGoogle(m: CanonicalMessage): Content {
  // Gemini uses 'model' for assistant role; only 'user' and 'model' are valid.
  const role = m.role === 'assistant' ? 'model' : 'user';

  if (typeof m.content === 'string') {
    return { role, parts: [{ text: m.content }] };
  }

  const parts: Part[] = [];
  for (const block of m.content) {
    if (block.type === 'text') {
      parts.push({ text: block.text });
    } else if (block.type === 'image') {
      if (block.source.type === 'base64') {
        parts.push({
          inlineData: {
            mimeType: block.source.mediaType ?? 'image/png',
            data: block.source.data,
          },
        });
      } else {
        parts.push({ text: `[image: ${block.source.data}]` });
      }
    } else if (block.type === 'tool_use') {
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        },
      });
    } else if (block.type === 'tool_result') {
      const text =
        typeof block.content === 'string'
          ? block.content
          : block.content
              .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
              .map((c) => c.text)
              .join('\n');
      parts.push({
        functionResponse: {
          id: block.toolUseId,
          name: '',
          response: block.isError ? { error: text } : { output: text },
        },
      });
    }
  }
  return { role, parts };
}

function canonicalSystemToGoogle(system: string | SystemBlock[]): string {
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

function canonicalToolsToGoogle(tools: CanonicalTool[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.inputSchema,
  }));
}

export function googleResponseToCanonical(
  response: GenerateContentResponse,
  fallbackModel: string,
): CanonicalResponse {
  const candidate = response.candidates?.[0];
  const content: ContentBlock[] = [];

  if (candidate?.content?.parts) {
    for (const part of candidate.content.parts) {
      if (part.text) {
        content.push({ type: 'text', text: part.text });
      }
      if (part.functionCall) {
        content.push({
          type: 'tool_use',
          id: part.functionCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          name: part.functionCall.name ?? '',
          input: part.functionCall.args ?? {},
        });
      }
    }
  }

  const usage = response.usageMetadata;
  return {
    id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    model: response.modelVersion ?? fallbackModel,
    role: 'assistant',
    content,
    stopReason: mapGoogleFinishReason(candidate?.finishReason),
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: usage?.candidatesTokenCount ?? 0,
      cacheReadInputTokens: usage?.cachedContentTokenCount ?? undefined,
    },
  };
}

function mapGoogleFinishReason(reason: string | undefined): CanonicalResponse['stopReason'] {
  switch (reason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'error';
    default:
      return 'end_turn';
  }
}

export async function* googleStreamToCanonical(
  stream: AsyncIterable<GenerateContentResponse>,
  fallbackModel: string,
): AsyncIterable<CanonicalChunk> {
  let messageStarted = false;
  let textBlockStarted = false;
  const textIndex = 0;
  const toolBlocks = new Map<string, { canonicalIndex: number; started: boolean }>();
  let nextBlockIndex = 1;
  let finalFinishReason: string | undefined;
  let finalUsage:
    | { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number }
    | undefined;

  for await (const chunk of stream) {
    if (!messageStarted) {
      messageStarted = true;
      yield {
        type: 'message_start',
        message: {
          id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          model: chunk.modelVersion ?? fallbackModel,
          role: 'assistant',
          content: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      };
    }

    if (chunk.usageMetadata) finalUsage = chunk.usageMetadata;

    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;

    if (candidate.finishReason) finalFinishReason = candidate.finishReason;

    const parts = candidate.content?.parts ?? [];
    for (const part of parts) {
      if (part.text) {
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
          delta: { type: 'text_delta', text: part.text },
        };
      }
      if (part.functionCall) {
        const key = part.functionCall.id ?? part.functionCall.name ?? `idx_${nextBlockIndex}`;
        let entry = toolBlocks.get(key);
        if (!entry) {
          entry = { canonicalIndex: nextBlockIndex++, started: false };
          toolBlocks.set(key, entry);
        }
        if (!entry.started) {
          entry.started = true;
          yield {
            type: 'content_block_start',
            index: entry.canonicalIndex,
            contentBlock: {
              type: 'tool_use',
              id: part.functionCall.id ?? key,
              name: part.functionCall.name ?? '',
              input: {},
            },
          };
          if (part.functionCall.args) {
            yield {
              type: 'content_block_delta',
              index: entry.canonicalIndex,
              delta: {
                type: 'input_json_delta',
                partialJson: JSON.stringify(part.functionCall.args),
              },
            };
          }
        }
      }
    }
  }

  if (textBlockStarted) yield { type: 'content_block_stop', index: textIndex };
  for (const entry of toolBlocks.values()) {
    if (entry.started) yield { type: 'content_block_stop', index: entry.canonicalIndex };
  }

  yield {
    type: 'message_delta',
    delta: { stopReason: mapGoogleFinishReason(finalFinishReason) },
    usage: finalUsage
      ? {
          inputTokens: finalUsage.promptTokenCount,
          outputTokens: finalUsage.candidatesTokenCount,
          cacheReadInputTokens: finalUsage.cachedContentTokenCount,
        }
      : undefined,
  };
  yield { type: 'message_stop' };
}
