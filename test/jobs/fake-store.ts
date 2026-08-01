import type {
  EventRow,
  MarketRevisionRow,
  MarketRow,
  NewEventRow,
  NewMarketRow,
  NewRawPayloadRow,
  RawPayloadRow,
} from '../../src/db/schema.js';
import type { CatalogStore, CatalogTx } from '../../src/jobs/ingest-catalog.js';

/**
 * An in-memory `CatalogStore`, so the reconciliation logic can be tested
 * without Postgres.
 *
 * The parts that matter are modelled rather than stubbed:
 *
 * - `transaction` snapshots state and restores it if the callback throws, so a
 *   failed batch really does leave nothing behind.
 * - the upsert preserves `first_seen_at` and clears `missing_since`, matching
 *   `marketUpdateSet()` in the real store — if that SQL and this diverge, the
 *   tests are lying.
 * - `archiveRawPayload` enforces the unique constraint on `response_hash`.
 */
export interface FakeStore extends CatalogStore {
  readonly events: Map<string, EventRow>;
  readonly markets: Map<string, MarketRow>;
  readonly revisions: MarketRevisionRow[];
  readonly rawPayloads: RawPayloadRow[];
  /** Rows passed to each call, so "wrote nothing" is assertable. */
  readonly calls: {
    upsertMarkets: number[];
    touchMarkets: number[];
    insertRevisions: number[];
    transactions: number;
  };
  /** Makes the nth transaction (1-based) throw, to simulate a crash mid-crawl. */
  failOnTransaction?: number;
}

interface State {
  events: Map<string, EventRow>;
  markets: Map<string, MarketRow>;
  revisions: MarketRevisionRow[];
  rawPayloads: RawPayloadRow[];
}

function materializeEvent(row: NewEventRow, existing: EventRow | undefined, at: Date): EventRow {
  return {
    id: row.id,
    slug: row.slug ?? null,
    title: row.title ?? null,
    negRisk: row.negRisk ?? null,
    firstSeenAt: existing?.firstSeenAt ?? row.firstSeenAt ?? at,
    lastSeenAt: row.lastSeenAt ?? at,
    // `coalesce(events.closed_at, excluded.closed_at)` — write-once.
    closedAt: existing?.closedAt ?? row.closedAt ?? null,
  };
}

function materializeMarket(row: NewMarketRow, existing: MarketRow | undefined, at: Date): MarketRow {
  return {
    conditionId: row.conditionId,
    eventId: row.eventId ?? null,
    question: row.question ?? null,
    slug: row.slug ?? null,
    description: row.description ?? null,
    resolutionSource: row.resolutionSource ?? null,
    outcomes: row.outcomes ?? null,
    endDate: row.endDate ?? null,
    active: row.active ?? null,
    closed: row.closed ?? null,
    archived: row.archived ?? null,
    clobTokenIds: row.clobTokenIds ?? null,
    contentHash: row.contentHash,
    // Not in the update set: the first sighting never moves.
    firstSeenAt: existing?.firstSeenAt ?? row.firstSeenAt ?? at,
    lastSeenAt: row.lastSeenAt ?? at,
    missingSince: null,
  };
}

export function createFakeStore(): FakeStore {
  const state: State = {
    events: new Map(),
    markets: new Map(),
    revisions: [],
    rawPayloads: [],
  };

  const calls: FakeStore['calls'] = {
    upsertMarkets: [],
    touchMarkets: [],
    insertRevisions: [],
    transactions: 0,
  };

  let nextRevisionId = 1;
  let nextPayloadId = 1;

  const tx: CatalogTx = {
    async loadMarkets(conditionIds) {
      return conditionIds
        .map((id) => state.markets.get(id))
        .filter((row): row is MarketRow => row !== undefined)
        .map((row) => structuredClone(row));
    },

    async upsertEvents(rows) {
      const at = new Date();
      for (const row of rows) {
        state.events.set(row.id, materializeEvent(row, state.events.get(row.id), at));
      }
    },

    async upsertMarkets(rows) {
      calls.upsertMarkets.push(rows.length);
      const at = new Date();
      for (const row of rows) {
        state.markets.set(
          row.conditionId,
          materializeMarket(row, state.markets.get(row.conditionId), at),
        );
      }
    },

    async touchMarkets(conditionIds, seenAt) {
      calls.touchMarkets.push(conditionIds.length);
      for (const id of conditionIds) {
        const row = state.markets.get(id);
        if (row === undefined) throw new Error(`touch of unknown market ${id}`);
        state.markets.set(id, { ...row, lastSeenAt: seenAt, missingSince: null });
      }
    },

    async insertRevisions(rows) {
      calls.insertRevisions.push(rows.length);
      for (const row of rows) {
        if (!state.markets.has(row.conditionId)) {
          // The real table has an FK; a revision must never precede its market.
          throw new Error(`revision for unknown market ${row.conditionId}`);
        }
        state.revisions.push({
          id: nextRevisionId++,
          conditionId: row.conditionId,
          changedAt: row.changedAt ?? new Date(),
          field: row.field,
          oldValue: row.oldValue ?? null,
          newValue: row.newValue ?? null,
          contentHashBefore: row.contentHashBefore,
          contentHashAfter: row.contentHashAfter,
        });
      }
    },
  };

  const store: FakeStore = {
    events: state.events,
    markets: state.markets,
    revisions: state.revisions,
    rawPayloads: state.rawPayloads,
    calls,

    async transaction(work) {
      calls.transactions += 1;

      const snapshot = {
        events: structuredClone(state.events),
        markets: structuredClone(state.markets),
        revisions: structuredClone(state.revisions),
      };

      try {
        const result = await work(tx);
        if (store.failOnTransaction === calls.transactions) {
          throw new Error(`simulated crash committing transaction ${calls.transactions}`);
        }
        return result;
      } catch (error) {
        // Roll back: restore in place, since callers hold these references.
        state.events.clear();
        for (const [key, value] of snapshot.events) state.events.set(key, value);
        state.markets.clear();
        for (const [key, value] of snapshot.markets) state.markets.set(key, value);
        state.revisions.length = 0;
        state.revisions.push(...snapshot.revisions);
        throw error;
      }
    },

    async archiveRawPayload(row: NewRawPayloadRow) {
      if (state.rawPayloads.some((existing) => existing.responseHash === row.responseHash)) {
        return false;
      }
      state.rawPayloads.push({
        id: nextPayloadId++,
        endpoint: row.endpoint,
        fetchedAt: row.fetchedAt ?? new Date(),
        body: row.body,
        responseHash: row.responseHash,
      });
      return true;
    },

    async reconcileMissing(runStartedAt: Date) {
      for (const [id, row] of state.markets) {
        if (row.lastSeenAt < runStartedAt && row.missingSince === null) {
          state.markets.set(id, { ...row, missingSince: row.lastSeenAt });
        }
      }
      return [...state.markets.values()].filter((row) => row.missingSince !== null).length;
    },
  };

  return store;
}
