/**
 * GET /health — liveness + provider config view.
 */

import type { Request, Response } from 'express';

const startedAt = Date.now();

export function healthHandler(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    edition: 'local',
    version: process.env.GIT_SHA ?? 'dev',
    uptime: process.uptime(),
    startedAt,
    providers: {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
      google: Boolean(process.env.GOOGLE_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
    },
  });
}
