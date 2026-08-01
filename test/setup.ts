/**
 * `src/config.ts` parses the environment eagerly on import, so tests need a
 * valid one before any module under test loads. These point at nothing real —
 * the suite injects fake health probes and never opens a connection.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??= 'postgresql://dutchbook:dutchbook@127.0.0.1:5432/dutchbook_test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/1';
