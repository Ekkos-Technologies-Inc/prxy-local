/**
 * Per-million-token pricing snapshot. USD. Approximations — modules use these
 * for budget-guard math, not invoicing. Update periodically.
 */

import type { CanonicalRequest, CanonicalResponse } from '../types/canonical.js';

import { estimateRequestTokens } from './tokens.js';

export interface ModelPricing {
  input: number;
  output: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4': { input: 0.8, output: 4 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  o1: { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  o3: { input: 10, output: 40 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // Google
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  // Groq
  'llama-3.3-70b': { input: 0.59, output: 0.79 },
  'llama-3.1-8b': { input: 0.05, output: 0.08 },
};

const DEFAULT_PRICING: ModelPricing = { input: 1, output: 3 };

export function getPricing(model: string): ModelPricing {
  // Exact match first
  if (PRICING[model]) return PRICING[model];
  // Prefix match — handles versioned names like `claude-sonnet-4-20250514`
  for (const [prefix, price] of Object.entries(PRICING)) {
    if (model.startsWith(prefix)) return price;
  }
  return DEFAULT_PRICING;
}

/**
 * Estimate request cost in USD using input-token estimation + an assumed
 * output budget. Conservative: assumes the model will use 50% of maxTokens.
 */
export function estimateRequestCost(req: CanonicalRequest): number {
  const pricing = getPricing(req.model);
  const inputTokens = estimateRequestTokens(req);
  const outputTokens = Math.ceil((req.maxTokens ?? 1024) * 0.5);
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/**
 * Calculate the actual cost from a finished response.
 */
export function calculateActualCost(req: CanonicalRequest, response: CanonicalResponse): number {
  const pricing = getPricing(response.model || req.model);
  const inputTokens = response.usage.inputTokens;
  const outputTokens = response.usage.outputTokens;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}
