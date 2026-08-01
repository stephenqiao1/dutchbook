/**
 * Polymarket API clients.
 *
 * Every response crossing this boundary is validated with a Zod schema before
 * it reaches the rest of the app, so an upstream shape change surfaces here
 * rather than as `undefined` three layers down. Coercion is field-local: a
 * malformed field is nulled and logged, never allowed to fail a whole crawl.
 */

export {
  GammaClient,
  GammaError,
  GammaHttpError,
  GammaNetworkError,
  GammaSchemaError,
  RateLimitExceededError,
  GAMMA_BASE_URL,
  MAX_PAGE_LIMIT,
  gammaClient,
  iterateEvents,
  iterateMarkets,
  parseRetryAfter,
  type GammaClientOptions,
  type GammaLogger,
  type IterateOptions,
  type RawResponse,
  type RawResponseHook,
} from './gamma.js';

export {
  keysetPageSchema,
  parseEvent,
  parseMarket,
  type Event,
  type FieldIssue,
  type KeysetPage,
  type Market,
  type RecordParse,
  type Tag,
} from './schemas.js';
