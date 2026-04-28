/**
 * Auth middleware — local edition.
 *
 * Single-user, single-machine model: there is no DB of API keys, no signup
 * flow, no Argon2 verification. Two modes:
 *
 *   1. LOCAL_API_KEY env var IS set → require Bearer that exact value.
 *   2. LOCAL_API_KEY env var IS NOT set → accept all requests (open mode).
 *
 * In both modes we attach a synthetic ApiKeyInfo with tier='local' so the
 * pipeline + module code paths that key off `apiKey.tier` work unchanged.
 */

import type { NextFunction, Request, Response } from 'express';

import { GatewayError, sendError } from '../lib/errors.js';
import type { ApiKeyInfo } from '../types/canonical.js';

declare module 'express' {
  interface Request {
    apiKey?: ApiKeyInfo;
  }
}

const LOCAL_USER_ID = 'local-user';
const LOCAL_KEY_ID = 'local';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.LOCAL_API_KEY;
  const auth = req.header('authorization') ?? req.header('Authorization');

  if (expected) {
    if (!auth) {
      return sendError(
        res,
        new GatewayError(401, 'authentication_error', 'Missing Authorization header'),
      );
    }
    const match = /^Bearer\s+(\S+)$/.exec(auth.trim());
    if (!match) {
      return sendError(
        res,
        new GatewayError(
          401,
          'authentication_error',
          'Invalid Authorization header format. Expected "Bearer <key>"',
        ),
      );
    }
    if (match[1] !== expected) {
      return sendError(res, new GatewayError(401, 'authentication_error', 'Invalid API key'));
    }
  }

  req.apiKey = {
    keyId: LOCAL_KEY_ID,
    userId: LOCAL_USER_ID,
    tier: 'local',
    pipelineConfig: process.env.PRXY_PIPE,
    revoked: false,
  };
  next();
}
