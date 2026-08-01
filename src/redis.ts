import { Redis } from 'ioredis';

import { config } from './config.js';
import { describeError } from './errors.js';
import { createLogger } from './logger.js';

const log = createLogger('redis');

/**
 * Shared Redis connection, configured to BullMQ's requirements:
 * `maxRetriesPerRequest: null` is mandatory for BullMQ workers, which hold a
 * long-lived blocking read.
 *
 * `lazyConnect` keeps importing this module side-effect-free; the socket opens
 * on the first command.
 */
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
});

/** Last connection-level failure, used to explain an unhealthy probe. */
let lastError: Error | undefined;
/** Whether the current outage has already been logged at error level. */
let outageReported = false;

redis.on('error', (err: Error) => {
  lastError = err;

  // ioredis re-emits on every reconnect attempt. Report an outage once, then
  // drop to debug, so one dead Redis doesn't flood the log.
  if (outageReported) {
    log.debug({ err }, 'redis reconnect attempt failed');
    return;
  }
  outageReported = true;
  log.error({ err }, 'redis connection error');
});

redis.on('ready', () => {
  if (outageReported) log.info('redis connection restored');
  lastError = undefined;
  outageReported = false;
});

redis.on('end', () => {
  log.warn('redis connection closed');
});

/**
 * Round-trips a PING. Throws if Redis is unreachable.
 *
 * Because `maxRetriesPerRequest` is null, a command issued during an outage
 * queues instead of rejecting — so this first short-circuits on a connection
 * already known to be down rather than making the caller wait out its deadline.
 * Callers should still impose one; `GET /health` does, via `withTimeout`.
 */
export async function pingRedis(): Promise<void> {
  if (redis.status === 'reconnecting' || redis.status === 'close' || redis.status === 'end') {
    const detail = lastError ? `: ${describeError(lastError)}` : '';
    throw new Error(`redis connection is ${redis.status}${detail}`);
  }

  const reply = await redis.ping();
  if (reply !== 'PONG') {
    throw new Error(`unexpected PING reply: ${JSON.stringify(reply)}`);
  }
}

/** Closes the connection. Safe to call more than once, connected or not. */
export async function closeRedis(): Promise<void> {
  if (redis.status === 'end') return;

  // QUIT is a command, so it only completes on a live connection. While the
  // client is 'wait' (lazyConnect, never used), 'connecting' or 'reconnecting',
  // it queues forever and hangs shutdown — drop the socket instead.
  if (redis.status !== 'ready') {
    redis.disconnect();
    log.info({ status: redis.status }, 'redis disconnected without QUIT');
    return;
  }

  try {
    await redis.quit();
  } catch (err) {
    log.warn({ err }, 'redis QUIT failed, forcing disconnect');
    redis.disconnect();
  }
  log.info('redis connection closed');
}
