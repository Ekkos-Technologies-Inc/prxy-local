/**
 * LocalDb — SQLite Database + QueryBuilder satisfying the StorageAdapter
 * Database interface.
 *
 * Vector search: tries to load `sqlite-vec` and create per-table virtual
 * vec_<table> tables for any table with an `embedding` column. If sqlite-vec
 * cannot be loaded, vectorSearch falls back to a pure-JS cosine scan over the
 * stored JSON-encoded embeddings — slower but always works.
 *
 * The QueryBuilder uses `?` placeholders. JSON columns (`tags`, `embedding`,
 * `metadata`) are auto-encoded on write and decoded on read.
 */

import BetterSqlite3 from 'better-sqlite3';

import type { Database, QueryBuilder } from '../types/sdk.js';

type SqliteDatabase = BetterSqlite3.Database;

/** Columns we automatically JSON-encode on write / decode on read. */
const JSON_COLUMNS = new Set(['tags', 'embedding', 'metadata']);

interface VectorSupport {
  enabled: boolean;
  reason?: string;
}

type FilterOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'is' | 'like';

interface Filter {
  op: FilterOp;
  col: string;
  val: unknown;
}

interface PendingQuery {
  table: string;
  action: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  payload?: Record<string, unknown> | Record<string, unknown>[];
  filters: Filter[];
  orderCol?: string;
  orderAsc?: boolean;
  limitN?: number;
  selectCols?: string;
  upsertOnConflict?: string;
  asSingle?: 'one' | 'maybe';
}

export class LocalDb implements Database {
  private vectorSupport: VectorSupport;
  /** Tables we've already initialized for vec storage. */
  private vectorTables = new Set<string>();

  constructor(
    private sqlite: SqliteDatabase,
    vectorSupport: VectorSupport,
  ) {
    this.vectorSupport = vectorSupport;
  }

  from(table: string): QueryBuilder {
    return new SqliteQuery(this, {
      table,
      action: 'select',
      filters: [],
    });
  }

  async raw(sql: string, params: unknown[] = []): Promise<unknown[]> {
    const trimmed = sql.trim().toLowerCase();
    if (
      trimmed.startsWith('select') ||
      trimmed.startsWith('with') ||
      trimmed.startsWith('pragma')
    ) {
      const stmt = this.sqlite.prepare(sql);
      const rows = stmt.all(...(params as never[])) as Record<string, unknown>[];
      return rows.map((r) => decodeRow(r));
    }
    const stmt = this.sqlite.prepare(sql);
    const result = stmt.run(...(params as never[]));
    return [{ changes: result.changes, lastInsertRowid: result.lastInsertRowid }];
  }

  /** Internal — exposed to the QueryBuilder. */
  _sqlite(): SqliteDatabase {
    return this.sqlite;
  }

  _vectorSupport(): VectorSupport {
    return this.vectorSupport;
  }

  _ensureVecTable(table: string): void {
    if (!this.vectorSupport.enabled) return;
    if (this.vectorTables.has(table)) return;
    const exists = this.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(`vec_${table}`) as { name?: string } | undefined;
    if (exists?.name) {
      this.vectorTables.add(table);
      return;
    }

    const row = this.sqlite
      .prepare(`SELECT embedding FROM ${quoteIdent(table)} WHERE embedding IS NOT NULL LIMIT 1`)
      .get() as { embedding?: string } | undefined;
    if (!row?.embedding) return;

    let parsed: number[];
    try {
      parsed = JSON.parse(row.embedding) as number[];
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return;

    this._createVecTable(table, parsed.length);
  }

  _createVecTable(table: string, dim: number): void {
    if (!this.vectorSupport.enabled) return;
    if (this.vectorTables.has(table)) return;
    try {
      this.sqlite.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS vec_${table} USING vec0(embedding float[${dim}])`,
      );
      this.vectorTables.add(table);
    } catch {
      this.vectorSupport = { enabled: false, reason: 'vec0_create_failed' };
    }
  }

  /** Insert a vector row tied to the parent table's rowid. */
  _insertVec(table: string, rowid: number | bigint, embedding: number[]): void {
    if (!this.vectorSupport.enabled) return;
    this._ensureVecTable(table);
    if (!this.vectorTables.has(table)) {
      this._createVecTable(table, embedding.length);
    }
    if (!this.vectorTables.has(table)) return;
    try {
      this.sqlite
        .prepare(`INSERT INTO vec_${table}(rowid, embedding) VALUES (?, ?)`)
        .run(rowid as never, JSON.stringify(embedding) as never);
    } catch {
      // Best-effort; fallback path will scan stored embeddings.
    }
  }
}

class SqliteQuery implements QueryBuilder {
  constructor(
    private parent: LocalDb,
    private q: PendingQuery,
  ) {}

  select(columns?: string): QueryBuilder {
    this.q.action = 'select';
    this.q.selectCols = columns;
    return this;
  }
  insert(data: Record<string, unknown> | Record<string, unknown>[]): QueryBuilder {
    this.q.action = 'insert';
    this.q.payload = data;
    return this;
  }
  update(data: Record<string, unknown>): QueryBuilder {
    this.q.action = 'update';
    this.q.payload = data;
    return this;
  }
  delete(): QueryBuilder {
    this.q.action = 'delete';
    return this;
  }
  upsert(data: Record<string, unknown>, opts?: { onConflict?: string }): QueryBuilder {
    this.q.action = 'upsert';
    this.q.payload = data;
    this.q.upsertOnConflict = opts?.onConflict;
    return this;
  }
  eq(col: string, val: unknown): QueryBuilder {
    this.q.filters.push({ op: 'eq', col, val });
    return this;
  }
  gt(col: string, val: unknown): QueryBuilder {
    this.q.filters.push({ op: 'gt', col, val });
    return this;
  }
  gte(col: string, val: unknown): QueryBuilder {
    this.q.filters.push({ op: 'gte', col, val });
    return this;
  }
  lt(col: string, val: unknown): QueryBuilder {
    this.q.filters.push({ op: 'lt', col, val });
    return this;
  }
  lte(col: string, val: unknown): QueryBuilder {
    this.q.filters.push({ op: 'lte', col, val });
    return this;
  }
  in(col: string, vals: unknown[]): QueryBuilder {
    this.q.filters.push({ op: 'in', col, val: vals });
    return this;
  }
  is(col: string, val: unknown): QueryBuilder {
    this.q.filters.push({ op: 'is', col, val });
    return this;
  }
  like(col: string, pat: string): QueryBuilder {
    this.q.filters.push({ op: 'like', col, val: pat });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): QueryBuilder {
    this.q.orderCol = col;
    this.q.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): QueryBuilder {
    this.q.limitN = n;
    return this;
  }
  single(): QueryBuilder {
    this.q.asSingle = 'one';
    return this;
  }
  maybeSingle(): QueryBuilder {
    this.q.asSingle = 'maybe';
    return this;
  }

  async vectorSearch(
    col: string,
    embedding: number[],
    opts: { limit: number; minScore?: number },
  ): Promise<Array<{ score: number; data: unknown }>> {
    const sqlite = this.parent._sqlite();
    const support = this.parent._vectorSupport();
    const minScore = opts.minScore ?? 0;
    const limit = Math.max(1, opts.limit);
    const table = this.q.table;

    if (support.enabled && col === 'embedding') {
      this.parent._ensureVecTable(table);
      try {
        const sql =
          `SELECT t.*, v.distance AS _vec_distance ` +
          `FROM vec_${table} v JOIN ${quoteIdent(table)} t ON t.rowid = v.rowid ` +
          `WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?`;
        const rows = sqlite
          .prepare(sql)
          .all(JSON.stringify(embedding) as never, limit as never) as Record<string, unknown>[];
        const out: Array<{ score: number; data: unknown }> = [];
        for (const row of rows) {
          const dist = Number(row._vec_distance ?? 0);
          // sqlite-vec returns L2 distance for float vectors. For unit-length
          // vectors, score ≈ 1 - (dist^2 / 2). Clamp to [0, 1].
          const score = Math.max(0, Math.min(1, 1 - (dist * dist) / 2));
          if (score < minScore) continue;
          delete row._vec_distance;
          out.push({ score, data: decodeRow(row) });
        }
        return out;
      } catch {
        // sqlite-vec path failed; fall through to JS scan.
      }
    }

    return this.jsCosineSearch(col, embedding, limit, minScore);
  }

  private jsCosineSearch(
    col: string,
    embedding: number[],
    limit: number,
    minScore: number,
  ): Array<{ score: number; data: unknown }> {
    const sqlite = this.parent._sqlite();
    const sql = `SELECT * FROM ${quoteIdent(this.q.table)} WHERE ${quoteIdent(col)} IS NOT NULL`;
    const rows = sqlite.prepare(sql).all() as Record<string, unknown>[];
    const scored: Array<{ score: number; data: unknown }> = [];
    for (const raw of rows) {
      if (!rowMatchesFilters(raw, this.q.filters)) continue;
      const decoded = decodeRow(raw);
      const vec = decoded[col];
      if (!Array.isArray(vec)) continue;
      const score = cosine(embedding, vec as number[]);
      if (score >= minScore) scored.push({ score, data: decoded });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async then<T>(resolve: (value: { data: unknown; error: Error | null }) => T): Promise<T> {
    try {
      const data = await this.execute();
      return resolve({ data, error: null });
    } catch (err) {
      return resolve({ data: null, error: err as Error });
    }
  }

  private async execute(): Promise<unknown> {
    const sqlite = this.parent._sqlite();
    const table = quoteIdent(this.q.table);

    switch (this.q.action) {
      case 'select': {
        const cols =
          this.q.selectCols && this.q.selectCols !== '*' ? this.q.selectCols : '*';
        const { whereSql, params } = buildWhere(this.q.filters);
        let sql = `SELECT ${cols} FROM ${table}${whereSql}`;
        if (this.q.orderCol) {
          sql += ` ORDER BY ${quoteIdent(this.q.orderCol)} ${
            this.q.orderAsc !== false ? 'ASC' : 'DESC'
          }`;
        }
        if (this.q.limitN != null) sql += ` LIMIT ${Math.max(0, this.q.limitN | 0)}`;
        const rows = sqlite.prepare(sql).all(...(params as never[])) as Record<
          string,
          unknown
        >[];
        const decoded = rows.map((r) => decodeRow(r));
        if (this.q.asSingle) {
          if (decoded.length === 0) {
            if (this.q.asSingle === 'maybe') return null;
            throw new Error('No rows found');
          }
          return decoded[0];
        }
        return decoded;
      }
      case 'insert': {
        const items = Array.isArray(this.q.payload)
          ? (this.q.payload as Record<string, unknown>[])
          : [this.q.payload as Record<string, unknown>];
        const inserted: Record<string, unknown>[] = [];
        for (const item of items) {
          const prepared = prepareForWrite(item);
          if (!('id' in prepared)) {
            prepared.id = randomId();
          }
          const cols = Object.keys(prepared);
          const placeholders = cols.map(() => '?').join(', ');
          const values = cols.map((c) => prepared[c]);
          const sql = `INSERT INTO ${table} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
          const stmt = sqlite.prepare(sql);
          const result = stmt.run(...(values as never[]));
          if (Array.isArray(item.embedding) && item.embedding.length > 0) {
            this.parent._insertVec(
              this.q.table,
              result.lastInsertRowid,
              item.embedding as number[],
            );
          }
          inserted.push(item);
        }
        return inserted;
      }
      case 'update': {
        const data = prepareForWrite(this.q.payload as Record<string, unknown>);
        const cols = Object.keys(data);
        if (cols.length === 0) return [];
        const setClause = cols.map((c) => `${quoteIdent(c)} = ?`).join(', ');
        const { whereSql, params } = buildWhere(this.q.filters);
        const sql = `UPDATE ${table} SET ${setClause}${whereSql}`;
        const allParams = [...cols.map((c) => data[c]), ...params];
        sqlite.prepare(sql).run(...(allParams as never[]));
        const select = `SELECT * FROM ${table}${whereSql}`;
        const rows = sqlite
          .prepare(select)
          .all(...(params as never[])) as Record<string, unknown>[];
        return rows.map((r) => decodeRow(r));
      }
      case 'delete': {
        const { whereSql, params } = buildWhere(this.q.filters);
        const select = `SELECT * FROM ${table}${whereSql}`;
        const before = sqlite
          .prepare(select)
          .all(...(params as never[])) as Record<string, unknown>[];
        const sql = `DELETE FROM ${table}${whereSql}`;
        sqlite.prepare(sql).run(...(params as never[]));
        return before.map((r) => decodeRow(r));
      }
      case 'upsert': {
        const data = prepareForWrite(this.q.payload as Record<string, unknown>);
        const conflictCol = this.q.upsertOnConflict;
        if (conflictCol && conflictCol in data) {
          const existing = sqlite
            .prepare(`SELECT * FROM ${table} WHERE ${quoteIdent(conflictCol)} = ? LIMIT 1`)
            .get(data[conflictCol] as never) as Record<string, unknown> | undefined;
          if (existing) {
            const cols = Object.keys(data);
            const setClause = cols.map((c) => `${quoteIdent(c)} = ?`).join(', ');
            const sql = `UPDATE ${table} SET ${setClause} WHERE ${quoteIdent(conflictCol)} = ?`;
            const params = [...cols.map((c) => data[c]), data[conflictCol]];
            sqlite.prepare(sql).run(...(params as never[]));
            return [decodeRow({ ...existing, ...data })];
          }
        }
        if (!('id' in data)) data.id = randomId();
        const cols = Object.keys(data);
        const placeholders = cols.map(() => '?').join(', ');
        const sql = `INSERT INTO ${table} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`;
        const stmt = sqlite.prepare(sql);
        const result = stmt.run(...(cols.map((c) => data[c]) as never[]));
        if (Array.isArray((this.q.payload as Record<string, unknown>).embedding)) {
          this.parent._insertVec(
            this.q.table,
            result.lastInsertRowid,
            (this.q.payload as Record<string, unknown>).embedding as number[],
          );
        }
        return [data];
      }
    }
    return null;
  }
}

function buildWhere(filters: Filter[]): { whereSql: string; params: unknown[] } {
  if (filters.length === 0) return { whereSql: '', params: [] };
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    switch (f.op) {
      case 'eq':
        parts.push(`${quoteIdent(f.col)} = ?`);
        params.push(f.val);
        break;
      case 'gt':
        parts.push(`${quoteIdent(f.col)} > ?`);
        params.push(f.val);
        break;
      case 'gte':
        parts.push(`${quoteIdent(f.col)} >= ?`);
        params.push(f.val);
        break;
      case 'lt':
        parts.push(`${quoteIdent(f.col)} < ?`);
        params.push(f.val);
        break;
      case 'lte':
        parts.push(`${quoteIdent(f.col)} <= ?`);
        params.push(f.val);
        break;
      case 'in': {
        const list = f.val as unknown[];
        if (list.length === 0) {
          parts.push('0 = 1');
        } else {
          parts.push(`${quoteIdent(f.col)} IN (${list.map(() => '?').join(', ')})`);
          params.push(...list);
        }
        break;
      }
      case 'is':
        if (f.val === null) {
          parts.push(`${quoteIdent(f.col)} IS NULL`);
        } else {
          parts.push(`${quoteIdent(f.col)} IS ?`);
          params.push(f.val);
        }
        break;
      case 'like':
        parts.push(`${quoteIdent(f.col)} LIKE ?`);
        params.push(f.val);
        break;
    }
  }
  return { whereSql: ` WHERE ${parts.join(' AND ')}`, params };
}

function rowMatchesFilters(row: Record<string, unknown>, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    switch (f.op) {
      case 'eq':
        if (v !== f.val) return false;
        break;
      case 'gt':
        if (!(typeof v === 'number' && typeof f.val === 'number' && v > f.val)) return false;
        break;
      case 'gte':
        if (!(typeof v === 'number' && typeof f.val === 'number' && v >= f.val)) return false;
        break;
      case 'lt':
        if (!(typeof v === 'number' && typeof f.val === 'number' && v < f.val)) return false;
        break;
      case 'lte':
        if (!(typeof v === 'number' && typeof f.val === 'number' && v <= f.val)) return false;
        break;
      case 'in':
        if (!Array.isArray(f.val) || !f.val.includes(v)) return false;
        break;
      case 'is':
        if (v !== f.val) return false;
        break;
      case 'like':
        if (typeof v !== 'string' || typeof f.val !== 'string') return false;
        if (!v.includes(f.val.replace(/%/g, ''))) return false;
        break;
    }
  }
  return true;
}

function prepareForWrite(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;
    if (JSON_COLUMNS.has(k) && v !== null && typeof v !== 'string') {
      out[k] = JSON.stringify(v);
    } else if (typeof v === 'boolean') {
      out[k] = v ? 1 : 0;
    } else if (Array.isArray(v) || (typeof v === 'object' && v !== null && !(v instanceof Buffer))) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (JSON_COLUMNS.has(k) && typeof v === 'string') {
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

function cosine(a: number[], b: number[]): number {
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

function randomId(): string {
  const rand = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}
