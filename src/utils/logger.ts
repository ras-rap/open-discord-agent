import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import pino, { type Logger } from 'pino';

import { IS_PRODUCTION, LOG_LEVEL } from './env.ts';

if (IS_PRODUCTION) mkdirSync(join(process.cwd(), 'logs'), { 'recursive': true });

const transport = IS_PRODUCTION
  ? pino.transport({
      'targets': [
        { 'target': 'pino/file', 'level': 'info', 'options': { 'destination': join(process.cwd(), 'logs/app.log') } },
        {
          'target': 'pino/file',
          'level': 'error',
          'options': { 'destination': join(process.cwd(), 'logs/error.log') },
        },
      ],
    })
  : pino.transport({
      'target': 'pino-pretty',
      'options': { 'colorize': true, 'translateTime': 'HH:MM:ss.l', 'ignore': 'pid,hostname,scope' },
    });

export const logger: Logger = pino(
  { 'level': LOG_LEVEL, 'base': {}, 'timestamp': pino.stdTimeFunctions.isoTime },
  transport,
);

export type ScopedLogger = {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
};

/**
 * Scoped child logger with the `(message, fields)` call shape the rest of the codebase uses, backed by pino
 * so console output in development and file output in production match the template.
 */
export const log = (scope: string): ScopedLogger => {
  const child = logger.child({ scope });
  return {
    'debug': (message, fields) => child.debug(fields ?? {}, message),
    'info': (message, fields) => child.info(fields ?? {}, message),
    'warn': (message, fields) => child.warn(fields ?? {}, message),
    'error': (message, fields) => child.error(fields ?? {}, message),
  };
};
