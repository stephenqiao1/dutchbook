# A logical contradiction on Polymarket lasts fifteen seconds

I built a service that watches Polymarket for statements that cannot all be true
at once, and measures how long the contradiction survives.

The answer is **fifteen seconds**. That is the median across 2,248 closed
episodes: half of every logical inconsistency I detected was gone before I could
have finished reading about it.

That number is the whole result, and most of this post is about why you should
believe less of it than the first paragraph suggests.

*All figures from the run of 2026-08-02T02:33Z. The full generated report is in
[REPORT.md](REPORT.md); regenerate both with `pnpm report`.*

![How long a contradiction survives](charts/lifetime-distribution.png)

---

## What counts as a contradiction

Prediction markets price probabilities, and probabilities have to obey
arithmetic. Three constraints, all mechanically checkable:

- **Implication.** If A entails B, then P(A) ≤ P(B). "Bitcoin above $150k" entails
  "Bitcoin above $120k", so the first can never be priced higher than the second.
- **Complement.** P(A) + P(not A) = 1.
- **Partition.** If exactly one of a set must happen, the prices sum to 1.

None of this needs a view about the world. You do not have to know who will win
the French presidential election to know that the candidates' probabilities
cannot sum to 1.15.

I extracted 67,617 such relations across 264,128 markets — **85.4% of the active
catalog** appears in at least one of them — and then checked them, first against
cached midpoints and then, for anything that looked broken, against live order
books.

## The lifetime finding

Over four and a half hours of continuous checking, 2,308 violation episodes
opened. Of the 2,248 that closed:

| | All closed | Confirmed executable |
| --- | --- | --- |
| n | 2,248 | 88 |
| median | 15s | 16s |
| p95 | 5.5m | 3.4m |
| max | 3.6h | 22.1m |

Fifteen seconds is fast enough to be a statement about infrastructure rather than
about traders. Nobody reads a market page, notices that three probabilities sum
to 1.07, and places three orders in fifteen seconds. Whatever is closing these
gaps is either automated or is not "closing" them at all — they are the ordinary
jitter of quotes moving independently and crossing back over a threshold.

I cannot tell those two stories apart, and that matters more than it sounds.

## Why "larger violations close faster" turned out to be unanswerable

The obvious hypothesis: a bigger contradiction is worth more to correct, so it
should close faster. It is testable and I tested it.

![Does a bigger contradiction close faster?](charts/lifetime-by-magnitude.png)

Spearman rank correlation between peak magnitude and lifetime is **+0.157**
(n=2,248, p < 0.001) — positive, meaning larger contradictions persisted
*longer*. That is the opposite of the hypothesis.

The first thing to rule out was pooling. Partitions and implications have very
different magnitude scales by construction: summing eight prices drifts further
from its target than comparing two, so a pooled correlation could easily be
measuring the difference between constraint types and reporting it as a
relationship within them. It is not:

| Scope | n | Spearman rho | p |
| --- | --- | --- | --- |
| pooled | 2,248 | +0.157 | < 0.001 |
| `implies` | 1,068 | +0.100 | 0.001 |
| `partition` | 1,180 | +0.213 | < 0.001 |

Same sign inside each type. Not Simpson's paradox.

**And I still do not believe the result, because 90.3% of closed episodes lasted
120 seconds or less.** The confirmation loop runs on a 60-second schedule. An
episode seen once and gone by the next check is recorded at roughly one interval
whatever its true life. For nine out of ten episodes the number I am reporting is
the sampling rate, not the market.

You can see it in the bucket medians: 14s, 15s, 15s, 17s across four of the five
populated buckets. They are not similar because the underlying lifetimes are
similar. They are similar because they are all pinned to the same floor.

There is one more wrinkle that points the other way. The *smallest* violations —
one to two cents past the detection threshold — are the slowest to close, at a
median of three minutes against fifteen seconds for everything larger. My
suspicion, which this data cannot confirm: a violation barely past the epsilon is
never unambiguously wrong. It drifts across the threshold rather than being
traded away. If that is right, the positive correlation is a fact about my
detector and not about Polymarket.

**So: the hypothesis is not supported, and this window cannot settle it.** What
survives is the level rather than the slope. A median contradiction is gone in
fifteen seconds, and that holds across every magnitude bucket above two cents.
Whether a 40-cent gap closes faster than a 5-cent one is beyond the resolution of
a 60-second check. That both are gone inside a minute is not.

## 96% of violations are not opportunities

This is the part I would have got wrong if I had stopped at the arithmetic.

A gap on midpoints is not money. The midpoint is not a price you can trade at; it
ignores the spread and says nothing about whether there is size behind it. So
every screened violation goes through a second stage that fetches live order
books, constructs the actual correcting basket, walks it level by level, and
charges fees and slippage.

Of 2,308 episodes, **90 survived that — 3.9%.**

| Constraint type | Episodes | Apparent | Confirmed |
| --- | --- | --- | --- |
| `implies` | 1,094 | 1,004 | 90 |
| `partition` | 1,214 | 1,214 | **0** |

Not one partition violation was ever executable, and the reason is structural: a
partition's correcting basket needs a leg in *every* member market. An eight-way
partition needs eight simultaneous fills and pays the spread eight times. The
arithmetic almost never survives. Every executable violation I found was a
pairwise implication.

Reporting the other 2,218 is the point. A scanner that showed only the 90 would
imply the rest were opportunities it happened not to mention.

## The 90 confirmed violations are two bugs

Here is the part where the analysis earned its keep.

Median net edge on the confirmed violations is **30.66¢ per share**, maximum 59¢.
I wrote in the report that this was not credible — a risk-free thirty cents on a
dollar-denominated contract, sitting there for sixteen seconds, is not something
a venue with real participants leaves lying around — and listed the likeliest
causes. Then I checked, and the answer was the first one on the list.

**The 90 confirmed episodes are 2 distinct constraints**, each re-detected 45
times as it flickered across the threshold. That is the number that matters: not
90 opportunities, 2 relations. And both relations are wrong.

| Constraint | Source | Antecedent | Consequent |
| --- | --- | --- | --- |
| `implies:278129` | `temporal` | Will OpenAI **not** IPO by Dec 31, **2026**? | Will OpenAI **not** IPO by Dec 31, **2027**? |
| `implies:278422` | `temporal` | Alito retirement by **Dec 31**, 2026? | Alito retirement by **Sept 30**, 2026? |

The extractor's own stored rationale gives it away. For the first: *"occurring by
December 31 2026 entails occurring by December 31 2027"*. That is true for a
positive event and **backwards for a negated one**. "Has not IPO'd by 2027"
entails "had not IPO'd by 2026", not the reverse — if it hasn't happened by the
later date it certainly hadn't by the earlier one. The extractor matched on
nested deadlines and never read the "not".

The second does not even need the negation subtlety: *"occurring by December 31
2026 entails occurring by September 30 2026"* is wrong on its face. Occurring by
the later date cannot entail occurring by the earlier one.

So the honest executable-arbitrage count in this report is **zero**, and I would
say that even though the pipeline downstream of the graph did everything right:
it found the trades, priced them against real order-book depth, walked the levels,
charged fees and slippage, and cleared them. It cannot check the premise it was
handed. The premise was wrong.

This is the second time this exact class of bug has appeared here. The first was
the ladder extractor reading "hit 35%" as an upward threshold when Polymarket's
resolution criteria say *"resolve to Yes if the approval rating is equal to or
**below** the listed value"*. That one put an inverted edge on 888 markets and
produced a $435 "risk-free arbitrage" that was a guaranteed loss in one of three
states. Nothing upstream looked wrong. The trade construction was immaculate.

A reversed entailment is the worst failure mode this system has, precisely
because it does not fail. It produces a confident, well-formed, fully-priced
answer. The only defences are reading the resolution criteria and verifying a
trade by hand, and the only reason I caught these two is that the report made me
compute a denominator I had not looked at before.

## Methodology, specifically

**Extraction.** Four sources. `ladder` (65,249 edges) pairs markets in the same
event with parseable numeric thresholds, and refuses the pair outright when the
resolution criteria do not state the direction. `temporal` (2,238) pairs nested
deadlines on the same subject — and is, on the evidence above, the source that
now needs the same audit the ladder extractor already had. `neg-risk-event` (24,201 groups) takes Polymarket's
own exhaustive-event flag as a partition. `complement` (2) is explicit negation.

**LLM proposals.** A model proposed pairs the deterministic extractors missed;
225 were reviewed by hand, 223 accepted — a 99.1% acceptance rate that says more
about the filter than the model. Candidates had already survived an
embedding-similarity threshold and a transitive-closure anti-join, so the base
rate going in was nowhere near 50%. It is not the model's precision on arbitrary
pairs, and I would not quote it as such. 128 edges actually landed; an accepted
pair already implied by the deterministic graph is not inserted twice.

**Detection.** Stage 1 screens every constraint against midpoints from a live
CLOB WebSocket feed, event-driven rather than polled — a book update marks only
the constraints that market participates in, and they are re-evaluated 250ms
later. Median detection latency is 0.06s. Stage 2 fetches live books for the
survivors and prices the correcting basket at the profit-maximising size, not the
maximum executable size (which is break-even by definition — an error I shipped
and had to fix, because every "confirmed" trade was showing $0.00 profit).

**Fees.** Polymarket's taker fee is `size × rate × p × (1−p)`, with a rate
between 0.04 and 0.07 by category. No endpoint I read publishes which category a
market is in, so I apply the highest rate to everything. That under-confirms
rather than over-confirms — the confirmed set is a subset of the true one.

## What I did not measure

**Thirty days.** This is four hours. The analysis was designed for a month of
accumulation and ran against a single continuous session. Every distributional
finding — lifetime, net edge, the size relationship — has enough episodes behind
it to be worth reading. Every *rate* is unavailable, and so is anything that
needs the window to span a cycle.

**Day of week.** Two calendar days observed, so 163 of the 168 day-hour cells are
empty. The heatmap in the report shows this by being almost entirely blank, which
is the most useful thing it can do.

![When violations open](charts/violations-by-hour.png)

**Time of day.** Five of 24 hours observed. Within them the variation is
dominated by when my checker was running.

**Market age.** I report time-to-resolution instead. My ingest began partway
through the catalog's life, so `first_seen_at` records when *I* noticed a market,
not when Polymarket listed it. True listing age is not available from any
endpoint I read.

**Category, honestly.** There is no published category on any Polymarket endpoint
I use — Gamma's tags are free-form strings like `Fed`, `Economic Policy`,
`Jerome Powell`. So "politics / sports / crypto / economics" is a keyword
heuristic I wrote for this report and validated against nothing. **31.5% of markets
under constraint fall into `other`**, and every one of the 90 confirmed violations
is in that bucket — which is either interesting or is the classifier failing on
exactly the markets that matter. I cannot tell which. The per-category rates in
the report are indicative of nothing stronger than "markets whose text matches
these words".

**What the extraction misses.** Cross-event logic is almost entirely absent:
"X wins the primary" implies "X is the nominee" across two events, and I find
that only if the LLM proposer surfaced it. Conditional and compound structure —
"A given B", "at least two of" — has no representation in my constraint language
at all. So the 85.4% coverage figure is coverage *of markets*, not of logic. The
true incoherence of the catalog is understated by an amount I cannot bound.

**Censoring.** Open episodes are excluded from every lifetime statistic. That is
correct — an open episode has no lifetime — but the longest-lived contradictions
are exactly the ones most likely to still be open, so p95 and max are understated.

## What I would do next

Fix the `temporal` extractor: handle negation, and assert that the entailment
runs from the earlier deadline to the later one rather than trusting the pattern
that matched. Then re-extract and re-run this report, and see what is left of the
confirmed set. My guess is nothing, and that is a perfectly good result — "no
executable arbitrage survives fees on this venue" is a finding.

Then drop the confirmation interval below the point where 90% of the sample sits
on the floor. The lifetime question is not hard — it is just being asked through
a 60-second shutter.

---

*Code, schema and the generated report: this repository. `pnpm report` rebuilds
every figure and chart from the database.*
