/**
 * Groq provider client.
 *
 * Groq's API surface is OpenAI-compatible (same Chat Completions shape, same
 * tool-calling format). We delegate the canonical ↔ OpenAI translation to the
 * shared OpenAI translator and ship the translated payload through the
 * `groq-sdk` client.
 */

import Groq from 'groq-sdk';
import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
} from '../types/canonical.js';

import { canonicalToOpenAI, openaiResponseToCanonical, openaiStreamToCanonical } from './openai.js';
import type { ProviderClient } from './types.js';

export const groqClient: ProviderClient = {
  async complete(req: CanonicalRequest, apiKey: string): Promise<CanonicalResponse> {
    const client = makeClient(apiKey);
    const params = canonicalToOpenAI(req, false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completion = await client.chat.completions.create(params as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return openaiResponseToCanonical(completion as any);
  },

  async *stream(req: CanonicalRequest, apiKey: string): AsyncIterable<CanonicalChunk> {
    const client = makeClient(apiKey);
    const params = canonicalToOpenAI(req, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await client.chat.completions.create(params as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yield* openaiStreamToCanonical(stream as any);
  },
};

function makeClient(apiKey: string): Groq {
  return new Groq({ apiKey });
}
