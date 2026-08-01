import { pino, type Logger, type LoggerOptions } from 'pino';

import { config } from './config.js';

const baseOptions: LoggerOptions = {
  level: config.LOG_LEVEL,
  base: { service: 'dutchbook', env: config.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Emit `"level":"info"` rather than pino's numeric default, so JSON logs are
  // readable without a decoder ring.
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.secret',
      '*.token',
      '*.apiKey',
    ],
    censor: '[redacted]',
  },
};

/**
 * The single logger for the process.
 *
 * Structured JSON everywhere except local development, which gets pino-pretty.
 * Nothing in `src/` should call `console.*` — use this, or `request.log` inside
 * a Fastify handler so lines carry the request id.
 */
export const logger: Logger = config.isDevelopment
  ? pino({
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
          singleLine: false,
        },
      },
    })
  : pino(baseOptions);

/** Child logger tagged with a subsystem name, e.g. `createLogger('jobs')`. */
export function createLogger(component: string): Logger {
  return logger.child({ component });
}
