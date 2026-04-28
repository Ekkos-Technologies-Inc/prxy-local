/**
 * prxy-local gateway entry point.
 *
 * Spins up the Express app, initializes the SQLite storage adapter, runs the
 * `init()` hook of every module in the active pipeline (so things like
 * `airgap` can install their global guards), then starts listening.
 */

import 'dotenv/config';

import { createApp } from './app.js';
import { logger } from './lib/logger.js';
import { loadPipeline } from './pipeline/loader.js';
import { initStorage } from './storage/adapter.js';
import type { ApiKeyInfo } from './types/canonical.js';

const PORT = Number(process.env.PORT) || 3099;
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  // Force LOCAL_MODE so any leftover module that consults it behaves the same
  // way it would in the cloud-stripped local edition.
  process.env.LOCAL_MODE = 'true';

  const storage = await initStorage();

  // Boot every module in the default pipeline so init() hooks run (e.g. airgap
  // installs its global fetch guard here, before any request is served).
  const bootstrapKey: ApiKeyInfo = {
    keyId: 'local',
    userId: 'local-user',
    tier: 'local',
    pipelineConfig: process.env.PRXY_PIPE,
    revoked: false,
  };
  const modules = await loadPipeline(bootstrapKey);
  for (const mod of modules) {
    if (!mod.init) continue;
    try {
      await mod.init(storage);
    } catch (err) {
      logger.warn({ err, module: mod.name }, `module ${mod.name} init() failed`);
    }
  }

  const app = createApp();

  const server = app.listen(PORT, HOST, () => {
    logger.info(
      {
        port: PORT,
        host: HOST,
        edition: 'local',
        dataDir: process.env.PRXY_DATA_DIR ?? './data',
        authMode: process.env.LOCAL_API_KEY ? 'bearer' : 'open',
        modules: modules.map((m) => m.name),
        providers: {
          anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
          openai: Boolean(process.env.OPENAI_API_KEY),
          google: Boolean(process.env.GOOGLE_API_KEY),
          groq: Boolean(process.env.GROQ_API_KEY),
        },
      },
      `prxy-local listening on http://${HOST}:${PORT}`,
    );
  });

  function shutdown(signal: string): void {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void storage.shutdown().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal: gateway failed to start');
  process.exit(1);
});
