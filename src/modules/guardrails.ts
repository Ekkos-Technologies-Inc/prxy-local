/**
 * guardrails — content filtering at the gateway layer.
 *
 * v1 ships the regex backend. Pre-hook scans every text block in user messages
 * + the system prompt for matches against:
 *   - Built-in profanity list (small, English; opt-in via `profanity_block`)
 *   - PII patterns (email, US SSN, basic credit-card 16-digit) — when
 *     `pii_redact` is true the matched text is replaced with a placeholder.
 *   - User-supplied `custom_patterns` — regex strings, blocked on match.
 *
 * Behavior on violation:
 *   - PII: redact in-place (mutate the request), continue.
 *   - Profanity / custom blocks: short-circuit with a 400-shaped error response.
 *
 * v2: NIM / Anthropic Constitutional / OpenAI Moderation backends.
 */

import type { Module, RequestContext } from '../types/sdk.js';
import type { CanonicalMessage, ContentBlock } from '../types/canonical.js';

import { errorResponse } from '../lib/errors.js';

export type GuardrailBackend = 'regex' | 'callout';

export interface GuardrailsConfig {
  pii_redact?: boolean;
  profanity_block?: boolean;
  custom_patterns?: string[];
  backend?: GuardrailBackend;
  on_pii?: 'redact' | 'block' | 'log-only';
}

const PII_PATTERNS = {
  email: {
    re: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    placeholder: '[REDACTED_EMAIL]',
  },
  ssn: {
    re: /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/g,
    placeholder: '[REDACTED_SSN]',
  },
  credit_card: {
    re: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
    placeholder: '[REDACTED_CARD]',
  },
  phone: {
    re: /\b\+?1?[- (]?\d{3}[- )]?\s?\d{3}[- ]?\d{4}\b/g,
    placeholder: '[REDACTED_PHONE]',
  },
};

const PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'cunt'];

export function guardrails(config: GuardrailsConfig = {}): Module {
  const backend: GuardrailBackend = config.backend ?? 'regex';
  const piiRedact = config.pii_redact ?? false;
  const profanityBlock = config.profanity_block ?? false;
  const onPii = config.on_pii ?? 'redact';

  const customRegexes = (config.custom_patterns ?? [])
    .map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);

  const profanityRegex = profanityBlock
    ? new RegExp(`\\b(${PROFANITY.join('|')})\\b`, 'i')
    : null;

  if (backend !== 'regex') {
    // eslint-disable-next-line no-console
    console.warn(`guardrails backend '${backend}' is not implemented yet — falling back to regex.`);
  }

  return {
    name: 'guardrails',
    version: '1.0.0',

    async pre(ctx) {
      ctx.metadata.set('guardrails.backend', backend);
      const stats = { pii_redactions: 0, blocked_by: '' as string };

      if (piiRedact || onPii !== 'redact') {
        const piiHits = scanForPii(ctx);
        stats.pii_redactions = piiHits;

        if (piiHits > 0) {
          if (onPii === 'block') {
            return {
              continue: false,
              response: errorResponse(
                'guardrail_pii_block',
                'Request blocked: PII detected in input.',
                { pii_matches: piiHits, status: 400 },
              ),
            };
          }
          if (onPii === 'redact') {
            redactPii(ctx);
          }
        }
      }

      if (profanityRegex) {
        const offending = findInText(ctx, profanityRegex);
        if (offending) {
          stats.blocked_by = 'profanity';
          ctx.metadata.set('guardrails.stats', stats);
          return {
            continue: false,
            response: errorResponse(
              'guardrail_profanity_block',
              'Request blocked: profanity policy.',
              { match: offending.slice(0, 40), status: 400 },
            ),
          };
        }
      }

      for (const re of customRegexes) {
        const offending = findInText(ctx, re);
        if (offending) {
          stats.blocked_by = `custom:${re.source}`;
          ctx.metadata.set('guardrails.stats', stats);
          return {
            continue: false,
            response: errorResponse(
              'guardrail_custom_block',
              'Request blocked by custom guardrail policy.',
              { pattern: re.source, status: 400 },
            ),
          };
        }
      }

      ctx.metadata.set('guardrails.stats', stats);
      return { continue: true };
    },
  };
}

function scanForPii(ctx: RequestContext): number {
  let hits = 0;
  for (const text of iterTextChunks(ctx)) {
    for (const { re } of Object.values(PII_PATTERNS)) {
      re.lastIndex = 0;
      const matches = text.match(re);
      if (matches) hits += matches.length;
    }
  }
  return hits;
}

function redactPii(ctx: RequestContext): void {
  if (ctx.request.system) {
    if (typeof ctx.request.system === 'string') {
      ctx.request.system = redactString(ctx.request.system);
    } else {
      ctx.request.system = ctx.request.system.map((b) => ({
        ...b,
        text: redactString(b.text),
      }));
    }
  }
  for (const m of ctx.request.messages) {
    if (typeof m.content === 'string') {
      m.content = redactString(m.content);
    } else {
      m.content = m.content.map((b) => mapBlockText(b, redactString));
    }
  }
}

function redactString(s: string): string {
  let out = s;
  for (const { re, placeholder } of Object.values(PII_PATTERNS)) {
    re.lastIndex = 0;
    out = out.replace(re, placeholder);
  }
  return out;
}

function findInText(ctx: RequestContext, re: RegExp): string | null {
  for (const text of iterTextChunks(ctx)) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

function* iterTextChunks(ctx: RequestContext): IterableIterator<string> {
  if (ctx.request.system) {
    if (typeof ctx.request.system === 'string') {
      yield ctx.request.system;
    } else {
      for (const b of ctx.request.system) yield b.text;
    }
  }
  for (const m of ctx.request.messages) {
    yield* iterMessageText(m);
  }
}

function* iterMessageText(m: CanonicalMessage): IterableIterator<string> {
  if (typeof m.content === 'string') {
    yield m.content;
    return;
  }
  for (const b of m.content) {
    if (b.type === 'text') yield b.text;
    if (b.type === 'tool_result' && typeof b.content === 'string') yield b.content;
  }
}

function mapBlockText(block: ContentBlock, fn: (s: string) => string): ContentBlock {
  if (block.type === 'text') return { type: 'text', text: fn(block.text) };
  if (block.type === 'tool_result' && typeof block.content === 'string') {
    return { ...block, content: fn(block.content) };
  }
  return block;
}
