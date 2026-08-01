import { describe, expect, it } from 'vitest';

import { describeError } from '../src/errors.js';

describe('describeError', () => {
  it('returns the message of a plain error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the error code when the message is empty', () => {
    const err = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(describeError(err)).toBe('ECONNREFUSED');
  });

  it('unwraps a dual-stack AggregateError into something actionable', () => {
    // What Node actually raises when both ::1 and 127.0.0.1 refuse.
    const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    });
    const aggregate = Object.assign(new AggregateError([inner], ''), {
      code: 'ECONNREFUSED',
    });

    expect(describeError(aggregate)).toBe('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:6379');
  });

  it('follows the cause chain', () => {
    const err = new Error('query failed', { cause: new Error('socket hang up') });
    expect(describeError(err)).toBe('query failed: socket hang up');
  });

  it('collapses newlines so a JSON log line stays one line', () => {
    expect(describeError(new Error('Failed query: select 1\nparams: '))).toBe(
      'Failed query: select 1 params:',
    );
  });

  it('does not repeat an identical message twice in the chain', () => {
    const err = new Error('same', { cause: new Error('same') });
    expect(describeError(err)).toBe('same');
  });

  it('terminates on a self-referential cause', () => {
    const err = new Error('loop');
    (err as { cause?: unknown }).cause = err;
    expect(describeError(err)).toBe('loop');
  });

  it('handles non-error throws', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError(undefined)).toBe('undefined');
  });
});
