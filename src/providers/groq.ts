/**
 * Groq provider client — STUB.
 *
 * TODO: Implement using `groq-sdk` (OpenAI-compatible Chat Completions surface).
 * Largely mirrors the OpenAI client. Contributions welcome — see CONTRIBUTING.md.
 */

import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
} from '../types/canonical.js';

import type { ProviderClient } from './types.js';

export const groqClient: ProviderClient = {
  async complete(_req: CanonicalRequest, _apiKey: string): Promise<CanonicalResponse> {
    throw new Error(
      'Groq provider not implemented yet. Contributions welcome — see CONTRIBUTING.md.',
    );
  },

  async *stream(_req: CanonicalRequest, _apiKey: string): AsyncIterable<CanonicalChunk> {
    throw new Error(
      'Groq provider not implemented yet. Contributions welcome — see CONTRIBUTING.md.',
    );
  },
};
