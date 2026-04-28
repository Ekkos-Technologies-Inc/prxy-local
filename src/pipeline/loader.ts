/**
 * Pipeline loader.
 *
 * Resolution priority (highest first):
 *   1. Per-request `x-prxy-pipe` header (handled at handler level)
 *   2. Per-API-key DB config (`apiKey.pipelineConfig`)
 *   3. PRXY_PIPE env var
 *   4. YAML config file at PRXY_PIPE_FILE
 *   5. DEFAULT_PIPELINE constant
 *
 * Two pipeline string formats:
 *   - Comma-separated module names: `mcp-optimizer,semantic-cache,patterns`
 *   - YAML list (for parameterized config) — see parseYamlPipeline.
 */

import { promises as fs } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { logger } from '../lib/logger.js';
import { BUILTIN_MODULES, DEFAULT_PIPELINE } from '../modules/index.js';
import type { ApiKeyInfo } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface LoadOptions {
  /** Per-request override (from `x-prxy-pipe` header). */
  override?: string;
}

export async function loadPipeline(
  apiKey: ApiKeyInfo,
  opts: LoadOptions = {},
): Promise<Module[]> {
  const source = await pickPipelineSource(apiKey, opts);
  if (!source.value) return [];
  try {
    return parsePipeline(source.value);
  } catch (err) {
    logger.error(
      { err, source: source.from },
      'failed to parse pipeline; falling back to default',
    );
    return parsePipeline(DEFAULT_PIPELINE);
  }
}

interface PipelineSource {
  from: 'override' | 'apiKey' | 'env' | 'file' | 'default';
  value: string;
}

async function pickPipelineSource(
  apiKey: ApiKeyInfo,
  opts: LoadOptions,
): Promise<PipelineSource> {
  if (opts.override?.trim()) return { from: 'override', value: opts.override.trim() };
  if (apiKey.pipelineConfig?.trim()) {
    return { from: 'apiKey', value: apiKey.pipelineConfig.trim() };
  }
  if (process.env.PRXY_PIPE?.trim()) return { from: 'env', value: process.env.PRXY_PIPE.trim() };

  const file = process.env.PRXY_PIPE_FILE;
  if (file) {
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text.trim()) return { from: 'file', value: text.trim() };
    } catch (err) {
      logger.warn({ err, file }, 'PRXY_PIPE_FILE unreadable; falling back');
    }
  }

  return { from: 'default', value: DEFAULT_PIPELINE };
}

export function parsePipeline(source: string): Module[] {
  const trimmed = source.trim();
  if (!trimmed) return [];

  // YAML form starts with `-` (list) or contains `:` (mapping/parameterized form).
  if (trimmed.startsWith('-') || (trimmed.includes(':') && !isCommaList(trimmed))) {
    return parseYamlPipeline(trimmed);
  }

  return trimmed
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name) => instantiate(name));
}

function isCommaList(s: string): boolean {
  return s.split(',').every((tok) => /^[a-z0-9-]+$/i.test(tok.trim()));
}

interface YamlPipelineEntry {
  module?: string;
  name?: string;
  config?: Record<string, unknown>;
}

function parseYamlPipeline(text: string): Module[] {
  const parsed = parseYaml(text);
  if (!Array.isArray(parsed)) {
    throw new Error('YAML pipeline must be a list of module entries');
  }
  return parsed.map((entry) => {
    if (typeof entry === 'string') return instantiate(entry);
    if (entry && typeof entry === 'object') {
      const e = entry as YamlPipelineEntry;
      const name = e.module ?? e.name;
      if (!name) {
        throw new Error(
          `YAML pipeline entry missing 'module' or 'name': ${JSON.stringify(entry)}`,
        );
      }
      return instantiate(name, e.config);
    }
    throw new Error(`Invalid YAML pipeline entry: ${JSON.stringify(entry)}`);
  });
}

function instantiate(name: string, config?: Record<string, unknown>): Module {
  const factory = BUILTIN_MODULES[name];
  if (!factory) {
    throw new Error(
      `Unknown module: ${name}. Available: ${Object.keys(BUILTIN_MODULES).join(', ')}`,
    );
  }
  return factory(config);
}
