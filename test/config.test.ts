import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '../src/config.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/dutchbook',
  REDIS_URL: 'redis://localhost:6379',
} satisfies NodeJS.ProcessEnv;

describe('parseConfig', () => {
  it('applies defaults for optional variables', () => {
    const config = parseConfig({ ...valid });

    expect(config.NODE_ENV).toBe('development');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.PORT).toBe(3000);
    expect(config.HEALTHCHECK_TIMEOUT_MS).toBe(2000);
    expect(config.isDevelopment).toBe(true);
    expect(config.isProduction).toBe(false);
  });

  it('coerces numeric variables from strings', () => {
    const config = parseConfig({ ...valid, PORT: '8080', DATABASE_POOL_MAX: '25' });

    expect(config.PORT).toBe(8080);
    expect(config.DATABASE_POOL_MAX).toBe(25);
  });

  it('reports every missing variable in a single error', () => {
    let error: unknown;
    try {
      parseConfig({});
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;

    // Both, not just the first one the schema happened to reach.
    expect(configError.missing).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'REDIS_URL']),
    );
    expect(configError.message).toContain('DATABASE_URL');
    expect(configError.message).toContain('REDIS_URL');
    expect(configError.message).toContain('Missing required variables (2)');
  });

  it('treats an empty string as missing, not invalid', () => {
    let error: unknown;
    try {
      parseConfig({ ...valid, DATABASE_URL: '' });
    } catch (err) {
      error = err;
    }

    const configError = error as ConfigError;
    expect(configError.missing).toContain('DATABASE_URL');
    expect(configError.invalid).toHaveLength(0);
  });

  it('separates invalid values from missing ones and reports both at once', () => {
    let error: unknown;
    try {
      parseConfig({ REDIS_URL: 'redis://localhost:6379', DATABASE_URL: 'mysql://nope' });
    } catch (err) {
      error = err;
    }

    const configError = error as ConfigError;
    expect(configError.invalid.join('\n')).toContain('DATABASE_URL');
    expect(configError.invalid.join('\n')).toContain('postgres://');
    expect(configError.missing).toHaveLength(0);
  });

  it('rejects an out-of-range port with a readable message', () => {
    expect(() => parseConfig({ ...valid, PORT: '99999' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...valid, PORT: 'not-a-number' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseConfig({ ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
