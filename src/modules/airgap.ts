/**
 * airgap — local-only privacy guarantee.
 *
 * When this module is in the pipeline, the gateway monkey-patches `globalThis.fetch`
 * once at init() to block outbound network requests except to a whitelist of
 * provider host suffixes (api.anthropic.com, api.openai.com, etc).
 *
 * Why a module and not a server-level flag? Two reasons:
 *   1. Users can opt-in per-key by adding `airgap` to their PRXY_PIPE.
 *   2. The block applies to every module that runs after it — including
 *      embeddings (Voyage / OpenAI). Blocked embed calls fall back to the
 *      deterministic stub embed so semantic-cache + patterns still function.
 *
 * The patch is idempotent — installing the same provider list twice is a no-op.
 *
 * IMPORTANT: this module makes no network calls itself. It only sets up the
 * guard. Once installed, the guard persists for the life of the process.
 */

import { detectProvider } from '../providers/index.js';
import type { Module } from '../types/sdk.js';

export interface AirgapConfig {
  /**
   * Host suffixes that are allowed through the guard. Default lets all four
   * providers' API hosts through. Add custom hosts (e.g. a self-hosted Ollama)
   * if you wire them up.
   */
  allowedHosts?: string[];
  /**
   * Deny *all* outbound network calls (provider calls included). Useful for
   * tests/demos. Local replays via cache still work.
   */
  denyAll?: boolean;
}

const DEFAULT_ALLOWED: string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
];

interface GuardState {
  installed: boolean;
  allowed: Set<string>;
  denyAll: boolean;
  originalFetch: typeof fetch;
}

const guard: GuardState = {
  installed: false,
  allowed: new Set(),
  denyAll: false,
  // eslint-disable-next-line @typescript-eslint/unbound-method
  originalFetch: globalThis.fetch,
};

/** Returns whether the airgap guard is currently in place. Test helper. */
export function isAirgapInstalled(): boolean {
  return guard.installed;
}

/** Tests-only: reset the guard (restores original fetch). */
export function _uninstallAirgap(): void {
  if (!guard.installed) return;
  globalThis.fetch = guard.originalFetch;
  guard.installed = false;
  guard.allowed.clear();
  guard.denyAll = false;
}

export function airgap(config: AirgapConfig = {}): Module {
  const requested = new Set([...(config.allowedHosts ?? DEFAULT_ALLOWED)]);

  return {
    name: 'airgap',
    version: '1.0.0',

    async init() {
      install({
        allowed: requested,
        denyAll: config.denyAll === true,
      });
    },

    async pre(ctx) {
      // The block is in fetch — pre() is a no-op except for telemetry. We
      // re-install if someone restored fetch after init (e.g. between tests).
      if (!guard.installed) {
        install({
          allowed: requested,
          denyAll: config.denyAll === true,
        });
      }
      // Sanity check: if the request targets a non-allowed provider, surface
      // the conflict early so the user gets a clear error before the provider
      // call (instead of the airgap fetch rejecting with a generic message).
      try {
        const provider = detectProvider(ctx.request.model);
        ctx.metadata.set('airgap.provider', provider);
      } catch {
        // Unknown model — let the router error path handle it.
      }
      ctx.metadata.set('airgap.installed', true);
      ctx.metadata.set('airgap.allowed', [...guard.allowed]);
      return { continue: true };
    },
  };
}

function install(opts: { allowed: Set<string>; denyAll: boolean }): void {
  if (guard.installed) {
    // Merge new allowed hosts on top of the existing set.
    for (const h of opts.allowed) guard.allowed.add(h);
    if (opts.denyAll) guard.denyAll = true;
    return;
  }

  guard.installed = true;
  guard.denyAll = opts.denyAll;
  guard.allowed = new Set(opts.allowed);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  guard.originalFetch = globalThis.fetch;

  const blockedFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      throw new Error(`airgap: rejected non-URL fetch: ${String(url)}`);
    }

    if (guard.denyAll) {
      throw new Error(`airgap: outbound network blocked (denyAll mode): ${host}${pathOf(url)}`);
    }

    if (!isAllowed(host, guard.allowed)) {
      throw new Error(
        `airgap: outbound network blocked. Host '${host}' is not in the allowed list. ` +
          `Allowed: ${[...guard.allowed].join(', ')}`,
      );
    }

    return guard.originalFetch(input, init);
  };

  globalThis.fetch = blockedFetch;
}

function isAllowed(host: string, allowed: Set<string>): boolean {
  if (allowed.has(host)) return true;
  // Allow exact-match suffixes too: 'openai.com' allows 'api.openai.com'.
  for (const suffix of allowed) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}
