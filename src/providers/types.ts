/**
 * Shared internal types for provider clients.
 */

import type {
  CanonicalChunk,
  CanonicalRequest,
  CanonicalResponse,
} from '../types/canonical.js';

export interface ProviderClient {
  complete(req: CanonicalRequest, apiKey: string): Promise<CanonicalResponse>;
  stream(req: CanonicalRequest, apiKey: string): AsyncIterable<CanonicalChunk>;
}
