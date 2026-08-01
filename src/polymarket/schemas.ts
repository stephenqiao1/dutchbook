import { z } from 'zod';

/**
 * Zod schemas for the Polymarket Gamma API.
 *
 * Gamma's payloads are not self-consistent: the same logical field arrives as a
 * number on one market and a decimal string on the next, `outcomes` and
 * `outcomePrices` are JSON-encoded strings rather than arrays, optional fields
 * come and go between records, and dates appear as ISO-8601, bare `YYYY-MM-DD`,
 * Postgres-style offsets, and epoch numbers.
 *
 * Two rules follow from that:
 *
 * 1. Every field is coerced through a transform into a clean domain type, so
 *    the rest of the app never sees `"0.0035"` where it expects `0.0035`.
 * 2. Coercion failures are *field-local*. A record never fails as a whole
 *    because one field is junk — the field becomes `null`, the failure is
 *    reported as a {@link FieldIssue}, and the caller logs it and keeps going.
 *    Only a record with no usable `id` is unusable, because an unidentifiable
 *    record cannot be stored or even meaningfully complained about.
 */

/** Sentinel a `soft()` field yields in place of a value it could not coerce. */
class FieldFailure {
  constructor(
    readonly reason: string,
    readonly received: unknown,
  ) {}
}

/** One field that failed to coerce, for structured logging by the caller. */
export interface FieldIssue {
  /** Dotted path within the record, e.g. `outcomePrices` or `markets[2].endDate`. */
  readonly field: string;
  readonly reason: string;
  readonly received: unknown;
}

/** Outcome of parsing a single catalog record. */
export type RecordParse<T> =
  | { readonly ok: true; readonly value: T; readonly issues: readonly FieldIssue[] }
  | { readonly ok: false; readonly reason: string };

function describeIssues(error: z.ZodError<unknown>): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Gamma writes "unset" as an empty string across text, numeric, and date fields
 * alike (`"endDate": ""`, `"marketMakerAddress": ""`). That is absence, not
 * corruption, so it resolves to `null` without a warning.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Makes a field survivable: absent input becomes `null`, and a coercion failure
 * becomes a {@link FieldFailure} that `resolve()` converts to `null` plus a
 * reported issue — instead of aborting the surrounding object.
 */
function soft<S extends z.ZodType>(schema: S) {
  // `.optional()` on the input side is what makes the key genuinely optional:
  // Zod v4 otherwise reads a transform that cannot output `undefined` as a
  // required key, and every absent field would fail the whole record.
  return z.unknown().optional().transform((value): z.output<S> | null | FieldFailure => {
    if (isAbsent(value)) return null;
    const result = schema.safeParse(value);
    return result.success ? result.data : new FieldFailure(describeIssues(result.error), value);
  });
}

// ---------------------------------------------------------------------------
// Coercions
// ---------------------------------------------------------------------------

/** `12.5`, `"12.5"`, `" 12.5 "` — all become `12.5`. Rejects NaN and Infinity. */
export const numeric = z
  .union([z.number(), z.string()], { error: 'expected a number or numeric string' })
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : Number(value.trim());
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: 'custom', message: `expected a number, got ${JSON.stringify(value)}` });
      return z.NEVER;
    }
    return parsed;
  });

/** `true`, `"true"`, `"False"`, `1`, `0` — all become booleans. */
export const booleanish = z
  .union([z.boolean(), z.string(), z.number()], {
    error: 'expected a boolean, "true"/"false", or 0/1',
  })
  .transform((value, ctx) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (value === 0 || value === 1) return value === 1;
    } else {
      const text = value.trim().toLowerCase();
      if (text === 'true' || text === 'yes' || text === '1') return true;
      if (text === 'false' || text === 'no' || text === '0') return false;
    }
    ctx.addIssue({ code: 'custom', message: `expected a boolean, got ${JSON.stringify(value)}` });
    return z.NEVER;
  });

/** Ids arrive as `"253591"` on some endpoints and `253591` on others. */
export const identifier = z
  .union([z.string(), z.number()], { error: 'expected a string or numeric id' })
  .transform((value) => String(value).trim())
  .refine((value) => value.length > 0, 'expected a non-empty identifier');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_ONLY = /^\d+$/;
const CALENDAR_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
/** Below this, an epoch number is seconds rather than milliseconds (year ~5138). */
const EPOCH_SECONDS_CEILING = 1e11;

/**
 * `Date.parse` falls back to a lenient parser that rolls `2025-02-30` forward
 * to March 2 rather than failing. A silently shifted date is worse than a null
 * one, so the calendar day is checked before parsing.
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Accepts every date shape Gamma has been observed to emit: ISO-8601 with `Z`
 * or an offset, bare `YYYY-MM-DD` (read as UTC midnight), Postgres-style
 * `2024-01-01 20:24:52+00`, and epoch seconds or milliseconds as number or
 * string.
 */
export const timestamp = z
  .union([z.string(), z.number()], { error: 'expected a date string or epoch number' })
  .transform((value, ctx) => {
    const fromEpoch = (n: number): number => (n < EPOCH_SECONDS_CEILING ? n * 1_000 : n);

    let ms: number;
    if (typeof value === 'number') {
      ms = fromEpoch(value);
    } else {
      const text = value.trim();
      const calendar = CALENDAR_PREFIX.exec(text);
      if (
        calendar !== undefined &&
        calendar !== null &&
        !isRealCalendarDate(Number(calendar[1]), Number(calendar[2]), Number(calendar[3]))
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `not a real calendar date: ${JSON.stringify(value)}`,
        });
        return z.NEVER;
      }

      if (DATE_ONLY.test(text)) ms = Date.parse(`${text}T00:00:00Z`);
      else if (DIGITS_ONLY.test(text)) ms = fromEpoch(Number(text));
      // `2024-01-01 20:24:52+00` — a space separator and a two-digit offset are
      // both outside what `Date.parse` reliably handles.
      else ms = Date.parse(text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    }

    if (!Number.isFinite(ms)) {
      ctx.addIssue({ code: 'custom', message: `expected a date, got ${JSON.stringify(value)}` });
      return z.NEVER;
    }
    return new Date(ms);
  });

/**
 * A list that may arrive as a real array or as a JSON-encoded string —
 * `["Yes","No"]` and `"[\"Yes\",\"No\"]"` parse identically.
 *
 * One bad element fails the whole list, which is the right granularity: half an
 * `outcomePrices` array is more dangerous downstream than no array at all.
 */
function jsonList<S extends z.ZodType>(item: S) {
  return z
    .union([z.array(z.unknown()), z.string()], {
      error: 'expected an array or a JSON-encoded array string',
    })
    .transform((value, ctx) => {
      let elements: unknown[];

      if (typeof value === 'string') {
        let decoded: unknown;
        try {
          decoded = JSON.parse(value);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message: `expected a JSON-encoded array, got ${JSON.stringify(value)}`,
          });
          return z.NEVER;
        }
        if (!Array.isArray(decoded)) {
          ctx.addIssue({
            code: 'custom',
            message: `expected a JSON-encoded array, got ${JSON.stringify(value)}`,
          });
          return z.NEVER;
        }
        elements = decoded;
      } else {
        elements = value;
      }

      const parsed: z.output<S>[] = [];
      for (const [index, element] of elements.entries()) {
        const result = item.safeParse(element);
        if (!result.success) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: describeIssues(result.error),
          });
          return z.NEVER;
        }
        parsed.push(result.data);
      }
      return parsed;
    });
}

/** `outcomes`, `clobTokenIds` — string lists, usually JSON-encoded. */
export const stringList = jsonList(z.union([z.string(), z.number()]).transform(String));

/** `outcomePrices` — decimal strings inside a JSON-encoded array. */
export const numberList = jsonList(numeric);

export const httpUrl = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => /^https?:\/\//i.test(value), 'expected an http(s) URL');

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/**
 * The domain shape of an object whose fields went through `soft()`: every
 * salvageable field is nullable, every required one keeps its type.
 */
type Resolved<T> = {
  [K in keyof T]-?: FieldFailure extends T[K]
    ? Exclude<T[K], FieldFailure | undefined> | null
    : Exclude<T[K], undefined>;
};

/**
 * Splits a parsed object into a clean record plus the list of fields that had
 * to be nulled. Keys are read from the schema rather than from the parsed
 * object, because Zod omits keys the payload never supplied — and a missing
 * field should surface as `null`, not `undefined`.
 */
function resolve<T extends Record<string, unknown>>(
  keys: readonly string[],
  record: T,
): { value: Resolved<T>; issues: FieldIssue[] } {
  const value: Record<string, unknown> = {};
  const issues: FieldIssue[] = [];

  for (const key of keys) {
    const field = record[key];
    if (field instanceof FieldFailure) {
      issues.push({ field: key, reason: field.reason, received: field.received });
      value[key] = null;
    } else {
      value[key] = field === undefined ? null : field;
    }
  }

  return { value: value as Resolved<T>, issues };
}

/**
 * Copies `from` onto `to` when `to` is absent, before validation.
 *
 * Covers two things at once: keys that are not valid domain names (`questionID`,
 * `new`), and Gamma's parallel numeric fields (`volumeNum` alongside the string
 * `volume`), where either one may be the one that is present.
 */
function withAliases(aliases: Readonly<Record<string, string>>) {
  return (input: unknown): unknown => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;

    const record = { ...(input as Record<string, unknown>) };
    for (const [from, to] of Object.entries(aliases)) {
      if (isAbsent(record[to]) && !isAbsent(record[from])) record[to] = record[from];
    }
    return record;
  };
}

const ALIASES: Readonly<Record<string, string>> = {
  questionID: 'questionId',
  new: 'isNew',
  volumeNum: 'volume',
  liquidityNum: 'liquidity',
};

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

const marketObject = z.object({
  // The one hard requirement: a record we cannot identify cannot be ingested.
  id: identifier,

  questionId: soft(z.string()),
  conditionId: soft(z.string()),
  slug: soft(z.string()),
  question: soft(z.string()),
  description: soft(z.string()),
  groupItemTitle: soft(z.string()),
  resolutionSource: soft(z.string()),
  marketMakerAddress: soft(z.string()),

  outcomes: soft(stringList),
  outcomePrices: soft(numberList),
  clobTokenIds: soft(stringList),

  active: soft(booleanish),
  closed: soft(booleanish),
  archived: soft(booleanish),
  restricted: soft(booleanish),
  featured: soft(booleanish),
  isNew: soft(booleanish),
  acceptingOrders: soft(booleanish),
  enableOrderBook: soft(booleanish),
  negRisk: soft(booleanish),

  volume: soft(numeric),
  volume24hr: soft(numeric),
  liquidity: soft(numeric),
  openInterest: soft(numeric),
  spread: soft(numeric),
  bestBid: soft(numeric),
  bestAsk: soft(numeric),
  lastTradePrice: soft(numeric),
  oneDayPriceChange: soft(numeric),
  orderPriceMinTickSize: soft(numeric),
  orderMinSize: soft(numeric),
  umaBond: soft(numeric),
  umaReward: soft(numeric),

  startDate: soft(timestamp),
  endDate: soft(timestamp),
  closedTime: soft(timestamp),
  createdAt: soft(timestamp),
  updatedAt: soft(timestamp),

  image: soft(httpUrl),
  icon: soft(httpUrl),
});

const MARKET_KEYS = Object.keys(marketObject.shape);
const marketRecord = z.unknown().transform(withAliases(ALIASES)).pipe(marketObject);

/** A Gamma market, coerced. Every field but `id` may be `null`. */
export type Market = Resolved<z.output<typeof marketObject>>;

export function parseMarket(input: unknown): RecordParse<Market> {
  const result = marketRecord.safeParse(input);
  if (!result.success) return { ok: false, reason: describeIssues(result.error) };

  const { value, issues } = resolve(MARKET_KEYS, result.data);
  return { ok: true, value, issues };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const tagList = z
  .array(
    z.looseObject({
      id: identifier,
      label: z.string().optional(),
      slug: z.string().optional(),
    }),
  )
  .transform((tags) =>
    tags.map((tag) => ({ id: tag.id, label: tag.label ?? null, slug: tag.slug ?? null })),
  );

export type Tag = z.output<typeof tagList>[number];

const eventObject = z.object({
  id: identifier,

  ticker: soft(z.string()),
  slug: soft(z.string()),
  title: soft(z.string()),
  description: soft(z.string()),

  active: soft(booleanish),
  closed: soft(booleanish),
  archived: soft(booleanish),
  restricted: soft(booleanish),
  featured: soft(booleanish),
  isNew: soft(booleanish),
  negRisk: soft(booleanish),
  enableOrderBook: soft(booleanish),

  volume: soft(numeric),
  volume24hr: soft(numeric),
  liquidity: soft(numeric),
  openInterest: soft(numeric),
  competitive: soft(numeric),

  startDate: soft(timestamp),
  endDate: soft(timestamp),
  creationDate: soft(timestamp),
  createdAt: soft(timestamp),
  updatedAt: soft(timestamp),

  image: soft(httpUrl),
  icon: soft(httpUrl),

  tags: soft(tagList),
  // Validated per element by `parseMarket` below, so one bad nested market does
  // not null the entire `markets` array.
  markets: soft(z.array(z.unknown())),
});

const EVENT_KEYS = Object.keys(eventObject.shape);
const eventRecord = z.unknown().transform(withAliases(ALIASES)).pipe(eventObject);

/** A Gamma event, coerced, with its nested markets parsed the same way. */
export type Event = Omit<Resolved<z.output<typeof eventObject>>, 'markets'> & {
  markets: Market[];
};

export function parseEvent(input: unknown): RecordParse<Event> {
  const result = eventRecord.safeParse(input);
  if (!result.success) return { ok: false, reason: describeIssues(result.error) };

  const { value, issues } = resolve(EVENT_KEYS, result.data);

  const markets: Market[] = [];
  for (const [index, raw] of (value.markets ?? []).entries()) {
    const parsed = parseMarket(raw);
    if (!parsed.ok) {
      issues.push({ field: `markets[${index}]`, reason: parsed.reason, received: raw });
      continue;
    }
    for (const issue of parsed.issues) {
      issues.push({ ...issue, field: `markets[${index}].${issue.field}` });
    }
    markets.push(parsed.value);
  }

  return { ok: true, value: { ...value, markets }, issues };
}

// ---------------------------------------------------------------------------
// Keyset pagination envelope
// ---------------------------------------------------------------------------

/**
 * Cursors that mean "no further pages". Gamma omits `next_cursor` on the final
 * page, but the CLOB-derived encoders in the same family emit `"LTE="` —
 * base64 for `-1` — so both are treated as the end of the catalog.
 */
const END_CURSORS = new Set(['', 'LTE=']);

export interface KeysetPage {
  readonly records: readonly unknown[];
  readonly nextCursor: string | null;
}

/**
 * Keys the record array has been observed under, in preference order.
 *
 * Gamma names the array after the resource — `/events/keyset` answers with
 * `{ $schema, events, next_cursor }` and `/markets/keyset` with `markets`. The
 * generic `data` is accepted first because it is what the documented envelope
 * uses and what a proxy or a future version is most likely to normalise to.
 */
const RECORD_KEYS = ['data', 'events', 'markets', 'results'] as const;

/** Envelope keys that are never the record array. */
const ENVELOPE_KEYS = new Set(['$schema', 'next_cursor', 'nextCursor', 'limit', 'count', 'total']);

/**
 * The `{ <records>, next_cursor }` envelope. A bare array is accepted too, and
 * read as a single terminal page.
 *
 * Records stay `unknown` here on purpose: they are validated one at a time by
 * `parseMarket`/`parseEvent` so a single malformed record cannot fail the page.
 */
export const keysetPageSchema: z.ZodType<KeysetPage, unknown> = z
  .union([z.array(z.unknown()), z.looseObject({})])
  .transform((value, ctx): KeysetPage => {
    if (Array.isArray(value)) return { records: value, nextCursor: null };

    const envelope = value as Record<string, unknown>;

    let records: unknown[] | undefined;
    for (const key of RECORD_KEYS) {
      const candidate = envelope[key];
      if (Array.isArray(candidate)) {
        records = candidate;
        break;
      }
    }

    // Fall back to the sole array-valued key, so a resource name we have not
    // seen yet pages correctly instead of failing the whole crawl.
    if (records === undefined) {
      const arrays = Object.entries(envelope).filter(
        ([key, candidate]) => !ENVELOPE_KEYS.has(key) && Array.isArray(candidate),
      );
      if (arrays.length === 1) records = arrays[0]![1] as unknown[];
    }

    if (records === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `expected a record array under one of ${RECORD_KEYS.join(', ')}; got keys [${Object.keys(envelope).join(', ')}]`,
      });
      return z.NEVER;
    }

    const raw = envelope['next_cursor'] ?? envelope['nextCursor'];
    const cursor = typeof raw === 'string' ? raw.trim() : '';
    return { records, nextCursor: END_CURSORS.has(cursor) ? null : cursor };
  });
