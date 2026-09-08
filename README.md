# Conduct Risk Radar

A conduct-risk detection and triage system built on the **CFPB Consumer Complaint Database**: real, public complaint data filed against financial institutions. Statistics find the anomaly; a model only explains one that already exists, from a bounded evidence packet; an analyst dispositions it; those dispositions become the labelled set that variants are evaluated against.

**Live:** https://conduct-risk-radar.troche.workers.dev

Runs entirely on the Cloudflare free tier — one Worker (API + React SPA), D1, KV, a SQLite-backed Durable Object, Workers AI, and a cron trigger.

---

## The claim, stated precisely

The score this system produces is a **triage priority**. It is not a probability, not a risk rating, and not a prediction of any outcome. It answers one question: *which of these anomalies should a person look at first?*

Everything downstream inherits that framing. The UI says "priority". The agent prompt is forbidden from calling it anything else, and [the validation gate rejects output that does](src/enrich/validate.ts). The eval measures **agreement with a human's triage judgement** — not correctness against a real-world outcome, because no such outcome label exists in this data.

---

## Architecture

Deterministic first, AI strictly downstream. **The system produces correct, ranked alerts with the model turned off.**

```
Cron ──► Ingest Worker ──► KV (raw day cache, TTL tiered by data maturity)
                             │
                             ▼
                        D1: complaints
                             │
              ┌──────────────┴──────────────┐
              ▼                             │
      Detection Worker                      │
   (baselines → 6 signals → score)          │
              │                             │
              ▼                             │
        D1: alerts ────────► Enrichment Worker ──► D1: enrichments
              │              (bounded packet, citations
              │               required, validation gate)
              ▼
        Analyst queue (React SPA)
              │
              ▼
        D1: dispositions ──────► Eval runner ──► D1: eval_runs, eval_items
```

| Layer | Code |
|---|---|
| 1 · Ingestion | [src/ingest/](src/ingest/) |
| 2 · Deterministic detection | [src/detect/](src/detect/) |
| 3 · Agentic enrichment | [src/enrich/](src/enrich/) |
| 4 · Analyst UI | [ui/src/](ui/src/) |
| 5 · Eval + gate | [src/evaluation/run.ts](src/evaluation/run.ts) |
| All tunables in one place | [src/config.ts](src/config.ts) |

---

## What the build actually taught us

Four things were wrong, or invisible, until the pipeline ran against live data. They are the most interesting output of the project, so they are at the top rather than in a footnote.

### 1. The source publishes long before the record is complete

The CFPB does not publish a finished complaint. Volume, company responses, and narratives each mature at a different rate. Measured over the ingested scope:

| Weeks after filing | Complaints/day on file | Settled | With narrative |
|---:|---:|---:|---:|
| 0 | 18 | 23% | 0% |
| 1 | 126 | 63% | 0% |
| 2 | 429 | 53% | 0% |
| 4 | 383 | 72% | 0% |
| 6 | 408 | 83% | 10% |
| 8 | 416 | 96% | 24% |
| 10 | 417 | 99% | 42% |
| 12 | 256 | 100% | 45% |

Volume is complete after about two weeks. Company responses settle after about eight. **Narratives — the model's only evidence — do not plateau until about ten.**

Running detection on fresh data therefore did three things wrong at once: it read the publication lag as a collapse in volume (every cell's z-score went negative), it read half-settled complaints as a drift in the response mix, and it handed the model evidence packets containing zero narratives. All three were observed before `publicationLagDays` existed.

So **this system is retrospective by construction.** Its detection window ends ten weeks before today, because that is when the data is actually there. It is not a near-real-time monitor and it cannot be one on this source. That is a real limitation of the data, not a shortcut, and it is the single most consequential number in the config.

### 2. A 14-day mean is not a daily standard deviation

The volume z-score divided the window's mean daily rate by the baseline's *day-to-day* standard deviation. That understates the deviation by √14 and flattened every genuine spike in the data to a z-score below 1 — the top cell in the whole database scored 0.97. The denominator has to be the standard error of a mean over the window. After the fix the same cell scores 2.57 and the ranking becomes meaningful.

The bug was invisible from the code and obvious from the distribution. Nothing in this repo would have caught it except looking at the numbers.

### 3. Two of the six signals barely exist in this data

- **Response-time degradation.** 93.6% of complaints are routed to the company the same day they are received, so the median days-to-company is 0 in almost every cell in almost every window. A median of 0 against a baseline of 0 is inert, and this signal spent its entire weight contributing nothing. It now falls back to comparing means when both medians are zero, and the reported values say which statistic was used — a signal that quietly switched definitions would be worse than one that did nothing.
- **Timeliness drift.** Only 263 of 54,000 settled complaints are marked untimely (0.5%). The signal is real but fires on very few cells.

Reporting a signal that cannot move is worse than not having it. Both are still computed and displayed; the UI shows why a signal scored zero.

### 4. On the free tier, indexes are what cost you

D1 meters **index writes as row writes**. `complaints` originally carried four secondary indexes, so every upserted complaint cost five row-writes against the free tier's 100k/day. A 160-day backfill of ~146k rows spent ~730k of quota and exhausted the account. Cutting to a single composite index leading with `date_received` takes it from 5 writes per complaint to 2. The row count was never the problem; the index count was.

---

## Design decisions worth defending

**Deterministic first, and it means it.** The score, the ranking, and the queue exist with `AI` unbound. The model produces prose and a proposed severity. If it fails, [the alert displays without enrichment](src/api/routes.ts) and nothing about its priority changes.

**Weights are declared, not fitted.** They live in [one config file](src/config.ts) and sum to 1.0, so the score reads directly as 0–100. Nothing learned them, because there is no outcome label in this data to learn from. Rationale: volume carries the most weight because it has the least ambiguous interpretation and the largest sample behind it; emerging-issue is next because it is the only signal that separates "this firm has a new problem" from "the whole market has this problem"; handling signals describe how a firm reacts rather than what consumers report; geographic concentration is weighted lowest because it is the noisiest and trips easiest on a small denominator.

**Saturation points are calibrated, which is not the same as fitted.** Each is set near the 95th percentile of that signal's observed positive values, so a signal at its historical extreme scores near 100 and the 0–100 range is actually used. The first uncalibrated pass compressed every real anomaly into the bottom fifth of the scale. The measured distribution is recorded in the config beside the constants.

**The emerging-issue signal subtracts the market.** A company's move in an issue's share, minus the move the whole market made in the same issue. Without that subtraction a sector-wide shift lights up every institution simultaneously, which is a fact about the sector and not about any firm.

**Handling signals are computed over settled complaints only.** Comparing a half-settled window against a fully-settled baseline manufactures drift out of nothing but the age of the data.

**Small-n is guarded twice.** Cells below 20 baseline complaints are excluded, not scored — a cell going from 1 to 4 carries a large z-score and no information. Share-based signals get a *higher* floor of their own, because six settled complaints can read 100% closed-without-relief and saturate a proportion on one or two extra cases. Small-n wrecks a proportion faster than it wrecks a count.

**Idempotency is enforced by a content hash, not hoped for.** Each complaint stores a hash of the fields we keep, and the upsert's `WHERE` clause skips rows whose hash has not changed. Re-running an ingested window writes **zero** rows — demonstrated at scale: a 160-day re-run reported `28274 upserted · 31179 unchanged`, the unchanged portion being every day already on file.

**All aggregation happens in SQL.** The Workers free tier allows 10 ms of CPU per invocation, nowhere near enough to stream tens of thousands of complaint rows through JavaScript. Every detection query returns at most a few hundred pre-aggregated rows and the Worker only does arithmetic on those.

**Propose-then-reveal is enforced at the transport layer.** The alert detail endpoint withholds the model's proposal unless the caller passes `reveal=1`, and the UI requests it only after the analyst's severity is locked. The proposed severity never reaches the browser before the analyst commits, so the agreement number cannot be measuring anchoring. Dispositions recorded without that guarantee are excluded from eval scoring outright.

**Citations are checkable, not decorative.** The model must cite inline as `[complaint_id]`. The gate then verifies, independently of the prompt: every cited id appears in the packet; every assertive sentence carries a citation; no figure appears that is not in the packet; no causal claim about the institution; no prediction of enforcement action; no framing of the score as a probability. Asking a model not to invent a number is not the same as checking that it did not.

---

## What was rejected

- **Offset pagination.** The CFPB search API silently ignores `frm` and `from` — it returns page one every time. An earlier ingester "paginated" eight pages deep and re-read the same 250 records eight times; the content hash hid the damage by reporting them as unchanged. Days are now read whole in one oversized request, and the returned count is checked against the total the source reports so a truncated read is recorded rather than assumed away.
- **Keying the KV cache on scope size.** The cache key encoded the *number* of products and companies. Swapping one product for another leaves the counts identical and would have served pages fetched under the old scope forever. The key now carries a fingerprint of the scope's members.
- **Credit reporting.** 93% of the database by volume and dominated by three bureaus. Including it would drown every other cell and turn the queue into a credit-bureau monitor.
- **Persisting every scored cell's baseline.** The baseline for a cell that raised no alert is not referenced by anything, and on a metered write budget it is quota spent on rows nothing will read.
- **Treating a failed enrichment as a disagreement.** A validation failure and a wrong severity are different problems; folding them together would let a variant that fails half its generations look merely mediocre. Failures are reported as their own rate and excluded from the agreement denominator.

---

## Stated limits

- **Coverage.** A rolling 160-day window scoped to a handful of products and institutions — not the full database. **Why:** D1's free-tier daily row limits make full ingestion impossible. Designing around the constraint and writing it down is the honest answer; unlimited scale is not on offer here.
- **Narrative coverage is partial.** Only complaints where the consumer consented to publication carry a narrative. Enrichment evidence is drawn only from those; counts are computed over all complaints in scope.
- **The score is a triage priority, not a prediction.** It ranks what to look at. It does not estimate the probability of anything.
- **Complaints are allegations.** They are consumer-submitted and unverified. The system makes no assertion about whether any institution did anything wrong, and the agent is prohibited from making causal or predictive claims.
- **Volume tracks attention as much as conduct.** Complaint counts move with market share, press coverage, and product launches. A spike is a reason to look, not a finding.
- **Baselines are shallow.** A 60-day trailing window will not capture seasonality.
- **Agreement is agreement with one person.** It measures consistency with a single reviewer's triage judgement, not correctness — there is no outcome label in this data.
- **This is an experiment, not a production system**, and it doesn't claim to be one.

Two further limits this build discovered, which belong with the ones above:

- **The system is retrospective by ten weeks.** See the maturity table. Detection cannot run on fresh data from this source without reading the publication lag as a signal.
- **Two of the six signals barely move on this data.** Response-time degradation is structurally inert (same-day routing) and timeliness drift fires on a 0.5% base rate.

---

## Data source

CFPB Consumer Complaint Database, public and free, no key:

```
https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/
```

**The API envelope does not use the field names on the CSV export.** Verified live while writing the mapper:

| CSV export name | API envelope name |
|---|---|
| `consumer_complaint_narrative` | `complaint_what_happened` |
| `timely_response` | `timely` |
| *(not in the CSV)* | `has_narrative` (boolean, authoritative) |

Getting this wrong yields a database with no narratives at all and no error to tell you.

**KV TTLs.** The source refreshes once daily, so anything under 24h buys nothing and only burns quota. But it is not append-only: narratives arrive and `company_response` moves off "In progress" for weeks. Days inside the 45-day amendment horizon get a 24h TTL; days beyond it, which have settled, get 30 days.

---

## API

```
GET  /api/alerts?status=&company=&product=&signal=&limit=&cursor=
GET  /api/alerts/:id[?reveal=1]     → alert + signals + drivers (+ enrichment only if reveal=1)
POST /api/alerts/:id/disposition    → { action, analyst_severity, reason }
GET  /api/complaints/:id
POST /api/enrich                    → { alert_ids[], variant_id }  (DO-tracked batch)
GET  /api/enrich/:batch_id/stream   → SSE progress from the Durable Object
POST /api/eval/runs                 → { variant_ids[], label_set_version }
GET  /api/eval/runs/:id             → agreement, per-segment breakdown, gate verdict
GET  /api/stats                     → coverage, freshness, ingest health
GET  /api/config                    → weights, thresholds, variants
POST /api/admin/ingest?date=|from=&to=   (token-gated)
POST /api/admin/detect[?preview=1&top=N] (token-gated; preview writes nothing)
POST /api/admin/enrich-one               (token-gated)
```

---

## Running it

```bash
npm install
npx wrangler d1 create crr-db          # put the id in wrangler.jsonc
npx wrangler kv namespace create RAW_CACHE
npm run db:migrate                     # applies migrations/
npm run deploy                         # builds the UI and deploys the Worker

# Optional but recommended: gate the admin routes.
openssl rand -hex 16 | npx wrangler secret put ADMIN_TOKEN
# Optional: enables the BYOK frontier variant. Without it that variant is skipped.
npx wrangler secret put ANTHROPIC_API_KEY

# Fill the window. The cron walks it a few days per night; this does it now.
node scripts/backfill.mjs https://<your-worker>.workers.dev <admin-token> 160 5
curl -X POST -H "authorization: Bearer <admin-token>" https://<your-worker>.workers.dev/api/admin/detect
```

**Budget the first backfill.** 160 days is ~146k complaint rows, and at 2 row-writes each (after migration 0002) that is ~292k row-writes against a 100k/day free-tier limit. Spread it across three days, or run it once on a paid plan. Steady-state cost is trivial: the cron refreshes three recent days and advances the backfill three days, roughly 2.5k rows a night.

`npm test` runs the unit suite. `npm run dev` serves the Worker locally; `npm run build:ui` builds the SPA into `ui/dist`.

---

## Free-tier constraints that shaped the design

| Limit | Consequence |
|---|---|
| 10 ms CPU per invocation | All aggregation is SQL; the Worker never touches raw rows |
| 50 subrequests per invocation | Ingestion is one day per call and resumable; enrichment batches cap at 10 |
| D1: 100k row-writes/day, index writes included | One composite index; unchanged rows skipped via content hash; baselines persisted only for alerting cells |
| D1: 100 bound parameters per query | Row-per-statement batches; `IN` lists chunked at 90 |
| CFPB API ignores offset pagination | Days read whole, returned count verified against reported total |
| Durable Objects on free plan | SQLite-backed classes only (`new_sqlite_classes`) |
| 5 cron triggers per account | See below |

The daily cron (`17 9 * * *`) is declared in `wrangler.jsonc` but **is not currently
attached**: this Cloudflare account already has its free-tier maximum of 5 cron triggers
across other Workers, so the deploy reports `code: 10072` and skips the trigger while
deploying the Worker itself normally. Freeing a slot on another Worker and re-running
`npx wrangler deploy` attaches it with no code change. Until then the same work runs via
`POST /api/admin/ingest` and `POST /api/admin/detect`, which is exactly what the cron
handler calls.
