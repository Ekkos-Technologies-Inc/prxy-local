/**
 * Migration runner — reads numbered .sql files from a directory, applies them
 * in order, tracks applied versions in a `_migrations` table.
 *
 * Each migration file is named `NNN_name.sql` where NNN is a zero-padded
 * version number. Versions must be unique. The runner reads the directory,
 * sorts by version, and skips any version already recorded as applied.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface MigrationFile {
  /** Numeric prefix, e.g. 1, 2. Used for ordering and dedup. */
  version: number;
  /** Filename minus extension, e.g. '001_patterns'. */
  name: string;
  /** Raw SQL contents. */
  sql: string;
}

export interface MigrationRunner {
  run(): Promise<MigrationResult>;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  total: number;
}

export interface MigrationRunnerOptions {
  dir: string;
  apply(file: MigrationFile): Promise<boolean>;
  bootstrap(): Promise<void>;
  log?: (msg: string) => void;
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const files: MigrationFile[] = [];
  for (const name of entries) {
    if (!name.endsWith('.sql')) continue;
    const match = /^(\d+)_(.+)\.sql$/.exec(name);
    if (!match) continue;
    const version = Number.parseInt(match[1], 10);
    if (!Number.isFinite(version)) continue;

    const sql = await fs.readFile(join(dir, name), 'utf8');
    files.push({
      version,
      name: name.replace(/\.sql$/, ''),
      sql,
    });
  }

  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i++) {
    if (files[i].version === files[i - 1].version) {
      throw new Error(
        `Duplicate migration version ${files[i].version}: ${files[i - 1].name} and ${files[i].name}`,
      );
    }
  }

  return files;
}

export function createMigrationRunner(opts: MigrationRunnerOptions): MigrationRunner {
  return {
    async run(): Promise<MigrationResult> {
      const files = await readMigrationFiles(opts.dir);
      if (files.length === 0) {
        return { applied: [], skipped: [], total: 0 };
      }

      await opts.bootstrap();

      const applied: string[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        const wasApplied = await opts.apply(file);
        if (wasApplied) {
          applied.push(file.name);
          opts.log?.(`migration applied: ${file.name}`);
        } else {
          skipped.push(file.name);
        }
      }

      return { applied, skipped, total: files.length };
    },
  };
}
