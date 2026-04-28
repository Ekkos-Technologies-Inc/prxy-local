/**
 * LocalBlob — filesystem BlobStore.
 *
 * Stores blobs under `<dataDir>/blobs/<key>`. Keys can include forward slashes
 * to organize blobs by prefix; we reject `..` to prevent path traversal.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BlobStore } from '../types/sdk.js';

export interface LocalBlobOptions {
  /** Root directory; blobs live under <root>/blobs/. */
  dataDir: string;
}

export class LocalBlob implements BlobStore {
  private root: string;

  constructor(opts: LocalBlobOptions) {
    this.root = join(opts.dataDir, 'blobs');
  }

  private safePath(key: string): string {
    if (key.includes('..')) throw new Error(`Invalid blob key: ${key}`);
    return join(this.root, key);
  }

  async put(key: string, content: Buffer | string): Promise<void> {
    const path = this.safePath(key);
    await fs.mkdir(dirname(path), { recursive: true });
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await fs.writeFile(path, buf);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.safePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.safePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    await walk(this.root, this.root, out);
    return out.filter((k) => k.startsWith(prefix));
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else {
      out.push(full.slice(root.length + 1).split('\\').join('/'));
    }
  }
}
