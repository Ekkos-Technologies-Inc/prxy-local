/**
 * Embedding abstraction.
 *
 * Resolution order:
 *   1. KV cache hit (sha256 of input -> vector)
 *   2. Voyage AI (if VOYAGE_API_KEY set)
 *   3. OpenAI (if OPENAI_API_KEY set)
 *   4. Deterministic stub (hash-based) — for tests + offline / airgap dev
 *
 * Cached vectors live in `storage.kv` under `embed:<sha256>` with a 24h TTL.
 */

import { createHash } from 'node:crypto';

import type { StorageAdapter } from '../types/sdk.js';

const EMBED_TTL_SECONDS = 60 * 60 * 24; // 24h
const STUB_DIM = 256;

export interface EmbedOptions {
  /** Force a specific provider — useful in tests. */
  provider?: 'voyage' | 'openai' | 'stub';
  /** Override the model. */
  model?: string;
}

export async function getEmbedding(
  text: string,
  storage: StorageAdapter,
  opts: EmbedOptions = {},
): Promise<number[]> {
  const hash = sha256(text);
  const cacheKey = `embed:${hash}`;

  // KV cache hit
  try {
    const cached = await storage.kv.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as number[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // fall through — cache failures shouldn't block embedding
  }

  const provider = opts.provider ?? pickProvider();
  let vec: number[];

  try {
    if (provider === 'voyage') {
      vec = await embedVoyage(text, opts.model ?? process.env.EMBEDDING_MODEL ?? 'voyage-3-lite');
    } else if (provider === 'openai') {
      vec = await embedOpenAI(text, opts.model ?? 'text-embedding-3-small');
    } else {
      vec = stubEmbed(text);
    }
  } catch {
    // Any provider failure -> stub. Modules need to keep working in adverse conditions.
    vec = stubEmbed(text);
  }

  // Best-effort cache write
  try {
    await storage.kv.set(cacheKey, JSON.stringify(vec), EMBED_TTL_SECONDS);
  } catch {
    /* ignore */
  }

  return vec;
}

function pickProvider(): 'voyage' | 'openai' | 'stub' {
  if (process.env.VOYAGE_API_KEY) return 'voyage';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'stub';
}

async function embedVoyage(text: string, model: string): Promise<number[]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: [text], model }),
  });
  if (!res.ok) throw new Error(`Voyage embed failed: ${res.status}`);
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

async function embedOpenAI(text: string, model: string): Promise<number[]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ input: text, model }),
  });
  if (!res.ok) throw new Error(`OpenAI embed failed: ${res.status}`);
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

/**
 * Deterministic, offline-safe stub embedding. Hash-based bag-of-trigrams
 * projected into STUB_DIM floats then L2-normalized. Quality is poor but
 * stable — same text always returns the same vector, so caches and similarity
 * searches behave predictably in tests, local dev, and air-gapped setups.
 */
export function stubEmbed(text: string): number[] {
  const vec = new Array<number>(STUB_DIM).fill(0);
  const normalized = text.toLowerCase().trim();
  if (!normalized) return vec;
  for (let i = 0; i < normalized.length - 2; i++) {
    const tri = normalized.slice(i, i + 3);
    const h = sha256(tri);
    // Use 4 bytes from the hash to pick an index, next 4 bytes for the weight.
    const idx = parseInt(h.slice(0, 8), 16) % STUB_DIM;
    const sign = parseInt(h.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    vec[idx] += sign * 1;
  }
  // L2 normalize so cosine similarity == dot product.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
