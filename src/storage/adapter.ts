/**
 * LocalAdapter — single-process storage backed by SQLite + filesystem + in-memory KV.
 *
 * What it provides:
 *   - kv: in-memory Map with TTL cleanup timer
 *   - db: better-sqlite3 with optional sqlite-vec for vector search
 *   - blob: filesystem under <PRXY_DATA_DIR>/blobs/
 *
 * Migration files live under ./migrations/. They are applied on init().
 *
 * The SQLite database file lives at <PRXY_DATA_DIR>/prxy.db. WAL is enabled
 * for concurrent reader/writer safety.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import BetterSqlite3 from 'better-sqlite3';

import type { BlobStore, HealthStatus, StorageAdapter } from '../types/sdk.js';

import { LocalBlob } from './blob.js';
import { BlobS3, buildS3Client } from './blob-s3.js';
import { LocalDb } from './db.js';
import { LocalKv } from './kv.js';
import { createMigrationRunner } from './migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type BlobBackend = 'fs' | 's3';

export interface LocalAdapterOptions {
  /** Override PRXY_DATA_DIR. Defaults to env or ./data. */
  dataDir?: string;
  /** Override path to migration files. Mostly for tests. */
  migrationsDir?: string;
  /** Disable the KV cleanup timer (test ergonomics). */
  kvCleanupIntervalMs?: number;
  /**
   * Blob backend selector. Default: 'fs' (filesystem under <dataDir>/blobs/).
   * Set to 's3' to store blobs in an S3 bucket instead — useful for
   * "local-mode-on-AWS" deploys (EC2 / ECS / App Runner) where you want
   * blobs to survive instance churn without setting up an EFS mount.
   *
   * Configurable via env: BLOB_BACKEND=fs|s3
   */
  blobBackend?: BlobBackend;
  /** S3 bucket name. Required when blobBackend='s3'. Env: S3_BUCKET. */
  s3Bucket?: string;
  /** AWS region. Required when blobBackend='s3'. Env: AWS_REGION. */
  s3Region?: string;
  /** AWS access key. Optional — omit to use the SDK default credential chain. */
  s3AccessKeyId?: string;
  /** AWS secret. Optional — omit to use the SDK default credential chain. */
  s3SecretAccessKey?: string;
}

export class LocalAdapter implements StorageAdapter {
  kind = 'local' as const;
  kv!: LocalKv;
  db!: LocalDb;
  blob!: BlobStore;

  private sqlite: BetterSqlite3.Database | null = null;
  private dataDir!: string;
  private migrationsDir: string;
  private vectorEnabled = false;
  private vectorReason?: string;

  constructor(private opts: LocalAdapterOptions = {}) {
    this.migrationsDir = opts.migrationsDir ?? join(__dirname, 'migrations');
  }

  async init(): Promise<void> {
    this.dataDir = this.opts.dataDir ?? process.env.PRXY_DATA_DIR ?? './data';
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(join(this.dataDir, 'blobs'), { recursive: true });
    await fs.mkdir(join(this.dataDir, 'evictions'), { recursive: true });

    const dbPath = join(this.dataDir, 'prxy.db');
    this.sqlite = new BetterSqlite3(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.sqlite.pragma('foreign_keys = ON');

    // Try sqlite-vec. Optional dependency; if absent or load fails, fall back
    // to JS-cosine vector search inside the QueryBuilder.
    await this.tryLoadSqliteVec();

    this.kv = new LocalKv({ cleanupIntervalMs: this.opts.kvCleanupIntervalMs });
    this.db = new LocalDb(this.sqlite, {
      enabled: this.vectorEnabled,
      reason: this.vectorReason,
    });

    const backend = (this.opts.blobBackend
      ?? (process.env.BLOB_BACKEND as BlobBackend | undefined)
      ?? 'fs') satisfies BlobBackend;

    if (backend === 's3') {
      const region = this.opts.s3Region ?? process.env.AWS_REGION ?? process.env.S3_REGION;
      const bucket = this.opts.s3Bucket ?? process.env.S3_BUCKET;
      if (!region) {
        throw new Error('LocalAdapter (BLOB_BACKEND=s3): AWS_REGION (or S3_REGION) is required');
      }
      if (!bucket) {
        throw new Error('LocalAdapter (BLOB_BACKEND=s3): S3_BUCKET is required');
      }
      const client = buildS3Client({
        region,
        accessKeyId: this.opts.s3AccessKeyId ?? process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: this.opts.s3SecretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY,
      });
      this.blob = new BlobS3({ client, bucket });
    } else {
      const local = new LocalBlob({ dataDir: this.dataDir });
      await local.init();
      this.blob = local;
    }

    await this.runMigrations();
  }

  async shutdown(): Promise<void> {
    this.kv?.shutdown();
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }
  }

  async health(): Promise<HealthStatus> {
    return {
      ok: true,
      details: {
        kind: 'local',
        dataDir: this.dataDir,
        vectorBackend: this.vectorEnabled ? 'sqlite-vec' : 'js-cosine',
        vectorReason: this.vectorReason,
        kvSize: this.kv?.size?.() ?? 0,
      },
    };
  }

  private async tryLoadSqliteVec(): Promise<void> {
    if (!this.sqlite) return;
    try {
      // Optional dependency. Use a string variable to keep tsc + node loaders happy.
      const modName = 'sqlite-vec';
      const mod = (await import(modName)) as
        | { load(db: unknown): void }
        | { default?: { load(db: unknown): void } };
      const loader = (mod as { load?: unknown }).load
        ? (mod as { load: (db: unknown) => void }).load
        : (mod as { default?: { load(db: unknown): void } }).default?.load;
      if (typeof loader !== 'function') {
        this.vectorEnabled = false;
        this.vectorReason = 'sqlite-vec module missing load()';
        return;
      }
      loader(this.sqlite);
      this.vectorEnabled = true;
    } catch (err) {
      this.vectorEnabled = false;
      this.vectorReason = `sqlite-vec unavailable: ${(err as Error).message ?? 'unknown'}`;
    }
  }

  private async runMigrations(): Promise<void> {
    if (!this.sqlite) throw new Error('sqlite not initialized');
    const sqlite = this.sqlite;
    const runner = createMigrationRunner({
      dir: this.migrationsDir,
      bootstrap: async () => {
        sqlite.exec(
          `CREATE TABLE IF NOT EXISTS _migrations (
             version INTEGER PRIMARY KEY,
             name    TEXT NOT NULL,
             applied_at INTEGER DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
           )`,
        );
      },
      apply: async (file) => {
        const existing = sqlite
          .prepare(`SELECT version FROM _migrations WHERE version = ?`)
          .get(file.version);
        if (existing) return false;
        const tx = sqlite.transaction(() => {
          sqlite.exec(file.sql);
          sqlite
            .prepare(`INSERT INTO _migrations (version, name) VALUES (?, ?)`)
            .run(file.version, file.name);
        });
        tx();
        return true;
      },
    });
    await runner.run();
  }
}

// ─────────────────────────────────────────────────────────────────
// Singleton + helpers — handlers call getStorage() instead of constructing.
// ─────────────────────────────────────────────────────────────────

let _storage: LocalAdapter | null = null;
let _initPromise: Promise<LocalAdapter> | null = null;

/** Initialize the storage adapter. Idempotent. */
export async function initStorage(opts?: LocalAdapterOptions): Promise<LocalAdapter> {
  if (_storage) return _storage;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const adapter = new LocalAdapter(opts);
    await adapter.init();
    _storage = adapter;
    return adapter;
  })().finally(() => {
    _initPromise = null;
  });

  return _initPromise;
}

/** Get the current storage adapter. Throws if not initialized. */
export function getStorage(): LocalAdapter {
  if (!_storage) {
    throw new Error('Storage not initialized — call initStorage() first.');
  }
  return _storage;
}

/** Tests-only: replace the active adapter. */
export function setStorage(adapter: LocalAdapter): void {
  _storage = adapter;
}

/** Tests-only: reset the singleton. */
export async function resetStorage(): Promise<void> {
  if (_storage) await _storage.shutdown();
  _storage = null;
  _initPromise = null;
}
