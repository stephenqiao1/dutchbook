# Contributing

## Getting set up

```bash
pnpm install
cp .env.example .env          # defaults match docker-compose.yml
docker compose up -d          # Postgres 16 + pgvector, Redis 7
pnpm db:migrate
pnpm dev
```

Before pushing:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

CI runs the same three. Tests that need a database use
[testcontainers](https://testcontainers.com/) and skip themselves with a printed
warning when Docker is unavailable, so a green run on a machine without Docker is
not the same as a green run with it — check the skip notices.

## The house style

The codebase is written for someone reading it in a year with no memory of why.
Practically:

**Comments explain why, never what.** `// increment the counter` is noise;
`// counted here rather than per route: url would be unbounded cardinality once
ids appear in paths` is the reason the code is shaped that way. If a decision
took thought, the thought belongs next to it.

**Record what you measured, with the number.** Several modules carry a block
listing vendor behaviours that were verified against the live service, with the
evidence — "applying both interpretations over 214 changes: absolute matched 6/8,
delta 0/8". These are the most valuable comments in the repo, because the next
person to touch that code will otherwise assume the obvious thing and be wrong in
a way nothing catches.

**Withdraw a claim in the same place you made it.** When measurement contradicts
a comment, correct the comment and say what the measurement was. `ws.ts` hazard 6
is an example: the original claim was wrong, and the current text says so and
gives the false-positive rate.

**Types are strict and stay strict.** `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM with `.js` extensions in
`.ts` imports. No `any` in `src/`. Prefer a conditional spread —
`...(x === undefined ? {} : { x })` — over widening an optional property.

**No `console.*` in `src/`.** Use `createLogger('component')`. Scripts and tests
may print.

**Never build markup from a string.** The dashboard client builds DOM nodes and
assigns `textContent`. Market questions are attacker-controlled — anyone can
create a market — and a test asserts the served client contains no `innerHTML`
assignment.

**Watch for backticks inside template literals.** The dashboard assets and several
`sql` templates are `String.raw` blocks; a backtick in a comment inside one
terminates the string. `tsc` catches it, but the error points somewhere
confusing. This has bitten three times.

## Testing

Tests describe behaviour, not implementation. A good name finishes the sentence
"it …": `it('never builds a book out of price changes alone')`.

Three things earn a test unconditionally:

1. **A hazard you discovered by measurement.** If the venue does something
   surprising, encode it, so a future refactor that assumes the obvious thing
   fails loudly.
2. **A bug you fixed.** Every incident in the README's "Things that broke"
   section has a test under it.
3. **Anything that could be silently wrong.** A corrupt chart, a mis-signed
   correlation, a duplicated alert. These do not throw; they publish.

[`test/catalog-ingest-is-idempotent.test.ts`](test/catalog-ingest-is-idempotent.test.ts)
is the load-bearing one. It asserts that running the same crawl twice changes
nothing, using two different clocks so the assertion is not vacuous. If you touch
the ingest path, that test is the definition of correct.

## Working with the vendor APIs

**Do not guess the protocol — measure it.** Every documented hazard in
`src/polymarket/` came from probing the live service and finding that the obvious
reading was wrong. Levels arrive worst-first. `price_change.size` is absolute, not
a delta. The initial WebSocket snapshot is not delivered at scale. A second
subscribe on an open socket is rejected. None of that is in the docs.

**Rate limiting is global.** Polymarket's budget is per-IP, shared across every
client in the process. New callers must go through the shared bucket in
`src/polymarket/http.ts`. Do not create a second one.

**Read-only.** There is no authentication, no wallet and no order placement
anywhere in this repo, deliberately. Keep it that way — the analysis is about
whether an opportunity exists, and that question is answerable without the
ability to act on it.

## Relations are the dangerous part

A wrong relation is the worst failure this system has, because it does not fail.
It produces a confident, well-formed, fully-priced trade that is a guaranteed
loss, and everything downstream looks correct. It has happened twice — see the
README.

So:

- **Refuse rather than guess.** Where the resolution criteria do not state a
  direction, emit no edge. A missing edge costs an opportunity; a reversed one
  costs whatever someone traded behind it.
- **Read the resolution criteria, not the question.** Polymarket uses both
  directions inside the same-looking family.
- **Watch for negation.** "Does *not* happen by X" inverts a deadline entailment.
- **LLM output is a proposal, never an edge.** Nothing enters `relations` without
  a recorded human verdict.

Adding an extractor means adding its inverse test: construct a pair where the
naive reading is backwards and assert the extractor refuses or gets it right.

## Changing the database

```bash
# edit src/db/schema.ts, then
pnpm db:generate               # writes drizzle/NNNN_*.sql
pnpm db:migrate
```

Migrations are checked in and applied by the release command on deploy; a failing
migration aborts the deploy and leaves the previous version serving. Never edit a
migration that has run anywhere.

## Regenerating the artefacts

```bash
pnpm report                    # docs/REPORT.md and docs/charts/*.png
pnpm load-test                 # docs/LOAD.md
```

Both are generated, and both say so at the top. Do not hand-edit them: every
number is computed at run time precisely so the document cannot drift from the
data. If a figure looks wrong, fix the query.

The report reads whatever `DATABASE_URL` points at, so which database produced a
given copy is a property of how it was run — the observation window at the top is
how you tell.

## Commits

Explain the decision, not the diff. `git log` should read as the reasoning behind
the codebase: what was tried, what the measurement said, what was rejected. If
you withdrew an earlier claim, say so and give the number that changed your mind.
