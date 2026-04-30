/**
 * Module SDK interfaces — inlined from `@prxy/module-sdk`.
 *
 * Modules are composable middleware: they pre-process requests, post-process
 * responses, and can short-circuit the pipeline (e.g. on a cache hit). They
 * access storage via an adapter that hides the backend (SQLite here, Postgres
 * + Redis + R2 in the cloud edition).
 */

import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalChunk,
  ApiKeyInfo,
} from './canonical.js';

export interface Module {
  /** Stable module name (matches PRXY_PIPE entries). */
  name: string;
  /** Semver. */
  version: string;
  /** Optional one-shot setup at server start. */
  init?(storage: StorageAdapter): Promise<void>;
  /** Pre-request hook. Can mutate the request or short-circuit with a cached response. */
  pre?(ctx: RequestContext): Promise<PreResult>;
  /** Per-chunk hook for streaming responses. */
  stream?(chunk: CanonicalChunk, ctx: ResponseContext): Promise<CanonicalChunk>;
  /** Post-response hook. Side effects only — does not block the response to the client. */
  post?(ctx: ResponseContext): Promise<void>;
}

export type PreResult =
  | { continue: true }
  | { continue: false; response: CanonicalResponse };

export interface RequestContext {
  request: CanonicalRequest;
  metadata: Map<string, unknown>;
  storage: StorageAdapter;
  apiKey: ApiKeyInfo;
  logger: Logger;
  startTime: number;
}

export interface ResponseContext extends RequestContext {
  response: CanonicalResponse;
  durationMs: number;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * StorageAdapter — modules access KV, DB, and blob via this interface. In
 * prxy-monster-local everything is backed by SQLite + filesystem + an in-memory KV.
 */
export interface StorageAdapter {
  kind: 'cloud' | 'local';
  kv: KvStore;
  db: Database;
  blob: BlobStore;
  health(): Promise<HealthStatus>;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  ttl(key: string): Promise<number>;
}

export interface Database {
  from(table: string): QueryBuilder;
  raw(sql: string, params?: unknown[]): Promise<unknown[]>;
}

export interface QueryBuilder {
  select(columns?: string): QueryBuilder;
  insert(data: Record<string, unknown> | Record<string, unknown>[]): QueryBuilder;
  update(data: Record<string, unknown>): QueryBuilder;
  delete(): QueryBuilder;
  upsert(data: Record<string, unknown>, opts?: { onConflict?: string }): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  gt(col: string, val: unknown): QueryBuilder;
  gte(col: string, val: unknown): QueryBuilder;
  lt(col: string, val: unknown): QueryBuilder;
  lte(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  is(col: string, val: unknown): QueryBuilder;
  like(col: string, pat: string): QueryBuilder;
  order(col: string, opts?: { ascending?: boolean }): QueryBuilder;
  limit(n: number): QueryBuilder;
  single(): QueryBuilder;
  maybeSingle(): QueryBuilder;
  vectorSearch(
    col: string,
    embedding: number[],
    opts: { limit: number; minScore?: number },
  ): Promise<Array<{ score: number; data: unknown }>>;
  then<T>(resolve: (value: { data: unknown; error: Error | null }) => T): Promise<T>;
}

export interface BlobStore {
  put(key: string, content: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface HealthStatus {
  ok: boolean;
  details?: Record<string, unknown>;
}
