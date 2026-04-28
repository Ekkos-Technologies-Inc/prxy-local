/**
 * Test helpers — fake StorageAdapter, RequestContext builder, no-op logger.
 */

import type {
  ApiKeyInfo,
  CanonicalRequest,
  CanonicalResponse,
} from '../src/types/canonical.js';
import type {
  BlobStore,
  Database,
  HealthStatus,
  KvStore,
  Logger,
  QueryBuilder,
  RequestContext,
  ResponseContext,
  StorageAdapter,
} from '../src/types/sdk.js';

class FakeKv implements KvStore {
  store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt != null && Date.now() > e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
  }
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.store.has(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  async ttl(): Promise<number> {
    return -1;
  }
}

interface Filter {
  col: string;
  val: unknown;
}

class FakeQuery implements QueryBuilder {
  private filters: Filter[] = [];
  private payload: Record<string, unknown> | Record<string, unknown>[] | undefined;
  private action: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private limitN: number | undefined;
  private orderCol: string | undefined;
  private orderAsc = true;
  private asSingle: 'one' | 'maybe' | undefined;

  constructor(private db: FakeDb, private table: string) {}

  select(): QueryBuilder {
    this.action = 'select';
    return this;
  }
  insert(data: Record<string, unknown> | Record<string, unknown>[]): QueryBuilder {
    this.action = 'insert';
    this.payload = data;
    return this;
  }
  update(data: Record<string, unknown>): QueryBuilder {
    this.action = 'update';
    this.payload = data;
    return this;
  }
  delete(): QueryBuilder {
    this.action = 'delete';
    return this;
  }
  upsert(data: Record<string, unknown>): QueryBuilder {
    this.action = 'upsert';
    this.payload = data;
    return this;
  }
  eq(col: string, val: unknown): QueryBuilder {
    this.filters.push({ col, val });
    return this;
  }
  gt(): QueryBuilder { return this; }
  gte(): QueryBuilder { return this; }
  lt(): QueryBuilder { return this; }
  lte(): QueryBuilder { return this; }
  in(): QueryBuilder { return this; }
  is(): QueryBuilder { return this; }
  like(): QueryBuilder { return this; }
  order(col: string, opts?: { ascending?: boolean }): QueryBuilder {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): QueryBuilder {
    this.limitN = n;
    return this;
  }
  single(): QueryBuilder {
    this.asSingle = 'one';
    return this;
  }
  maybeSingle(): QueryBuilder {
    this.asSingle = 'maybe';
    return this;
  }

  async vectorSearch(
    col: string,
    embedding: number[],
    opts: { limit: number; minScore?: number },
  ): Promise<Array<{ score: number; data: unknown }>> {
    const rows = this.db.rows(this.table);
    const minScore = opts.minScore ?? 0;
    const scored: Array<{ score: number; data: unknown }> = [];
    for (const row of rows) {
      const vec = row[col];
      if (!Array.isArray(vec)) continue;
      const score = cosine(embedding, vec as number[]);
      if (score >= minScore) scored.push({ score, data: row });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.limit);
  }

  async then<T>(resolve: (v: { data: unknown; error: Error | null }) => T): Promise<T> {
    const rows = this.db.rows(this.table);
    if (this.action === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload!];
      for (const it of items) rows.push({ ...it });
      return resolve({ data: items, error: null });
    }
    if (this.action === 'select') {
      let out = rows.filter((r) => this.filters.every((f) => r[f.col] === f.val));
      if (this.orderCol) {
        const c = this.orderCol;
        const asc = this.orderAsc;
        out = [...out].sort((a, b) => {
          const av = a[c] as unknown as number;
          const bv = b[c] as unknown as number;
          if (av === bv) return 0;
          return av < bv ? (asc ? -1 : 1) : asc ? 1 : -1;
        });
      }
      if (this.limitN != null) out = out.slice(0, this.limitN);
      if (this.asSingle) {
        if (out.length === 0)
          return resolve({ data: this.asSingle === 'maybe' ? null : null, error: null });
        return resolve({ data: out[0], error: null });
      }
      return resolve({ data: out, error: null });
    }
    if (this.action === 'update') {
      const matched = rows.filter((r) => this.filters.every((f) => r[f.col] === f.val));
      for (const r of matched) Object.assign(r, this.payload as Record<string, unknown>);
      return resolve({ data: matched, error: null });
    }
    if (this.action === 'delete') {
      const removed: Record<string, unknown>[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (this.filters.every((f) => rows[i][f.col] === f.val)) {
          removed.push(rows[i]);
          rows.splice(i, 1);
        }
      }
      return resolve({ data: removed, error: null });
    }
    if (this.action === 'upsert') {
      const item = this.payload as Record<string, unknown>;
      rows.push({ ...item });
      return resolve({ data: [item], error: null });
    }
    return resolve({ data: null, error: null });
  }
}

class FakeDb implements Database {
  tables = new Map<string, Record<string, unknown>[]>();

  from(table: string): QueryBuilder {
    return new FakeQuery(this, table);
  }
  async raw(): Promise<unknown[]> {
    return [];
  }
  rows(table: string): Record<string, unknown>[] {
    let arr = this.tables.get(table);
    if (!arr) {
      arr = [];
      this.tables.set(table, arr);
    }
    return arr;
  }
}

class FakeBlob implements BlobStore {
  m = new Map<string, Buffer>();
  async put(k: string, v: Buffer | string): Promise<void> {
    this.m.set(k, typeof v === 'string' ? Buffer.from(v) : v);
  }
  async get(k: string): Promise<Buffer | null> {
    return this.m.get(k) ?? null;
  }
  async delete(k: string): Promise<void> {
    this.m.delete(k);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
}

export class FakeStorage implements StorageAdapter {
  kind = 'local' as const;
  kv = new FakeKv();
  db = new FakeDb();
  blob = new FakeBlob();
  async health(): Promise<HealthStatus> {
    return { ok: true };
  }
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'claude-sonnet-4',
    maxTokens: 1024,
    stream: false,
    messages: [{ role: 'user', content: 'hello world' }],
    ...overrides,
  };
}

export function makeResponse(overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'msg_test',
    model: 'claude-sonnet-4',
    role: 'assistant',
    content: [{ type: 'text', text: 'hi back' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 5, outputTokens: 3 },
    ...overrides,
  };
}

export function makeApiKey(overrides: Partial<ApiKeyInfo> = {}): ApiKeyInfo {
  return {
    keyId: 'test-key',
    userId: 'test-user',
    tier: 'local',
    revoked: false,
    ...overrides,
  };
}

export function makeContext(
  request = makeRequest(),
  storage: StorageAdapter = new FakeStorage(),
): RequestContext {
  return {
    request,
    apiKey: makeApiKey(),
    storage,
    logger: noopLogger,
    metadata: new Map(),
    startTime: Date.now(),
  };
}

export function makeResponseContext(
  request = makeRequest(),
  response = makeResponse(),
  storage: StorageAdapter = new FakeStorage(),
): ResponseContext {
  return {
    request,
    response,
    apiKey: makeApiKey(),
    storage,
    logger: noopLogger,
    metadata: new Map(),
    startTime: Date.now(),
    durationMs: 100,
  };
}
