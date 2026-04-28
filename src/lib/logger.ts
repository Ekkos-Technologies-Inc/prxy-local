/**
 * Pino logger — JSON in production, pretty in dev.
 */

import { pino } from 'pino';

const env = process.env.NODE_ENV ?? 'development';
const isDev = env === 'development';
const isTest = env === 'test';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? 'silent' : isDev ? 'debug' : 'info'),
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    },
  }),
});

export type PinoLogger = typeof logger;
