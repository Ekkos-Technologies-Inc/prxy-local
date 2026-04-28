/**
 * Provider router — chooses the right provider client for a model and
 * dispatches to either `complete()` or `stream()`.
 */

import { detectProvider, getProviderClient } from '../providers/index.js';
import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
  Provider,
} from '../types/canonical.js';

import { GatewayError } from './errors.js';

export interface ProviderKeyResolver {
  (provider: Provider): string | undefined;
}

export async function routeComplete(
  req: CanonicalRequest,
  resolveKey: ProviderKeyResolver,
): Promise<CanonicalResponse> {
  const provider = detectProvider(req.model);
  const apiKey = resolveKey(provider);
  if (!apiKey) {
    throw new GatewayError(
      500,
      'internal_error',
      `No API key configured for provider '${provider}'. Set the corresponding *_API_KEY env var.`,
    );
  }
  const client = getProviderClient(provider);
  return client.complete(req, apiKey);
}

export function routeStream(
  req: CanonicalRequest,
  resolveKey: ProviderKeyResolver,
): AsyncIterable<CanonicalChunk> {
  const provider = detectProvider(req.model);
  const apiKey = resolveKey(provider);
  if (!apiKey) {
    throw new GatewayError(
      500,
      'internal_error',
      `No API key configured for provider '${provider}'. Set the corresponding *_API_KEY env var.`,
    );
  }
  const client = getProviderClient(provider);
  return client.stream(req, apiKey);
}

/**
 * Default key resolver — reads from process.env.
 */
export const envKeyResolver: ProviderKeyResolver = (provider) => {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY;
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'google':
      return process.env.GOOGLE_API_KEY;
    case 'groq':
      return process.env.GROQ_API_KEY;
    default:
      return undefined;
  }
};
