/**
 * Built-in modules shipped with prxy-local.
 *
 * Modules are exported two ways:
 *   - Named factory functions (preferred for direct imports + custom config)
 *   - As entries in `BUILTIN_MODULES`, keyed by canonical pipeline name (used
 *     by the loader to resolve `PRXY_PIPE` strings).
 */

import type { Module } from '../types/sdk.js';

import { airgap, type AirgapConfig } from './airgap.js';
import { costGuard, type CostGuardConfig } from './cost-guard.js';
import { exactCache, type ExactCacheConfig } from './exact-cache.js';
import { ipc, type IpcConfig } from './ipc.js';
import { mcpOptimizer, type McpOptimizerConfig } from './mcp-optimizer.js';
import { patterns, type PatternsConfig } from './patterns.js';
import { semanticCache, type SemanticCacheConfig } from './semantic-cache.js';

export { airgap, costGuard, exactCache, ipc, mcpOptimizer, patterns, semanticCache };

export type {
  AirgapConfig,
  CostGuardConfig,
  ExactCacheConfig,
  IpcConfig,
  McpOptimizerConfig,
  PatternsConfig,
  SemanticCacheConfig,
};

// Re-export helpers
export { compressMessages } from './ipc.js';
export { detectPatternFromConversation } from './patterns.js';
export { isAirgapInstalled, _uninstallAirgap } from './airgap.js';

export type ModuleFactory = (config?: Record<string, unknown>) => Module;

/**
 * Registry of canonical pipeline names -> factory.
 * Hyphenated names (`mcp-optimizer`) match the strings used in `PRXY_PIPE`.
 *
 * Note: `usage-tracker` is NOT included — that module is cloud-only (it reports
 * to the hosted billing engine). Local users get `cost-guard` instead, which
 * gives the same per-request/day/month caps without phoning home.
 */
export const BUILTIN_MODULES: Record<string, ModuleFactory> = {
  airgap: (cfg) => airgap(cfg as AirgapConfig | undefined),
  'cost-guard': (cfg) => costGuard(cfg as CostGuardConfig | undefined),
  'exact-cache': (cfg) => exactCache(cfg as ExactCacheConfig | undefined),
  ipc: (cfg) => ipc(cfg as IpcConfig | undefined),
  'mcp-optimizer': (cfg) => mcpOptimizer(cfg as McpOptimizerConfig | undefined),
  patterns: (cfg) => patterns(cfg as PatternsConfig | undefined),
  'semantic-cache': (cfg) => semanticCache(cfg as SemanticCacheConfig | undefined),
};

export const DEFAULT_PIPELINE = 'mcp-optimizer,semantic-cache,patterns';
