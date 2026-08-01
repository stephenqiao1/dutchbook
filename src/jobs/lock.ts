import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { describeError } from '../errors.js';
import { createLogger } from '../logger.js';

/**
 * A mutual-exclusion lock held in Redis, so it spans processes.
 *
 * BullMQ's `concurrency: 1` only bounds one worker. With several replicas
 * deployed, or a run that outlasts its own schedule, two ingests can otherwise
 * overlap — and two crawls writing the same markets would each see the other's
 * half-applied batches. This is what actually prevents that.
 *
 * The lock is renewed continuously while held, so its TTL bounds how long a
 * *crashed* holder blocks the next run rather than how long a run may take.
 */

const log = createLogger('lock');

/** Delete only if we still own it: never free a lock that has moved on. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Extend only if we still own it, for the same reason. */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

/** Raised on the lock's signal when the lock is lost while still held. */
export class LockLostError extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`lock ${key} lost while held: ${reason}`);
    this.name = 'LockLostError';
    this.key = key;
  }
}

export interface HeldLock {
  readonly key: string;
  /** Unique to this acquisition; what makes release and renewal safe. */
  readonly token: string;
  /**
   * Aborts if the lock is lost before `release()` — a long GC pause, a Redis
   * failover, an operator deleting the key. Work guarded by the lock must stop
   * when this fires, because another holder may already have started.
   */
  readonly signal: AbortSignal;
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  /** How long the key survives without renewal. */
  ttlMs: number;
  /** Renewal period. Defaults to a third of the TTL, so two may fail harmlessly. */
  renewEveryMs?: number;
}

/**
 * Takes the lock, or returns null if someone else holds it.
 *
 * Non-blocking on purpose: a scheduled job that finds the lock taken should
 * record that it skipped and let the next tick try, not queue up behind a run
 * that is already doing its work.
 */
export async function acquireLock(
  connection: Redis,
  key: string,
  options: AcquireLockOptions,
): Promise<HeldLock | null> {
  const { ttlMs } = options;
  const renewEveryMs = options.renewEveryMs ?? Math.max(1_000, Math.floor(ttlMs / 3));
  const token = randomUUID();

  const acquired = await connection.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') return null;

  const controller = new AbortController();
  let lastRenewedAt = Date.now();
  let released = false;

  const lose = (reason: string): void => {
    if (released || controller.signal.aborted) return;
    log.error({ key, reason }, 'distributed lock lost while held');
    controller.abort(new LockLostError(key, reason));
  };

  const renew = async (): Promise<void> => {
    if (released) return;
    try {
      const extended = await connection.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
      if (extended === 1) {
        lastRenewedAt = Date.now();
        return;
      }
      // The key is gone or belongs to someone else. Either way it is not ours.
      lose('another holder owns the key');
    } catch (error) {
      const staleMs = Date.now() - lastRenewedAt;
      // A blip is survivable; being unable to renew for a whole TTL is not,
      // because by then the key has expired and anyone may have taken it.
      if (staleMs >= ttlMs) {
        lose(`renewal failing for ${staleMs}ms: ${describeError(error)}`);
      } else {
        log.warn({ key, error: describeError(error) }, 'lock renewal failed, will retry');
      }
    }
  };

  const timer = setInterval(() => void renew(), renewEveryMs);
  // Must not hold the process open: the lock outlives nothing.
  timer.unref();

  return {
    key,
    token,
    signal: controller.signal,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        await connection.eval(RELEASE_SCRIPT, 1, key, token);
      } catch (error) {
        // The TTL is the backstop; a failed release costs at most one skipped
        // run, so it must not fail the work that just succeeded.
        log.warn({ key, error: describeError(error) }, 'lock release failed, relying on its TTL');
      }
    },
  };
}

/**
 * Runs `work` under the lock, or returns `{ ran: false }` if it is already held.
 *
 * The lock's signal is handed to `work` so it can stop early if the lock is
 * lost mid-run.
 */
export async function withLock<T>(
  connection: Redis,
  key: string,
  options: AcquireLockOptions,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; result?: undefined }> {
  const lock = await acquireLock(connection, key, options);
  if (lock === null) return { ran: false };

  try {
    const result = await work(lock.signal);
    return { ran: true, result };
  } finally {
    await lock.release();
  }
}
