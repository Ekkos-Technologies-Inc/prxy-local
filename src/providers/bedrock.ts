/**
 * Bedrock provider client (prxy-monster-local edition).
 *
 * Translates between the canonical request/response format and the AWS Bedrock
 * Converse API. Bedrock hosts Claude (Anthropic), Llama (Meta), Titan (Amazon),
 * Mistral, and Cohere models behind a single unified endpoint.
 *
 * Why Converse and not InvokeModel:
 *   - Converse is the unified API. Same request shape for every hosted model.
 *   - Converse supports tools and streaming (ConverseStream).
 *   - InvokeModel still works but requires per-vendor body marshalling.
 *
 * Auth: caller passes a JSON-encoded `AwsCredentials` blob in the apiKey slot,
 * OR a bare region string (uses SDK default credential chain — env vars,
 * shared config, IAM role, IRSA, etc.). The `apiKey` slot is reused so the
 * ProviderClient interface stays uniform across providers.
 *
 * Model name format: `bedrock/<model-id>` — for example
 * `bedrock/anthropic.claude-sonnet-4-20250514-v1:0`. The `bedrock/` prefix is
 * stripped before being sent to the SDK.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock as BedrockContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamOutput,
  type Message as BedrockMessage,
  type SystemContentBlock as BedrockSystemBlock,
  type Tool as BedrockTool,
} from '@aws-sdk/client-bedrock-runtime';

import type {
  AwsCredentials,
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalTool,
  ContentBlock,
  SystemBlock,
} from '../types/canonical.js';

import type { ProviderClient } from './types.js';

export const bedrockClient: ProviderClient = {
  async complete(req: CanonicalRequest, credentials: string): Promise<CanonicalResponse> {
    const creds = parseCredentials(credentials);
    const client = makeClient(creds);
    const params = canonicalToBedrock(req);
    const response = await client.send(new ConverseCommand(params));
    return bedrockResponseToCanonical(response, stripBedrockPrefix(req.model));
  },

  async *stream(req: CanonicalRequest, credentials: string): AsyncIterable<CanonicalChunk> {
    const creds = parseCredentials(credentials);
    const client = makeClient(creds);
    const params = canonicalToBedrock(req);
    const response = await client.send(new ConverseStreamCommand(params));
    if (!response.stream) return;
    yield* bedrockStreamToCanonical(response.stream, stripBedrockPrefix(req.model));
  },
};

/**
 * Encode an AwsCredentials object as the opaque string the ProviderClient
 * interface expects.
 */
export function encodeBedrockCredentials(creds: AwsCredentials): string {
  return JSON.stringify(creds);
}

function parseCredentials(blob: string): AwsCredentials {
  if (blob.startsWith('{')) {
    try {
      const parsed = JSON.parse(blob) as AwsCredentials;
      if (!parsed.region) throw new Error('AwsCredentials.region is required');
      return parsed;
    } catch (err) {
      throw new Error(`bedrockClient: failed to parse credentials JSON: ${(err as Error).message}`);
    }
  }
  // Bare-string fallback: treat as region, rely on SDK default chain.
  return { region: blob };
}

function makeClient(creds: AwsCredentials): BedrockRuntimeClient {
  const cfg: ConstructorParameters<typeof BedrockRuntimeClient>[0] = { region: creds.region };
  if (creds.accessKeyId && creds.secretAccessKey) {
    cfg.credentials = {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    };
  }
  return new BedrockRuntimeClient(cfg);
}

function stripBedrockPrefix(model: string): string {
  return model.startsWith('bedrock/') ? model.slice('bedrock/'.length) : model;
}

// ─────────────────────────────────────────────────────────────────
// canonical → Bedrock Converse
// ─────────────────────────────────────────────────────────────────

export function canonicalToBedrock(req: CanonicalRequest): ConverseCommandInput {
  const messages: BedrockMessage[] = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: canonicalContentToBedrock(m.content),
    }));

  const out: ConverseCommandInput = {
    modelId: stripBedrockPrefix(req.model),
    messages,
    inferenceConfig: {
      maxTokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { topP: req.topP } : {}),
      ...(req.stopSequences && req.stopSequences.length > 0
        ? { stopSequences: req.stopSequences }
        : {}),
    },
  };

  if (req.system !== undefined) {
    out.system = canonicalSystemToBedrock(req.system);
  }
  if (req.tools && req.tools.length > 0) {
    out.toolConfig = { tools: canonicalToolsToBedrock(req.tools) };
  }
  return out;
}

function canonicalContentToBedrock(
  content: string | ContentBlock[],
): BedrockContentBlock[] {
  if (typeof content === 'string') {
    return [{ text: content } as BedrockContentBlock];
  }
  return content.map(canonicalBlockToBedrock);
}

function canonicalBlockToBedrock(block: ContentBlock): BedrockContentBlock {
  switch (block.type) {
    case 'text':
      return { text: block.text } as BedrockContentBlock;
    case 'tool_use':
      return {
        toolUse: {
          toolUseId: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        },
      } as BedrockContentBlock;
    case 'tool_result': {
      const inner = typeof block.content === 'string'
        ? [{ text: block.content }]
        : block.content
            .filter((c): c is Extract<ContentBlock, { type: 'text' }> => c.type === 'text')
            .map((c) => ({ text: c.text }));
      return {
        toolResult: {
          toolUseId: block.toolUseId,
          content: inner,
          ...(block.isError ? { status: 'error' as const } : {}),
        },
      } as BedrockContentBlock;
    }
    case 'image': {
      if (block.source.type !== 'base64') {
        return { text: '[image:url-unsupported]' } as BedrockContentBlock;
      }
      const format = mediaTypeToBedrockFormat(block.source.mediaType);
      return {
        image: {
          format,
          source: { bytes: Buffer.from(block.source.data, 'base64') },
        },
      } as BedrockContentBlock;
    }
  }
}

function mediaTypeToBedrockFormat(mediaType?: string): 'png' | 'jpeg' | 'gif' | 'webp' {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpeg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/png':
    default:
      return 'png';
  }
}

function canonicalSystemToBedrock(
  system: string | SystemBlock[],
): BedrockSystemBlock[] {
  if (typeof system === 'string') return [{ text: system } as BedrockSystemBlock];
  return system.map((b) => ({ text: b.text } as BedrockSystemBlock));
}

function canonicalToolsToBedrock(tools: CanonicalTool[]): BedrockTool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.inputSchema as Record<string, unknown> },
    },
  } as BedrockTool));
}

// ─────────────────────────────────────────────────────────────────
// Bedrock → canonical (response)
// ─────────────────────────────────────────────────────────────────

export function bedrockResponseToCanonical(
  msg: ConverseCommandOutput,
  modelId: string,
): CanonicalResponse {
  const content: ContentBlock[] = [];
  const blocks = msg.output?.message?.content ?? [];
  for (const b of blocks) {
    const translated = bedrockBlockToCanonical(b);
    if (translated) content.push(translated);
  }
  return {
    id: msg.$metadata?.requestId ?? `bedrock_${Date.now()}`,
    model: modelId,
    role: 'assistant',
    content,
    stopReason: mapBedrockStopReason(msg.stopReason),
    usage: {
      inputTokens: msg.usage?.inputTokens ?? 0,
      outputTokens: msg.usage?.outputTokens ?? 0,
      ...(msg.usage?.cacheReadInputTokens
        ? { cacheReadInputTokens: msg.usage.cacheReadInputTokens }
        : {}),
      ...(msg.usage?.cacheWriteInputTokens
        ? { cacheCreationInputTokens: msg.usage.cacheWriteInputTokens }
        : {}),
    },
  };
}

function bedrockBlockToCanonical(block: BedrockContentBlock): ContentBlock | null {
  const b = block as unknown as Record<string, unknown>;
  if (typeof b.text === 'string') return { type: 'text', text: b.text };
  if (b.toolUse) {
    const t = b.toolUse as { toolUseId?: string; name?: string; input?: unknown };
    return {
      type: 'tool_use',
      id: t.toolUseId ?? '',
      name: t.name ?? '',
      input: t.input,
    };
  }
  return null;
}

function mapBedrockStopReason(reason?: string): CanonicalResponse['stopReason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'error';
    default:
      return 'end_turn';
  }
}

// ─────────────────────────────────────────────────────────────────
// Bedrock → canonical (streaming)
// ─────────────────────────────────────────────────────────────────

export async function* bedrockStreamToCanonical(
  stream: AsyncIterable<ConverseStreamOutput>,
  modelId: string,
): AsyncIterable<CanonicalChunk> {
  for await (const event of stream) {
    if ('messageStart' in event && event.messageStart) {
      yield {
        type: 'message_start',
        message: { id: `bedrock_${Date.now()}`, model: modelId, role: 'assistant', content: [] },
      };
      continue;
    }
    if ('contentBlockStart' in event && event.contentBlockStart) {
      const start = event.contentBlockStart;
      const idx = start.contentBlockIndex ?? 0;
      const tool = start.start?.toolUse;
      if (tool) {
        yield {
          type: 'content_block_start',
          index: idx,
          contentBlock: {
            type: 'tool_use',
            id: tool.toolUseId ?? '',
            name: tool.name ?? '',
            input: {},
          },
        };
      } else {
        yield {
          type: 'content_block_start',
          index: idx,
          contentBlock: { type: 'text', text: '' },
        };
      }
      continue;
    }
    if ('contentBlockDelta' in event && event.contentBlockDelta) {
      const delta = event.contentBlockDelta;
      const idx = delta.contentBlockIndex ?? 0;
      if (delta.delta && typeof (delta.delta as { text?: string }).text === 'string') {
        yield {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: (delta.delta as { text: string }).text },
        };
      } else if (delta.delta && (delta.delta as { toolUse?: { input?: string } }).toolUse) {
        const t = (delta.delta as { toolUse: { input?: string } }).toolUse;
        if (typeof t.input === 'string') {
          yield {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partialJson: t.input },
          };
        }
      }
      continue;
    }
    if ('contentBlockStop' in event && event.contentBlockStop) {
      yield {
        type: 'content_block_stop',
        index: event.contentBlockStop.contentBlockIndex ?? 0,
      };
      continue;
    }
    if ('messageStop' in event && event.messageStop) {
      yield {
        type: 'message_delta',
        delta: { stopReason: mapBedrockStopReason(event.messageStop.stopReason) },
      };
      continue;
    }
    if ('metadata' in event && event.metadata) {
      const m = event.metadata;
      if (m.usage) {
        yield {
          type: 'message_delta',
          delta: {},
          usage: {
            inputTokens: m.usage.inputTokens ?? 0,
            outputTokens: m.usage.outputTokens ?? 0,
          },
        };
      }
      continue;
    }
  }
  yield { type: 'message_stop' };
}
