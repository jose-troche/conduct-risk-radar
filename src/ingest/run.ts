import { INGEST, SCOPE } from "../config";
import type { Env, NormalisedComplaint } from "../types";
import { addDays, nowIso, today, toDay } from "../lib/time";
import { newId } from "../lib/http";
import {
  cacheKey,
  normalise,
  pageUrl,
  ttlFor,
  type CfpbPage,
} from "./cfpb";

export interface IngestResult {
  run_id: string;
  days: string[];
  pages_fetched: number;
  cache_hits: number;
  rows_seen: number;
  rows_upserted: number;
  rows_skipped: number;
  /** Slices the source said were larger than the response it returned. */
  incomplete: string[];
  status: "ok" | "error";
  error?: string;
  /** Set when rows were upserted but closing the run record failed. */
  bookkeeping_error?: string;
}

/**
 * One slice of one day. Returns the hits, the total the source says exist for
 * that slice, and whether KV served it.
 *
 * The total matters: this API has no usable offset, so a returned count equal
 * to the requested size is indistinguishable from a truncated read. Carrying
 * the total back is what lets the caller notice.
 */
async function fetchSlice(
  env: Env,
  day: string,
  products: readonly string[],
): Promise<{ hits: { _source: unknown }[]; total: number; cached: boolean }> {
  const key = cacheKey(day, products);
  const cached = await env.RAW_CACHE.get(key, "json");
  if (cached) {
    const page = cached as CfpbPage;
    return {
      hits: page.hits.hits,
      total: page.hits.total?.value ?? page.hits.hits.length,
      cached: true,
    };
  }
  const res = await fetch(pageUrl(day, products), {
    headers: { accept: "application/json", "user-agent": "conduct-risk-radar" },
  });
  if (!res.ok) {
    throw new Error(`CFPB ${res.status} for ${day}`);
  }
  const body = (await res.json()) as CfpbPage;
  const hits = body?.hits?.hits ?? [];
  const total = body?.hits?.total?.value ?? hits.length;
  // Only the hits and the total are cached. The aggregation and break-point
  // sections of the envelope are large and nothing here reads them.
  await env.RAW_CACHE.put(
    key,
    JSON.stringify({ hits: { hits, total: { value: total } } }),
    { expirationTtl: ttlFor(day) },
  );
  return { hits, total, cached: false };
}

/**
 * Upsert a batch of complaints.
 *
 * Idempotency is the whole point: the WHERE clause on the DO UPDATE means a
 * re-run over an unchanged day writes zero rows. D1 caps bound parameters at
 * 100 per query, so each row is its own statement inside a batch rather than a
 * multi-row VALUES list.
 */
const UPSERT = `
INSERT INTO complaints (
  complaint_id, date_received, date_sent_to_company, company, product,
  sub_product, issue, sub_issue, state, submitted_via, company_response,
  company_public_response, timely_response, has_narrative, narrative,
  cell_key, response_days, settled, adverse, ingested_at, source_hash
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
ON CONFLICT(complaint_id) DO UPDATE SET
  date_received = excluded.date_received,
  date_sent_to_company = excluded.date_sent_to_company,
  company = excluded.company,
  product = excluded.product,
  sub_product = excluded.sub_product,
  issue = excluded.issue,
  sub_issue = excluded.sub_issue,
  state = excluded.state,
  submitted_via = excluded.submitted_via,
  company_response = excluded.company_response,
  company_public_response = excluded.company_public_response,
  timely_response = excluded.timely_response,
  has_narrative = excluded.has_narrative,
  narrative = excluded.narrative,
  cell_key = excluded.cell_key,
  response_days = excluded.response_days,
  settled = excluded.settled,
  adverse = excluded.adverse,
  ingested_at = excluded.ingested_at,
  source_hash = excluded.source_hash
WHERE complaints.source_hash <> excluded.source_hash`;

async function upsertAll(
  env: Env,
  rows: NormalisedComplaint[],
): Promise<{ upserted: number; skipped: number }> {
  if (rows.length === 0) return { upserted: 0, skipped: 0 };
  const at = nowIso();
  const stmt = env.DB.prepare(UPSERT);
  let upserted = 0;
  // Chunked so a single batch never approaches D1's 30s statement budget.
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const results = await env.DB.batch(
      chunk.map((c) =>
        stmt.bind(
          c.complaint_id,
          c.date_received,
          c.date_sent_to_company,
          c.company,
          c.product,
          c.sub_product,
          c.issue,
          c.sub_issue,
          c.state,
          c.submitted_via,
          c.company_response,
          c.company_public_response,
          c.timely_response,
          c.has_narrative,
          c.narrative,
          c.cell_key,
          c.response_days,
          c.settled,
          c.adverse,
          at,
          c.source_hash,
        ),
      ),
    );
    for (const r of results) upserted += r.meta?.changes ?? 0;
  }
  return { upserted, skipped: rows.length - upserted };
}

/**
 * Ingest one day.
 *
 * The whole day is requested in a single oversized read. If the source reports
 * more records than came back, the day is re-read one product at a time, which
 * is the only slicing dimension this API offers that reliably shrinks a day
 * below the response cap. A slice that still overflows is recorded as an
 * incomplete read rather than silently dropped - an ingestion layer that cannot
 * tell you what it missed is not observable.
 */
async function ingestDay(
  env: Env,
  day: string,
  result: IngestResult,
): Promise<void> {
  const consume = async (products: readonly string[]) => {
    const { hits, total, cached } = await fetchSlice(env, day, products);
    result.pages_fetched++;
    if (cached) result.cache_hits++;
    result.rows_seen += hits.length;

    const rows: NormalisedComplaint[] = [];
    for (const h of hits) {
      const n = normalise((h as { _source: never })._source);
      if (n) rows.push(n);
    }
    const { upserted, skipped } = await upsertAll(env, rows);
    result.rows_upserted += upserted;
    result.rows_skipped += skipped;
    return { returned: hits.length, total };
  };

  const whole = await consume(SCOPE.products);
  if (whole.total <= whole.returned) return;

  for (const product of SCOPE.products) {
    if (result.pages_fetched >= INGEST.maxRequestsPerInvocation) break;
    const slice = await consume([product]);
    if (slice.total > slice.returned) {
      result.incomplete.push(
        `${day} ${product}: source reports ${slice.total}, response carried ${slice.returned}`,
      );
    }
  }
}

/** Ingest a specific list of days. */
export async function ingestDays(
  env: Env,
  days: string[],
  trigger: "cron" | "manual" = "manual",
): Promise<IngestResult> {
  const runId = newId("ing");
  const started = nowIso();
  const sorted = [...days].sort();
  await env.DB.prepare(
    `INSERT INTO ingest_runs (id, started_at, window_start, window_end, status, trigger)
     VALUES (?1,?2,?3,?4,'running',?5)`,
  )
    .bind(runId, started, sorted[0] ?? null, sorted.at(-1) ?? null, trigger)
    .run();

  const result: IngestResult = {
    run_id: runId,
    days: sorted,
    pages_fetched: 0,
    cache_hits: 0,
    rows_seen: 0,
    rows_upserted: 0,
    rows_skipped: 0,
    incomplete: [],
    status: "ok",
  };

  try {
    for (const day of sorted) await ingestDay(env, day, result);
  } catch (e) {
    result.status = "error";
    result.error = e instanceof Error ? e.message : String(e);
  }

  // Bookkeeping, in its own try for the same reason as in detect/run.ts: rows
  // that were upserted stay upserted whether or not the run record closes.
  try {
    await env.DB.prepare(
      `UPDATE ingest_runs SET finished_at=?2, pages_fetched=?3, cache_hits=?4,
         rows_seen=?5, rows_upserted=?6, rows_skipped=?7, status=?8, error=?9
       WHERE id=?1`,
    )
      .bind(
        runId,
        nowIso(),
        result.pages_fetched,
        result.cache_hits,
        result.rows_seen,
        result.rows_upserted,
        result.rows_skipped,
        result.status,
        result.error ??
          (result.incomplete.length > 0
            ? `incomplete reads: ${result.incomplete.join("; ")}`
            : null),
      )
      .run();
  } catch (e) {
    result.bookkeeping_error = e instanceof Error ? e.message : String(e);
  }

  return result;
}

/**
 * The cron path. Two jobs on every run:
 *
 *  1. Re-check the most recent few days, because the source amends them.
 *  2. Advance the backfill cursor a few days further back, until the rolling
 *     window is full.
 *
 * Both are bounded so that a single invocation stays inside the free tier's 50
 * subrequests and 10ms of CPU. The backfill therefore completes over a number
 * of cron runs rather than in one shot, which is also what makes it safe to
 * interrupt: the cursor is the only state.
 */
export async function cronIngest(env: Env): Promise<IngestResult> {
  const now = today();
  const floor = addDays(now, -SCOPE.windowDays);
  const state = await env.DB.prepare(
    `SELECT next_backfill_date, backfill_floor FROM ingest_state WHERE id='default'`,
  ).first<{ next_backfill_date: string | null; backfill_floor: string | null }>();

  const days: string[] = [];
  for (let i = 0; i < INGEST.cronRefreshDays; i++) days.push(addDays(now, -i));

  let cursor = state?.next_backfill_date ?? addDays(now, -INGEST.cronRefreshDays);
  for (let i = 0; i < INGEST.cronBackfillDays && cursor >= floor; i++) {
    if (!days.includes(cursor)) days.push(cursor);
    cursor = addDays(cursor, -1);
  }

  const result = await ingestDays(env, days, "cron");

  await env.DB.prepare(
    `INSERT INTO ingest_state (id, next_backfill_date, backfill_floor, updated_at)
     VALUES ('default',?1,?2,?3)
     ON CONFLICT(id) DO UPDATE SET next_backfill_date=excluded.next_backfill_date,
       backfill_floor=excluded.backfill_floor, updated_at=excluded.updated_at`,
  )
    .bind(cursor >= floor ? cursor : floor, floor, nowIso())
    .run();

  // Rows that have aged out of the rolling window are dropped, so the database
  // stays inside the free tier's 500 MB rather than growing without bound.
  await env.DB.prepare(`DELETE FROM complaints WHERE date_received < ?1`)
    .bind(addDays(floor, -1))
    .run();

  return result;
}

export function parseDaysParam(url: URL): string[] | null {
  const single = url.searchParams.get("date");
  if (single) return [toDay(single)];
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return null;
  const out: string[] = [];
  for (let d = toDay(from); d <= toDay(to); d = addDays(d, 1)) out.push(d);
  return out;
}
