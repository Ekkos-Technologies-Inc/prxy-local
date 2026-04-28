/**
 * Rate limiting — no-op in prxy-local.
 *
 * Local mode is single-user / single-machine; tier-based rate limits are a
 * cloud-only concern. This middleware is here so the pipeline shape matches
 * the cloud edition. If you want to add per-IP or global rate limits, drop in
 * a third-party middleware like `express-rate-limit` here.
 */

import type { NextFunction, Request, Response } from 'express';

export function rateLimitMiddleware(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next();
}
