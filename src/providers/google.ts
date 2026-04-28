/**
 * Google (Gemini) provider client — STUB.
 *
 * TODO: Implement using `@google/generative-ai`. Translate canonical <-> Gemini
 * Generate Content API. Match `ProviderClient` shape: `complete()` returns
 * `CanonicalResponse`, `stream()` yields `CanonicalChunk`s.
 *
 * Contributions welcome — the OpenAI client is a good reference shape.
 */

import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
} from '../types/canonical.js';

import type { ProviderClient } from './types.js';

export const googleClient: ProviderClient = {
  async complete(_req: CanonicalRequest, _apiKey: string): Promise<CanonicalResponse> {
    throw new Error(
      'Google provider not implemented yet. Contributions welcome — see CONTRIBUTING.md.',
    );
  },

  async *stream(_req: CanonicalRequest, _apiKey: string): AsyncIterable<CanonicalChunk> {
    throw new Error(
      'Google provider not implemented yet. Contributions welcome — see CONTRIBUTING.md.',
    );
  },
};
