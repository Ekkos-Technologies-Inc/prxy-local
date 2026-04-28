/**
 * Structured gateway errors. Every error returned to the client follows the
 * `{ error: { type, message, code? } }` shape so SDKs can branch on it.
 */

import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

import type { CanonicalResponse } from '../types/canonical.js';

export type ErrorType =
  | 'invalid_request'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found'
  | 'rate_limit'
  | 'provider_error'
  | 'internal_error';

export class GatewayError extends Error {
  constructor(
    public status: number,
    public type: ErrorType,
    message: string,
    public code?: string,
    public providerStatus?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  override toString(): string {
    return `${this.name}(${this.status}, ${this.type}): ${this.message}`;
  }

  toJSON() {
    return {
      error: {
        type: this.type,
        message: this.message,
        ...(this.code && { code: this.code }),
      },
    };
  }
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof GatewayError) {
    res.status(err.status).json(err.toJSON());
    return;
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  res.status(500).json({
    error: { type: 'internal_error', message },
  });
}

/**
 * Build a CanonicalResponse representing a module-induced error (e.g. cost-guard
 * 429). Modules return these via { continue: false, response } to short-circuit
 * the pipeline without a provider call.
 */
export function errorResponse(
  type: string,
  message: string,
  details?: Record<string, unknown>,
): CanonicalResponse {
  const text = JSON.stringify({ error: { type, message, ...(details ?? {}) } });
  return {
    id: `err_${randomUUID().slice(0, 12)}`,
    model: 'prxy-error',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'error',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
