/**
 * LocalKv — in-memory KV with TTL cleanup timer.
 *
 * Map-based storage, expirations swept every `cleanupIntervalMs` (default 30s).
 * Lazy-purges on read too — a key past its expiry returns null immediately.
 *
 * shutdown() stops the timer so the process can exit.
 */

import type { KvStore } from '../types/sdk.js';

interface KvEntry {
  value: string;
  expiresAt: number | null;
}

export interface LocalKvOptions {
  cleanupIntervalMs?: number;
}

export class LocalKv implements KvStore {
  private map = new Map<string, KvEntry>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(opts: LocalKvOptions = {}) {
    const interval = opts.cleanupIntervalMs ?? 30_000;
    if (interval > 0) {
      this.cleanupTimer = setInterval(() => this.sweep(), interval);
      // Don't keep the process alive just for sweeps.
      this.cleanupTimer.unref?.();
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.map.set(key, { value, expiresAt });
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const existing = await this.get(key);
    if (existing !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async ttl(key: string): Promise<number> {
    const entry = this.map.get(key);
    if (!entry) return -2;
    if (entry.expiresAt == null) return -1;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Test helper. */
  size(): number {
    return this.map.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (entry.expiresAt != null && now > entry.expiresAt) {
        this.map.delete(key);
      }
    }
  }
}
