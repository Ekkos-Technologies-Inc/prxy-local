/**
 * Canonical request/response types — the internal format every module sees.
 * Provider clients translate canonical <-> provider-specific (Anthropic, OpenAI, etc).
 */

export interface CanonicalRequest {
  messages: CanonicalMessage[];
  system?: string | SystemBlock[];
  tools?: CanonicalTool[];
  model: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stream: boolean;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string | ContentBlock[]; isError?: boolean }
  | { type: 'image'; source: { type: 'base64' | 'url'; mediaType?: string; data: string } };

export interface SystemBlock {
  type: 'text';
  text: string;
  cacheControl?: { type: 'ephemeral' };
}

export interface CanonicalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  role: 'assistant';
  content: ContentBlock[];
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'error';
  stopSequence?: string;
  usage: CanonicalUsage;
}

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export type CanonicalChunk =
  | { type: 'message_start'; message: Partial<CanonicalResponse> }
  | { type: 'content_block_start'; index: number; contentBlock: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: ContentBlockDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: Partial<CanonicalResponse>; usage?: Partial<CanonicalUsage> }
  | { type: 'message_stop' };

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partialJson: string };

export type Provider = 'anthropic' | 'openai' | 'google' | 'groq' | 'bedrock';

/**
 * AWS credentials used by the Bedrock provider client.
 *
 * If `accessKeyId`/`secretAccessKey` are omitted the AWS SDK falls back to its
 * default credential provider chain (env vars, shared config files, IAM role,
 * IRSA, etc.). `region` is required because Bedrock model availability is
 * region-scoped.
 */
export interface AwsCredentials {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region: string;
}

export interface ApiKeyInfo {
  keyId: string;
  userId: string;
  /** Always 'local' in prxy-local. Kept on the type so modules written for
   *  the cloud edition compile without changes. */
  tier: 'local' | 'free' | 'pro' | 'team' | 'enterprise';
  pipelineConfig?: string;
  revoked: boolean;
  /** The user's actual provider API key (BYOK mode). Not used in prxy-local —
   *  provider keys come from process.env. */
  providerKey?: string;
}
