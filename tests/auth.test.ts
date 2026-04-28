/**
 * Auth middleware tests — local edition.
 */

import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authMiddleware } from '../src/middleware/auth.js';

function makeReq(headers: Record<string, string> = {}): Partial<Request> {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  };
}

function makeRes(): { res: Partial<Response>; status: () => number; body: () => unknown } {
  let statusCode = 200;
  let body: unknown = null;
  const res: Partial<Response> = {
    status(code: number) {
      statusCode = code;
      return this as unknown as Response;
    },
    json(payload: unknown) {
      body = payload;
      return this as unknown as Response;
    },
  };
  return { res, status: () => statusCode, body: () => body };
}

describe('authMiddleware (open mode — no LOCAL_API_KEY)', () => {
  beforeEach(() => {
    delete process.env.LOCAL_API_KEY;
  });

  it('lets requests through without auth header', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq() as Request;
    const { res } = makeRes();
    authMiddleware(req, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKey?.tier).toBe('local');
    expect(req.apiKey?.userId).toBe('local-user');
  });
});

describe('authMiddleware (Bearer mode — LOCAL_API_KEY set)', () => {
  const ORIG = process.env.LOCAL_API_KEY;
  beforeEach(() => {
    process.env.LOCAL_API_KEY = 'prxy_local_test_secret';
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.LOCAL_API_KEY;
    else process.env.LOCAL_API_KEY = ORIG;
  });

  it('rejects missing header', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq() as Request;
    const { res, status } = makeRes();
    authMiddleware(req, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it('rejects malformed header', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq({ authorization: 'Token abc' }) as Request;
    const { res, status } = makeRes();
    authMiddleware(req, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it('rejects wrong key', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq({ authorization: 'Bearer wrong' }) as Request;
    const { res, status } = makeRes();
    authMiddleware(req, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(401);
  });

  it('accepts the configured key', () => {
    const next = vi.fn() as unknown as NextFunction;
    const req = makeReq({ authorization: 'Bearer prxy_local_test_secret' }) as Request;
    const { res } = makeRes();
    authMiddleware(req, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKey?.tier).toBe('local');
  });
});
