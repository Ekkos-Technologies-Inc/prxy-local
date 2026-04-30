/**
 * Storage parity test — exercises the LocalAdapter's KV, DB, and blob surfaces
 * end to end against a real SQLite database in a tmp dir.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalAdapter } from '../../src/storage/adapter.js';

let adapter: LocalAdapter;
let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'prxy-monster-local-parity-'));
  adapter = new LocalAdapter({
    dataDir,
    migrationsDir: join(process.cwd(), 'src', 'storage', 'migrations'),
    kvCleanupIntervalMs: 0,
  });
  await adapter.init();
});

afterEach(async () => {
  await adapter.shutdown();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

describe('LocalAdapter — kv', () => {
  it('round-trips set/get/del', async () => {
    await adapter.kv.set('a', 'one');
    expect(await adapter.kv.get('a')).toBe('one');
    await adapter.kv.del('a');
    expect(await adapter.kv.get('a')).toBeNull();
  });

  it('honors TTL', async () => {
    await adapter.kv.set('b', 'v', 1);
    expect(await adapter.kv.ttl('b')).toBeGreaterThan(0);
    expect(await adapter.kv.ttl('missing')).toBe(-2);
  });

  it('setNx is atomic-ish (single process)', async () => {
    expect(await adapter.kv.setNx('lock', 'me', 60)).toBe(true);
    expect(await adapter.kv.setNx('lock', 'you', 60)).toBe(false);
  });
});

describe('LocalAdapter — db (patterns table)', () => {
  it('insert + select round-trip with JSON columns auto-encoded', async () => {
    const r = await adapter.db.from('patterns').insert({
      title: 'test',
      problem: 'x failed',
      solution: 'restart x',
      tags: ['kubernetes', 'crash'],
      embedding: [0.1, 0.2, 0.3],
    });
    expect(r.error).toBeNull();

    const out = await adapter.db.from('patterns').select().eq('title', 'test');
    expect(out.error).toBeNull();
    const rows = out.data as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].tags).toEqual(['kubernetes', 'crash']);
    expect(rows[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('vectorSearch ranks by cosine similarity', async () => {
    await adapter.db.from('patterns').insert({
      title: 'A',
      problem: 'thing A',
      solution: 'fix A',
      embedding: [1, 0, 0],
    });
    await adapter.db.from('patterns').insert({
      title: 'B',
      problem: 'thing B',
      solution: 'fix B',
      embedding: [0, 1, 0],
    });
    const matches = await adapter.db
      .from('patterns')
      .vectorSearch('embedding', [1, 0, 0], { limit: 2, minScore: 0 });
    expect(matches.length).toBeGreaterThan(0);
    expect((matches[0].data as Record<string, unknown>).title).toBe('A');
  });
});

describe('LocalAdapter — blob', () => {
  it('round-trips put/get/list/delete', async () => {
    await adapter.blob.put('a/b/c.txt', 'hello');
    const got = await adapter.blob.get('a/b/c.txt');
    expect(got?.toString('utf8')).toBe('hello');

    const list = await adapter.blob.list('a/');
    expect(list.some((k) => k.endsWith('c.txt'))).toBe(true);

    await adapter.blob.delete('a/b/c.txt');
    expect(await adapter.blob.get('a/b/c.txt')).toBeNull();
  });

  it('rejects path-traversal keys', async () => {
    await expect(adapter.blob.put('../etc/passwd', 'x')).rejects.toThrow();
  });
});

describe('LocalAdapter — health', () => {
  it('reports vectorBackend in details', async () => {
    const h = await adapter.health();
    expect(h.ok).toBe(true);
    expect(['sqlite-vec', 'js-cosine']).toContain(h.details?.vectorBackend);
  });
});
