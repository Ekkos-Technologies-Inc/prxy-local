/**
 * compaction-bridge — survive Claude Code's auto-compaction without state loss.
 *
 * Detects when an upstream client has just triggered its own context-compaction
 * (the request looks fresh but references prior work) and re-injects the most
 * relevant pieces of the most recent eviction archive into the system prompt.
 *
 * Hard rules:
 *   - If `ipc` isn't producing eviction archives, this is a no-op (never throws).
 *   - Metadata keys live under `compaction-bridge.*` so we don't collide with
 *     `patterns.*` or `rehydrator.*`.
 *   - Detection is conservative — false negatives are fine, false positives
 *     would inject stale state into a genuinely-new conversation.
 */

import { contentToText, injectIntoSystem } from '../lib/messages.js';
import type { CanonicalMessage } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface CompactionBridgeConfig {
  /** Last N turns from the archive to re-inject. Default 5. */
  preserveLastTurns?: number;
  /** Include file paths mentioned in the archive. Default true. */
  preserveActiveFiles?: boolean;
  /** Include user directives (`always`, `never`, `prefer`). Default true. */
  preserveDirectives?: boolean;
  /** Confidence (0-1) required before injecting. Default 0.6. */
  detectionThreshold?: number;
  /** Blob key prefix to scan. Default 'evictions'. */
  blobPrefix?: string;
}

const CONTINUATION_MARKERS = [
  'continuing from where we left off',
  'continuing where we left off',
  'continue from where',
  'based on what we did before',
  'based on what we discussed',
  'as i mentioned earlier',
  'picking up where',
  'where we left off',
  'as discussed',
  'continuing the previous',
];

const FILE_PATH_RE = /\b([\w./@-]+\/[\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs|cpp|c|h|hpp|swift|md|mdx|json|yaml|yml|toml|sh|sql))\b/gi;

const DECISION_PATTERNS: RegExp[] = [
  /the (?:fix|solution|answer) (?:is|was)\s+([^\n.]+[.\n])/i,
  /the (?:issue|problem|bug) (?:is|was)\s+([^\n.]+[.\n])/i,
  /we decided\s+([^\n.]+[.\n])/i,
  /next step(?:s)?:?\s+([^\n]+)/i,
  /to fix this,?\s+([^\n.]+[.\n])/i,
];

const DIRECTIVE_RE = /\b(?:always|never|prefer|avoid|must|should|do not|don't)\b[^.\n]{3,150}/gi;

interface EvictionArchive {
  messages: CanonicalMessage[];
  summary?: string;
  evictedAt?: number;
  userId?: string;
  sessionId?: string;
}

export function compactionBridge(config: CompactionBridgeConfig = {}): Module {
  const preserveLastTurns = config.preserveLastTurns ?? 5;
  const preserveActiveFiles = config.preserveActiveFiles ?? true;
  const preserveDirectives = config.preserveDirectives ?? true;
  const threshold = config.detectionThreshold ?? 0.6;
  const blobPrefix = config.blobPrefix ?? 'evictions';

  return {
    name: 'compaction-bridge',
    version: '1.0.0',

    async pre(ctx) {
      ctx.metadata.set('compaction-bridge.recovered', false);

      const confidence = scoreCompaction(ctx.request.messages, ctx.request.system);
      ctx.metadata.set('compaction-bridge.confidence', Number(confidence.toFixed(3)));

      if (confidence < threshold) return { continue: true };

      const userId = ctx.apiKey.userId;
      const prefix = `${blobPrefix}/${userId}/`;

      let keys: string[] = [];
      try {
        keys = await ctx.storage.blob.list(prefix);
      } catch (err) {
        ctx.logger.warn('compaction-bridge: blob.list failed', err);
        return { continue: true };
      }
      if (keys.length === 0) return { continue: true };

      keys.sort((a, b) => (a < b ? 1 : -1));
      const mostRecentKey = keys[0];

      let blob: Buffer | null = null;
      try {
        blob = await ctx.storage.blob.get(mostRecentKey);
      } catch (err) {
        ctx.logger.warn('compaction-bridge: blob.get failed', err);
        return { continue: true };
      }
      if (!blob) return { continue: true };

      let archive: EvictionArchive | null = null;
      try {
        archive = JSON.parse(blob.toString('utf8')) as EvictionArchive;
      } catch (err) {
        ctx.logger.warn('compaction-bridge: archive parse failed', err);
        return { continue: true };
      }
      if (!archive || !Array.isArray(archive.messages) || archive.messages.length === 0) {
        return { continue: true };
      }

      const lastTurns = archive.messages.slice(-preserveLastTurns);
      const archiveText = archive.messages
        .map((m) => contentToText(m.content))
        .join('\n');

      const activeFiles = preserveActiveFiles ? extractFiles(archiveText) : [];
      const decisions = extractDecisions(archive.messages);
      const directives = preserveDirectives ? extractDirectives(archiveText) : [];

      const block = formatRecoveryBlock({
        lastTurns,
        activeFiles,
        decisions,
        directives,
        archiveAt: archive.evictedAt,
      });

      ctx.request.system = injectIntoSystem(ctx.request.system, block);

      ctx.metadata.set('compaction-bridge.recovered', true);
      ctx.metadata.set('compaction-bridge.source_blob', mostRecentKey);
      ctx.metadata.set('compaction-bridge.turns_restored', lastTurns.length);
      ctx.metadata.set('compaction-bridge.files_restored', activeFiles.length);
      ctx.metadata.set('compaction-bridge.decisions_restored', decisions.length);
      ctx.metadata.set('compaction-bridge.directives_restored', directives.length);

      return { continue: true };
    },
  };
}

export function scoreCompaction(
  messages: CanonicalMessage[],
  system: string | Array<{ text: string }> | undefined,
): number {
  let score = 0;

  if (messages.length <= 2) score += 0.4;

  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => contentToText(m.content))
    .join('\n')
    .toLowerCase();

  if (CONTINUATION_MARKERS.some((p) => userText.includes(p))) {
    score += 0.5;
  }

  const systemText = systemToText(system);
  const referencesPriorWork =
    FILE_PATH_RE.test(userText) ||
    /\b(?:the fix|the issue|the bug|the previous|the earlier|the last)\b/i.test(userText);
  FILE_PATH_RE.lastIndex = 0;

  if (systemText.length < 200 && referencesPriorWork) {
    score += 0.3;
  }

  return Math.min(score, 1);
}

function systemToText(
  system: string | Array<{ text: string }> | undefined,
): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n');
}

function extractFiles(text: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  FILE_PATH_RE.lastIndex = 0;
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
    found.add(m[1]);
    if (found.size >= 25) break;
  }
  return Array.from(found);
}

function extractDecisions(messages: CanonicalMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const text = contentToText(m.content);
    for (const re of DECISION_PATTERNS) {
      const match = re.exec(text);
      if (match && match[1]) {
        const trimmed = match[1].trim();
        if (trimmed && !out.includes(trimmed)) out.push(trimmed);
        if (out.length >= 10) return out;
      }
    }
  }
  return out;
}

function extractDirectives(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  DIRECTIVE_RE.lastIndex = 0;
  while ((m = DIRECTIVE_RE.exec(text)) !== null) {
    const directive = m[0].trim();
    if (directive && !out.includes(directive)) out.push(directive);
    if (out.length >= 10) break;
  }
  return out;
}

interface RecoveryBlockArgs {
  lastTurns: CanonicalMessage[];
  activeFiles: string[];
  decisions: string[];
  directives: string[];
  archiveAt?: number;
}

function formatRecoveryBlock(args: RecoveryBlockArgs): string {
  const lines: string[] = [];
  lines.push('<compaction-bridge-recovery>');
  if (args.archiveAt) {
    lines.push(`Recovered from compaction (archived ${new Date(args.archiveAt).toISOString()}).`);
  } else {
    lines.push('Recovered from compaction.');
  }

  if (args.activeFiles.length > 0) {
    lines.push('');
    lines.push('Active files:');
    for (const f of args.activeFiles) lines.push(`  - ${f}`);
  }

  if (args.decisions.length > 0) {
    lines.push('');
    lines.push('Recent decisions:');
    for (const d of args.decisions) lines.push(`  - ${d}`);
  }

  if (args.directives.length > 0) {
    lines.push('');
    lines.push('User directives:');
    for (const d of args.directives) lines.push(`  - ${d}`);
  }

  if (args.lastTurns.length > 0) {
    lines.push('');
    lines.push(`Last ${args.lastTurns.length} turn(s):`);
    for (const turn of args.lastTurns) {
      const text = contentToText(turn.content).trim();
      if (!text) continue;
      lines.push('');
      lines.push(`  [${turn.role}]: ${truncate(text, 600)}`);
    }
  }

  lines.push('</compaction-bridge-recovery>');
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
