/**
 * Provider client registry — translate canonical request/response <-> provider-specific.
 *
 * v0.3.0: Anthropic + OpenAI + Google (Gemini) + Groq + AWS Bedrock all
 * implemented.
 */

import type { Provider } from '../types/canonical.js';

import { anthropicClient } from './anthropic.js';
import { bedrockClient } from './bedrock.js';
import { googleClient } from './google.js';
import { groqClient } from './groq.js';
import { openaiClient } from './openai.js';
import type { ProviderClient } from './types.js';

export type { ProviderClient } from './types.js';

export {
  anthropicClient,
  canonicalToAnthropic,
  anthropicResponseToCanonical,
  anthropicStreamEventToCanonical,
} from './anthropic.js';

export {
  openaiClient,
  canonicalToOpenAI,
  openaiResponseToCanonical,
  openaiStreamToCanonical,
} from './openai.js';

export {
  googleClient,
  canonicalToGoogle,
  googleResponseToCanonical,
  googleStreamToCanonical,
} from './google.js';
export { groqClient } from './groq.js';

export {
  bedrockClient,
  canonicalToBedrock,
  bedrockResponseToCanonical,
  bedrockStreamToCanonical,
  encodeBedrockCredentials,
} from './bedrock.js';

export const providerClients: Record<Provider, ProviderClient> = {
  anthropic: anthropicClient,
  openai: openaiClient,
  google: googleClient,
  groq: groqClient,
  bedrock: bedrockClient,
};

export function getProviderClient(provider: Provider): ProviderClient {
  const client = providerClients[provider];
  if (!client) throw new Error(`No client registered for provider: ${provider}`);
  return client;
}

export function detectProvider(model: string): Provider {
  // Bedrock is checked first because it can host Anthropic / Meta / etc.
  // models — the `bedrock/` prefix is the unambiguous routing signal.
  if (model.startsWith('bedrock/')) return 'bedrock';
  if (model.startsWith('claude-')) return 'anthropic';
  if (
    model.startsWith('gpt-') ||
    model === 'o3' ||
    model.startsWith('o1') ||
    model.startsWith('o3-') ||
    model.startsWith('o4-')
  ) {
    return 'openai';
  }
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('llama') || model.startsWith('groq/') || model.startsWith('mixtral')) {
    return 'groq';
  }
  throw new Error(`Unknown model: ${model}`);
}
