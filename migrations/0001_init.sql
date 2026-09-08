-- Conduct Risk Radar — initial schema.
-- Columns marked "derived at ingest" are precomputed so that detection can run
-- entirely as SQL aggregates: the Workers free tier gives 10ms of CPU per
-- invocation, so the Worker must never loop over raw complaint rows.

CREATE TABLE IF NOT EXISTS complaints (
  complaint_id            TEXT PRIMARY KEY,
  date_received           TEXT NOT NULL,        -- YYYY-MM-DD
  date_sent_to_company    TEXT,                 -- YYYY-MM-DD
  company                 TEXT NOT NULL,
  product                 TEXT NOT NULL,
  sub_product             TEXT,
  issue                   TEXT NOT NULL,
  sub_issue               TEXT,
  state                   TEXT,
  submitted_via           TEXT,
  company_response        TEXT,
  company_public_response TEXT,
  timely_response         INTEGER,              -- 1 yes / 0 no / NULL unknown
  has_narrative           INTEGER NOT NULL DEFAULT 0,
  narrative               TEXT,
  cell_key                TEXT NOT NULL,        -- derived: company|product|issue
  response_days           INTEGER,              -- derived: sent - received, in days
  settled                 INTEGER NOT NULL DEFAULT 0, -- derived: company_response is final
  adverse                 INTEGER NOT NULL DEFAULT 0, -- derived: settled without relief
  ingested_at             TEXT NOT NULL,
  source_hash             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_complaints_date     ON complaints(date_received);
CREATE INDEX IF NOT EXISTS idx_complaints_cell     ON complaints(cell_key, date_received);
CREATE INDEX IF NOT EXISTS idx_complaints_company  ON complaints(company, date_received);
CREATE INDEX IF NOT EXISTS idx_complaints_prodissue ON complaints(product, issue, date_received);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  window_start   TEXT,
  window_end     TEXT,
  pages_fetched  INTEGER NOT NULL DEFAULT 0,
  cache_hits     INTEGER NOT NULL DEFAULT 0,
  rows_seen      INTEGER NOT NULL DEFAULT 0,
  rows_upserted  INTEGER NOT NULL DEFAULT 0,
  rows_skipped   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,                 -- running | ok | error
  trigger        TEXT NOT NULL DEFAULT 'manual',-- cron | manual
  error          TEXT
);

-- Resumable backfill cursor. One row, id = 'default'.
CREATE TABLE IF NOT EXISTS ingest_state (
  id             TEXT PRIMARY KEY,
  next_backfill_date TEXT,                      -- next (older) day to fetch
  backfill_floor TEXT,                          -- oldest day in scope
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS baselines (
  cell_key             TEXT NOT NULL,
  company              TEXT NOT NULL,
  product              TEXT NOT NULL,
  issue                TEXT NOT NULL,
  window_start         TEXT NOT NULL,
  window_end           TEXT NOT NULL,
  n                    INTEGER NOT NULL,
  mean_daily           REAL NOT NULL,
  stddev_daily         REAL NOT NULL,
  median_response_days REAL,
  untimely_share       REAL,
  adverse_share        REAL,
  top_state            TEXT,
  top_state_share      REAL,
  issue_share          REAL,                    -- this issue's share of the company's volume
  market_issue_share   REAL,                    -- the same (product,issue) share across all companies
  response_mix_json    TEXT NOT NULL DEFAULT '{}',
  computed_at          TEXT NOT NULL,
  PRIMARY KEY (cell_key, window_start, window_end)
);

CREATE TABLE IF NOT EXISTS alerts (
  id                       TEXT PRIMARY KEY,
  cell_key                 TEXT NOT NULL,
  company                  TEXT NOT NULL,
  product                  TEXT NOT NULL,
  issue                    TEXT NOT NULL,
  signal_type              TEXT NOT NULL,       -- dominant contributing signal
  score                    REAL NOT NULL,
  status                   TEXT NOT NULL,       -- open | dispositioned | stale
  window_start             TEXT NOT NULL,
  window_end               TEXT NOT NULL,
  baseline_start           TEXT NOT NULL,
  baseline_end             TEXT NOT NULL,
  window_n                 INTEGER NOT NULL,
  window_narrative_n       INTEGER NOT NULL DEFAULT 0,
  baseline_n               INTEGER NOT NULL,
  signals_json             TEXT NOT NULL,       -- per-signal raw, normalized, weight, contribution
  driver_complaint_ids_json TEXT NOT NULL DEFAULT '[]',
  weights_version          TEXT NOT NULL,
  first_seen_at            TEXT NOT NULL,
  last_seen_at             TEXT NOT NULL,
  UNIQUE (cell_key, signal_type)
);

CREATE INDEX IF NOT EXISTS idx_alerts_rank ON alerts(status, score DESC);

CREATE TABLE IF NOT EXISTS detection_runs (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  window_start  TEXT,
  window_end    TEXT,
  baseline_start TEXT,
  baseline_end  TEXT,
  cells_examined INTEGER NOT NULL DEFAULT 0,
  cells_scored   INTEGER NOT NULL DEFAULT 0,
  alerts_created INTEGER NOT NULL DEFAULT 0,
  alerts_updated INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS enrichments (
  id                    TEXT PRIMARY KEY,
  alert_id              TEXT NOT NULL,
  batch_id              TEXT,
  variant_id            TEXT NOT NULL,
  model                 TEXT NOT NULL,
  prompt_version        TEXT NOT NULL,
  summary               TEXT,
  proposed_severity     TEXT,                   -- low | medium | high
  reasoning             TEXT,
  citations_json        TEXT NOT NULL DEFAULT '[]',
  signals_referenced_json TEXT NOT NULL DEFAULT '[]',
  packet_complaint_ids_json TEXT NOT NULL DEFAULT '[]',
  validation_status     TEXT NOT NULL,          -- ok | bad_citation | schema_fail | uncited_assertion | prohibited_claim | refused | error
  validation_detail     TEXT,
  raw_output            TEXT,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cost_usd              REAL,
  latency_ms            INTEGER,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_enrichments_alert ON enrichments(alert_id, variant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dispositions (
  id                     TEXT PRIMARY KEY,
  alert_id               TEXT NOT NULL,
  action                 TEXT NOT NULL,         -- escalate | monitor | dismiss
  analyst_severity       TEXT NOT NULL,         -- low | medium | high
  reason                 TEXT NOT NULL,
  analyst_id             TEXT NOT NULL,
  enrichment_shown_after INTEGER NOT NULL,      -- 1 = model proposal revealed only after severity was locked
  enrichment_existed     INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispositions_alert ON dispositions(alert_id, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_runs (
  id                TEXT PRIMARY KEY,
  label_set_version TEXT NOT NULL,
  variant_ids_json  TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  label_count       INTEGER NOT NULL DEFAULT 0,
  results_json      TEXT,                       -- per-variant + per-segment metrics and gate verdict
  gate_verdict_json TEXT,
  status            TEXT NOT NULL,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS eval_items (
  id                 TEXT PRIMARY KEY,
  eval_run_id        TEXT NOT NULL,
  alert_id           TEXT NOT NULL,
  variant_id         TEXT NOT NULL,
  enrichment_id      TEXT,
  proposed_severity  TEXT,
  analyst_severity   TEXT NOT NULL,
  agreement          TEXT NOT NULL,             -- exact | adjacent | miss | no_output
  validation_status  TEXT,
  segment_product    TEXT NOT NULL,
  segment_signal_type TEXT NOT NULL,
  segment_severity   TEXT NOT NULL,
  cost_usd           REAL,
  latency_ms         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_eval_items_run ON eval_items(eval_run_id, variant_id);
