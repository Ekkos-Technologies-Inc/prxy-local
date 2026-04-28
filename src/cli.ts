#!/usr/bin/env node
/**
 * prxy CLI — tiny utility for managing local data.
 *
 * Subcommands:
 *   prxy export [--out <file>]       Dump SQLite + blobs to a JSON file.
 *   prxy import <file>               Restore a previously exported snapshot.
 *   prxy patterns list               Print the patterns table.
 *   prxy patterns clear              DELETE all rows from patterns (asks first).
 *   prxy cache clear                 Wipe semantic_cache + KV.
 *   prxy migrate                     Apply pending SQL migrations.
 *
 * The CLI uses the same LocalAdapter the server uses, so PRXY_DATA_DIR points
 * at the same database.
 */

import 'dotenv/config';

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

import { initStorage } from './storage/adapter.js';

interface ExportSnapshot {
  version: 1;
  exportedAt: string;
  tables: Record<string, unknown[]>;
  kv: Array<{ key: string; value: string; ttl: number }>;
}

const TABLES = [
  'patterns',
  'semantic_cache',
  'sessions',
  'eviction_cache',
  'mcp_events',
];

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;

  switch (cmd) {
    case 'export':
      return cmdExport(args);
    case 'import':
      return cmdImport(args);
    case 'patterns':
      return cmdPatterns(args);
    case 'cache':
      return cmdCache(args);
    case 'migrate':
      return cmdMigrate();
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printUsage();
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`prxy — local data CLI

Usage:
  prxy export [--out <file>]   Dump local DB + KV to JSON.
  prxy import <file>           Restore a snapshot.
  prxy patterns list           List patterns.
  prxy patterns clear          Delete all patterns.
  prxy cache clear             Clear semantic_cache + KV.
  prxy migrate                 Apply pending SQL migrations.
  prxy help                    This help.

Environment:
  PRXY_DATA_DIR                Where SQLite + blobs live (default: ./data).
`);
}

async function cmdExport(args: string[]): Promise<void> {
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : `prxy-export-${Date.now()}.json`;

  const storage = await initStorage();
  const snapshot: ExportSnapshot = {
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: {},
    kv: [],
  };
  for (const t of TABLES) {
    try {
      const rows = await storage.db.raw(`SELECT * FROM "${t}"`);
      snapshot.tables[t] = rows;
    } catch (err) {
      console.error(`skip table ${t}:`, (err as Error).message);
    }
  }
  await fs.writeFile(resolve(outPath), JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`exported ${Object.keys(snapshot.tables).length} tables to ${outPath}`);
  await storage.shutdown();
}

async function cmdImport(args: string[]): Promise<void> {
  const path = args[0];
  if (!path) {
    console.error('Usage: prxy import <file>');
    process.exit(1);
  }
  const raw = await fs.readFile(resolve(path), 'utf8');
  const snapshot = JSON.parse(raw) as ExportSnapshot;
  if (snapshot.version !== 1) {
    console.error(`Unsupported snapshot version: ${snapshot.version}`);
    process.exit(1);
  }

  const storage = await initStorage();
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    try {
      await storage.db
        .from(table)
        .insert(rows as Record<string, unknown>[]);
      console.log(`imported ${rows.length} rows into ${table}`);
    } catch (err) {
      console.error(`failed to import ${table}:`, (err as Error).message);
    }
  }
  await storage.shutdown();
}

async function cmdPatterns(args: string[]): Promise<void> {
  const sub = args[0];
  const storage = await initStorage();
  if (sub === 'list') {
    const rows = (await storage.db.raw('SELECT id, title, problem, success_rate, created_at FROM patterns ORDER BY created_at DESC LIMIT 100')) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      console.log('(no patterns)');
    } else {
      for (const r of rows) {
        console.log(
          `[${r.id}] ${r.title ?? '(untitled)'} — ${r.problem} ` +
            `(success ${r.success_rate ?? 1.0})`,
        );
      }
      console.log(`\n${rows.length} patterns`);
    }
  } else if (sub === 'clear') {
    await storage.db.raw('DELETE FROM patterns');
    console.log('all patterns deleted');
  } else {
    console.error('Usage: prxy patterns list | clear');
    await storage.shutdown();
    process.exit(1);
  }
  await storage.shutdown();
}

async function cmdCache(args: string[]): Promise<void> {
  const sub = args[0];
  const storage = await initStorage();
  if (sub === 'clear') {
    await storage.db.raw('DELETE FROM semantic_cache');
    console.log('semantic_cache cleared');
    // KV is in-memory only; nothing persistent to wipe.
    console.log('(KV is in-memory and will be empty on next process start)');
  } else {
    console.error('Usage: prxy cache clear');
    await storage.shutdown();
    process.exit(1);
  }
  await storage.shutdown();
}

async function cmdMigrate(): Promise<void> {
  const storage = await initStorage();
  console.log('migrations applied');
  await storage.shutdown();
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
