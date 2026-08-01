import { describe, expect, it, vi } from 'vitest';

import {
  buildUserPrompt,
  extractJson,
  proposalResponseSchema,
  proposeRelations,
  type CandidatePair,
  type ProposalClient,
} from '../../src/relations/proposer.js';

/**
 * The proposer's contract is almost entirely about what it *refuses* to do.
 *
 * It classifies pairs, and when a response is not exactly what was asked for it
 * drops the pair rather than repairing it. These tests are mostly adversarial
 * for that reason: the interesting behaviour is the rejection, because a bug
 * there does not throw — it silently invents a constraint that a solver will
 * later treat as fact.
 */

const PAIR: CandidatePair = {
  aConditionId: '0xaaa',
  aQuestion: 'Will Bitcoin reach $100,000 by December 31?',
  aDescription: 'Resolves YES if the price of BTC trades at or above $100,000.',
  bConditionId: '0xbbb',
  bQuestion: 'Will Bitcoin reach $90,000 by December 31?',
  bDescription: 'Resolves YES if the price of BTC trades at or above $90,000.',
  similarity: 0.94,
};

/** A client that replays canned text, and records what it was asked. */
function stubClient(replies: readonly string[], model = 'test-model'): ProposalClient & {
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  let index = 0;
  return {
    model,
    calls,
    complete(system: string, user: string): Promise<string> {
      calls.push({ system, user });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply === undefined) throw new Error('stub exhausted');
      return Promise.resolve(reply);
    },
  };
}

describe('proposalResponseSchema', () => {
  it('accepts the documented shape', () => {
    const parsed = proposalResponseSchema.safeParse({
      relation: 'implies',
      rationale: 'A entails B.',
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['a relation outside the enum', { relation: 'causes', rationale: 'x', confidence: 0.5 }],
    ['a missing rationale', { relation: 'implies', confidence: 0.5 }],
    ['an empty rationale', { relation: 'implies', rationale: '   ', confidence: 0.5 }],
    ['confidence above 1', { relation: 'implies', rationale: 'x', confidence: 1.4 }],
    ['confidence as a string', { relation: 'implies', rationale: 'x', confidence: '0.9' }],
    // Strict, not stripped: a model that invents a field has departed from the
    // contract, and silently discarding the extra key would hide that.
    ['an extra key', { relation: 'implies', rationale: 'x', confidence: 0.5, certainty: 'high' }],
  ])('rejects %s', (_label, payload) => {
    expect(proposalResponseSchema.safeParse(payload).success).toBe(false);
  });
});

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"relation":"unrelated"}')).toEqual({ relation: 'unrelated' });
  });

  it('reads through a code fence', () => {
    expect(extractJson('```json\n{"relation":"implies"}\n```')).toEqual({ relation: 'implies' });
  });

  it('reads through preamble and trailing prose', () => {
    expect(extractJson('Here is my answer:\n{"relation":"complement"}\nHope that helps!')).toEqual({
      relation: 'complement',
    });
  });

  it('returns undefined for prose with no object', () => {
    expect(extractJson('These two markets are unrelated.')).toBeUndefined();
  });

  it('returns undefined for malformed JSON rather than guessing', () => {
    expect(extractJson('{"relation": "implies", ')).toBeUndefined();
  });
});

describe('buildUserPrompt', () => {
  it('carries both questions and both resolution criteria', () => {
    const prompt = buildUserPrompt(PAIR);
    expect(prompt).toContain(PAIR.aQuestion);
    expect(prompt).toContain(PAIR.bQuestion);
    expect(prompt).toContain('trades at or above $100,000');
    expect(prompt).toContain('trades at or above $90,000');
  });

  it('says so explicitly when criteria are absent', () => {
    const prompt = buildUserPrompt({ ...PAIR, aDescription: null, bDescription: '  ' });
    expect(prompt).toContain('(none given)');
  });

  it('never leaks a condition id into the prompt', () => {
    // Ids are opaque hashes. Including them would give the model a token to
    // pattern-match on that carries no information about the questions.
    const prompt = buildUserPrompt(PAIR);
    expect(prompt).not.toContain('0xaaa');
    expect(prompt).not.toContain('0xbbb');
  });
});

describe('proposeRelations', () => {
  it('returns a proposal for a well-formed answer, tagged with the model', async () => {
    const client = stubClient(
      ['{"relation":"implies","rationale":"$100k entails $90k.","confidence":0.97}'],
      'claude-opus-5',
    );
    const { proposals, stats } = await proposeRelations([PAIR], client);

    expect(stats).toMatchObject({ proposed: 1, parseFailures: 0, callFailures: 0 });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      aConditionId: '0xaaa',
      bConditionId: '0xbbb',
      relation: 'implies',
      confidence: 0.97,
      model: 'claude-opus-5',
      similarity: 0.94,
    });
  });

  it('drops a pair whose answer does not parse, and never invents one', async () => {
    const client = stubClient(['I think A probably implies B.']);
    const { proposals, stats } = await proposeRelations([PAIR], client);

    expect(proposals).toEqual([]);
    expect(stats.parseFailures).toBe(1);
    expect(stats.proposed).toBe(0);
  });

  it('drops a pair whose answer is valid JSON but an invalid relation', async () => {
    const client = stubClient(['{"relation":"correlated","rationale":"x","confidence":0.9}']);
    const { proposals, stats } = await proposeRelations([PAIR], client);

    expect(proposals).toEqual([]);
    expect(stats.parseFailures).toBe(1);
  });

  it('survives a call that throws and keeps going', async () => {
    let call = 0;
    const client: ProposalClient = {
      model: 'test-model',
      complete(): Promise<string> {
        call += 1;
        if (call === 1) return Promise.reject(new Error('anthropic 500: boom'));
        return Promise.resolve('{"relation":"unrelated","rationale":"different.","confidence":0.8}');
      },
    };

    const second: CandidatePair = { ...PAIR, aConditionId: '0xccc', bConditionId: '0xddd' };
    const { proposals, stats } = await proposeRelations([PAIR, second], client);

    // One dead call must not take the batch with it.
    expect(stats.callFailures).toBe(1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.aConditionId).toBe('0xccc');
  });

  it('counts `unrelated` separately — it is an answer, not a failure', async () => {
    const client = stubClient([
      '{"relation":"unrelated","rationale":"Different subjects.","confidence":0.9}',
    ]);
    const { proposals, stats } = await proposeRelations([PAIR], client);

    expect(stats.unrelated).toBe(1);
    // Still returned: the row is what makes the pair ineligible for re-proposal,
    // which is the whole idempotency guarantee.
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.relation).toBe('unrelated');
  });

  it('makes exactly one call per pair', async () => {
    const client = stubClient(['{"relation":"unrelated","rationale":"x","confidence":0.5}']);
    const pairs = [PAIR, { ...PAIR, aConditionId: '0x1' }, { ...PAIR, aConditionId: '0x2' }];
    await proposeRelations(pairs, client);
    expect(client.calls).toHaveLength(3);
  });

  it('does nothing at all for an empty batch', async () => {
    const complete = vi.fn();
    const { proposals, stats } = await proposeRelations([], { model: 'm', complete });
    expect(complete).not.toHaveBeenCalled();
    expect(proposals).toEqual([]);
    expect(stats.proposed).toBe(0);
  });
});
