# Conduct Risk Radar — Specification

A conduct-risk detection and triage system built on the **CFPB Consumer Complaint Database**: real, public complaint data filed against financial institutions. The system detects emerging issues against computed baselines, triages them into a priority queue, drafts an analyst-ready rationale with citations, captures human dispositions, and turns those dispositions into a labeled set used to evaluate model variants.

**Status:** specification. Nothing built yet.

---

## 1. What this is for

An experiment in putting a generative model into a real detection-and-triage pipeline without letting it do the part it's bad at. Two ideas are being tested:

1. **Deterministic first, model downstream.** Statistics find the anomaly; the model only explains one that already exists, from a bounded evidence packet. If the model fails, the alert still stands.
2. **The human loop produces the eval set.** Analyst dispositions are labels. Labels make variant comparison possible on real data instead of a synthetic golden set, with a per-segment ship gate.

**Non-goals.** Not a prediction system. Not a regulatory-compliance tool. Not a complete view of the complaint database. Not production-grade. See §11.

---

## 2. The claim, stated precisely

The score this system produces is a **triage priority**, not a probability, not a risk rating, and not a prediction of any outcome. It answers one question: *which of these anomalies should a person look at first?*

Everything downstream inherits that framing. The UI says "priority," the README says "priority," the agent prompt is forbidden from calling it anything else, and the eval measures agreement with a human's triage judgment — not correctness against a real-world outcome, because no such outcome label exists in this data.

---

## 3. Data source

**CFPB Consumer Complaint Database.** Public, free, no key. Search API base:

```
https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/
```

Fields used (verify exact names against the live API before writing the mapper — they differ between the CSV export and the API response envelope):

| Field | Use |
|---|---|
| `complaint_id` | Primary key; the citation target |
| `date_received` | Bucketing, baselines, freshness |
| `company` | Primary grouping dimension |
| `product` / `sub_product` | Grouping dimension |
| `issue` / `sub_issue` | Grouping dimension; emerging-issue detection |
| `state` | Geographic clustering |
| `consumer_complaint_narrative` | Agent evidence (present only where the consumer consented) |
| `company_response` | Response-mix drift |
| `company_public_response` | Context for the agent |
| `timely_response` | Timeliness drift |
| `date_sent_to_company` | Response-latency proxy |
| `submitted_via` | Segment control |

**Narrative coverage is partial by design.** Only a minority of complaints carry a published narrative. Every count in the system is computed over all complaints in scope; only the evidence packet is limited to those with narratives. That asymmetry must be visible in the UI, not buried.

---

## 4. Architecture

Deterministic first, AI strictly downstream. The system produces correct alerts with the model turned off.

```
Cron ──► Ingest Worker ──► KV (raw page cache, TTL)
                             │
                             ▼
                        D1: complaints
                             │
              ┌──────────────┴──────────────┐
              ▼                             │
      Detection Worker                      │
   (baselines → signals → score)            │
              │                             │
              ▼                             │
        D1: alerts ────────► Enrichment Worker ──► D1: enrichments
              │              (bounded evidence packet,
              │               citations required)
              ▼
        Analyst queue (Pages/React)
              │
              ▼
        D1: dispositions ──────► Eval runner ──► D1: eval_runs, eval_items
```

### Layer 1 — Ingestion (Cron Trigger → Worker)

- Pull a rolling window from the CFPB API, paginated, scoped per §11.
- Cache raw API pages in **KV** with a defensible TTL (proposed: 24h — the source updates daily, so anything shorter buys nothing and burns quota; record the reasoning in the README).
- Normalize into the common event model (§5) and upsert into **D1** keyed on `complaint_id`. Upsert, not insert: the CFPB backfills and amends records.
- Record every run in `ingest_runs` — window requested, pages fetched, rows upserted, rows skipped, errors. An ingestion layer that can't tell you what it did last night is not observable.

**Idempotency.** Re-running the same window must not change row counts or duplicate anything. Test this explicitly.

### Layer 2 — Deterministic detection (no model)

Runs after ingestion. Computes over `(company, product, issue)` cells and their rollups.

- **Baselines.** Trailing-window mean and standard deviation of daily complaint volume per cell, over a configurable baseline window (proposed: 60 days), excluding the detection window itself so the signal doesn't contaminate its own baseline.
- **Volume anomaly.** z-score of the detection window's rate against the baseline. Guard against small-n: cells below a minimum baseline volume (proposed: 20 complaints) are excluded, not scored — a cell going from 1 to 4 is noise wearing a large z-score. Simple rate-of-change is an acceptable substitute; don't over-engineer.
- **Response-time degradation.** Median `date_sent_to_company - date_received` in the detection window vs. baseline median.
- **Timeliness drift.** Share of `timely_response = No` in window vs. baseline share.
- **Response-mix drift.** Shift in the `company_response` distribution (e.g., toward "Closed without relief"). Two-proportion comparison is enough.
- **Geographic clustering.** Share of the cell's window volume concentrated in a single state vs. that state's baseline share for the cell.
- **Emerging issue.** A `(product, issue)` pair whose *share* of a company's volume is rising faster than the pair's base rate across all companies — separates "this company has a new problem" from "everyone has this problem this month."

**Scoring.** Each signal normalizes to 0–100; the alert score is a weighted sum with weights declared in one config file, not scattered through the code. Weights are a stated design choice, not a fitted result — say so. Every alert persists its **computed inputs** (each signal's raw value, normalized value, and weight contribution) so the score is reconstructible and the agent can be handed real numbers instead of being asked to invent them.

**Deduplication.** An alert that fires on consecutive days for the same cell is one alert with a lifecycle, not N alerts. Key on `(cell, signal_type)` and update `last_seen_at` / current score.

### Layer 3 — Agentic enrichment

Runs only on alerts above a score threshold, and only after the alert exists.

**The evidence packet** — everything the model gets, and nothing else:
- The alert: cell identifiers, score, and each contributing signal with its computed value and baseline comparison.
- A bounded sample of the specific complaints driving the anomaly (proposed: up to 15, selected by recency and narrative presence), each with its `complaint_id`, date, product, issue, state, company response, and narrative.
- Nothing retrieved at generation time. No web access. No other alerts.

**Output contract** (structured, schema-validated):
- `summary` — plain language, what appears to be happening.
- `proposed_severity` — one of `low` / `medium` / `high`, with reasoning.
- `citations` — for **every** assertion, the `complaint_id`s supporting it.
- `signals_referenced` — which computed signals the reasoning leaned on.

**Prohibited in the prompt, and validated after generation:**
- Inventing volumes, dates, or counts not present in the packet.
- Causal claims about the institution ("the bank changed its policy").
- Predictions about regulatory or enforcement action.
- Any assertion without a citation.

**Validation gate.** Post-generation, verify every cited `complaint_id` appears in the packet. A hallucinated citation fails the enrichment. Failed enrichments are recorded with their reason (that failure rate is itself a number worth reporting) and the alert displays **without** enrichment. The deterministic alert always stands on its own.

**Live progress.** A Durable Object per enrichment batch, streaming status to the UI.

### Layer 4 — Human disposition

The analyst view:
- **Queue** — alerts ordered by priority, filterable by company / product / signal type / date.
- **Detail** — the computed signals with their contributions, the driving complaints (narrative expandable), and the drafted rationale with citations rendered as links back to the specific complaints.
- **Actions** — *escalate* / *monitor* / *dismiss*, plus a required free-text reason and an **analyst severity** (`low`/`medium`/`high`) recorded independently of the model's proposal.

The analyst severity is captured **before** the model's proposal is revealed, or the agreement number measures anchoring rather than agreement. This is a hard UI requirement, not a nicety: propose-then-reveal, one screen, no going back.

### Layer 5 — Feedback and eval loop

Dispositions are the labeled set. Target 40–60 labels; 20 is enough for a first read.

- **Agreement rate**, not accuracy — there is no ground truth beyond the human, and saying "accuracy" would claim one. Report exact-match agreement on severity plus an adjacent-agreement (off-by-one) rate, and a confusion matrix.
- **Per segment**, always: per product, per signal type, per severity level. An average hides the segment where the system fails, which is the only segment worth looking at.
- **Variants.** Run 2–3 (prompt × model — Workers AI default vs. a BYOK frontier model) against the same labeled set. Report quality, **cost, and latency** per variant.
- **The gate.** A variant ships only if it clears a floor **in every segment**, not on the mean. A variant that lifts the average while collapsing on one product is a regression.
- Persist every eval run and every per-item score so a run is reproducible and comparable.

---

## 5. Data model (D1)

Indicative schema; refine during the ingestion build.

```sql
complaints(
  complaint_id TEXT PRIMARY KEY, date_received TEXT, date_sent_to_company TEXT,
  company TEXT, product TEXT, sub_product TEXT, issue TEXT, sub_issue TEXT,
  state TEXT, submitted_via TEXT, company_response TEXT, company_public_response TEXT,
  timely_response INTEGER, has_narrative INTEGER, narrative TEXT,
  ingested_at TEXT, source_hash TEXT
)

ingest_runs(id, started_at, finished_at, window_start, window_end,
            pages_fetched, rows_upserted, rows_skipped, status, error)

baselines(cell_key, company, product, issue, window_start, window_end,
          n, mean_daily, stddev_daily, median_response_days,
          untimely_share, response_mix_json, computed_at)

alerts(
  id, cell_key, company, product, issue,
  signal_type, score, status,            -- open | dispositioned | stale
  window_start, window_end,
  signals_json,                          -- per-signal raw, normalized, weight, contribution
  driver_complaint_ids_json,
  first_seen_at, last_seen_at
)

enrichments(
  id, alert_id, variant_id, model, prompt_version,
  summary, proposed_severity, reasoning, citations_json, signals_referenced_json,
  validation_status,                     -- ok | bad_citation | schema_fail | refused
  validation_detail, input_tokens, output_tokens, cost_usd, latency_ms, created_at
)

dispositions(
  id, alert_id, action,                  -- escalate | monitor | dismiss
  analyst_severity, reason, analyst_id,
  enrichment_shown_after INTEGER,        -- guards the anchoring requirement
  created_at
)

eval_runs(id, label_set_version, variant_ids_json, started_at, finished_at, notes)

eval_items(
  id, eval_run_id, alert_id, variant_id,
  proposed_severity, analyst_severity, agreement,   -- exact | adjacent | miss
  segment_product, segment_signal_type, cost_usd, latency_ms
)
```

**Free-tier note.** D1's daily row limits are the binding constraint (§11). Baselines are recomputed into a table rather than derived per request — the read budget matters more than the storage.

---

## 6. API surface (Worker routes)

```
GET  /api/alerts?status=&company=&product=&signal=&limit=&cursor=
GET  /api/alerts/:id                 → alert + signals + drivers + enrichment
POST /api/alerts/:id/disposition     → { action, analyst_severity, reason }
GET  /api/complaints/:id
POST /api/enrich                     → { alert_ids[], variant_id }  (DO-tracked batch)
GET  /api/enrich/:batch_id/stream    → SSE progress from the DO
POST /api/eval/runs                  → { variant_ids[], label_set_version }
GET  /api/eval/runs/:id              → agreement, per-segment breakdown, gate verdict
GET  /api/stats                      → coverage, freshness, ingest health
```

---

## 7. Stack (Cloudflare free tier)

| Piece | Service |
|---|---|
| Collector | Cron Trigger → Worker |
| Raw feed cache | KV, TTL defended per source |
| Complaints, alerts, dispositions, eval runs | D1 |
| Model calls | Workers AI (default path); BYOK tier for the frontier comparison |
| Live run progress | Durable Object |
| UI | Pages / React |

---

## 8. Build order

| Phase | Deliverable | Done when |
|---|---|---|
| **1** | Ingestion + normalization + D1 schema | Real CFPB rows in D1; re-running the window is idempotent; `ingest_runs` populated |
| **2** | Deterministic detection + scoring | Alerts generate and rank **with the model off**; every alert's score reconstructible from its stored inputs |
| **3** | Agentic enrichment | Bounded packet, structured output, citation validation gate, failure path leaves the alert intact |
| **4** | Analyst queue UI + disposition capture | Queue → detail → propose-then-reveal → disposition persisted |
| **5** | Labels + variants + numbers | 40–60 labels, 2–3 variants, per-segment agreement, gate verdict, written notes on what surprised you |

**Cut order if scope runs long** (cut from the bottom, never from the top):
1. Deterministic layer + one agent + 20 labeled dispositions — this is the floor, and it's a complete experiment on its own.
2. Second variant comparison.
3. Geographic clustering and response-mix drift signals.
4. UI polish. First thing to cut, last thing anyone notices.

---

## 9. Definition of done

- [ ] Deployed live at a URL.
- [ ] Detection runs and ranks correctly with the model disabled.
- [ ] No enrichment ships an uncited assertion; the validation failure rate is a reportable number.
- [ ] ≥20 (target 40–60) dispositions captured, severity recorded before the model's proposal is shown.
- [ ] Per-segment agreement reported for ≥2 variants, with cost and latency.
- [ ] Gate verdict computed against per-segment floors.
- [ ] README states coverage, freshness, and limits (§11).
- [ ] Write-up: the problem, what was decided, what was rejected, where the boundaries are, what surprised you.

---

## 10. Metrics to report

- Exact and adjacent severity agreement, overall and per segment.
- Confusion matrix, human severity × proposed severity.
- Citation validation failure rate per variant.
- Cost per enrichment and p50/p95 latency per variant.
- Coverage: complaints in window, share with narrative, cells above the minimum-volume floor.
- Ingest freshness: lag between `date_received` max and now.

---

## 11. Stated limits (goes in the README verbatim, not softened)

- **Coverage.** A rolling 90-day window scoped to a handful of products and institutions — not the full database. **Why:** D1's free-tier daily row limits make full ingestion impossible. Designing around the constraint and writing it down is the honest answer; unlimited scale is not on offer here.
- **Narrative coverage is partial.** Only complaints where the consumer consented to publication carry a narrative. Enrichment evidence is drawn only from those; counts are computed over all complaints in scope.
- **The score is a triage priority, not a prediction.** It ranks what to look at. It does not estimate the probability of anything.
- **Complaints are allegations.** They are consumer-submitted and unverified. The system makes no assertion about whether any institution did anything wrong, and the agent is prohibited from making causal or predictive claims.
- **Volume tracks attention as much as conduct.** Complaint counts move with market share, press coverage, and product launches. A spike is a reason to look, not a finding.
- **Baselines are shallow.** A 60-day trailing window will not capture seasonality.
- **Agreement is agreement with one person.** It measures consistency with a single reviewer's triage judgment, not correctness — there is no outcome label in this data.
- **This is an experiment, not a production system**, and it doesn't claim to be one.
