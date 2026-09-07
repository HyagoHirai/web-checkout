import { pino, destination, stdTimeFunctions, type Logger } from 'pino';

/**
 * NDJSON to stdout through a synchronous destination so `startup.failed` followed by
 * `process.exit(1)` cannot lose the line (research R13). pid/hostname are dropped: in Docker they
 * are `1` and a container hash. Numeric levels keep pino-pretty and any future transport working.
 */
export function createLogger(level: string = 'info'): Logger {
  return pino(
    {
      level,
      base: { service: 'checkout-api' },
      timestamp: stdTimeFunctions.isoTime,
    },
    destination({ fd: 1, sync: true }),
  );
}

export type { Logger };
