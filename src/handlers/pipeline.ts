/**
 * GET /v1/pipeline — returns the active module pipeline for the calling key.
 *
 * Honours the same `x-prxy-pipe` override the request endpoints do so callers
 * can preview what a custom pipeline would look like.
 */

import type { Request, Response } from 'express';

import { GatewayError, sendError } from '../lib/errors.js';
import { loadPipeline } from '../pipeline/loader.js';

export async function pipelineHandler(req: Request, res: Response): Promise<void> {
  if (!req.apiKey) {
    return sendError(
      res,
      new GatewayError(401, 'authentication_error', 'Missing API key context'),
    );
  }
  const override = req.header('x-prxy-pipe') ?? undefined;
  try {
    const modules = await loadPipeline(req.apiKey, { override });
    res.json({
      configured: process.env.PRXY_PIPE
        ? process.env.PRXY_PIPE.split(',').map((m) => m.trim()).filter(Boolean)
        : [],
      active: modules.map((m) => ({ name: m.name, version: m.version })),
      override: override ?? null,
      note: 'Override per request via the x-prxy-pipe header.',
    });
  } catch (err) {
    sendError(res, err);
  }
}
