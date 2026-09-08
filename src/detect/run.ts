import { DETECTION, ENRICH, WEIGHTS_VERSION } from "../config";
import type { Env } from "../types";
import { addDays, daysBetween, nowIso, today } from "../lib/time";
import { newId } from "../lib/http";
import { round } from "../lib/stats";
import {
  Q_CELL_AGG,
  Q_COMPANY_TOTALS,
  Q_MARKET_ISSUE,
  Q_MEDIAN_RESPONSE,
  Q_RESPONSE_MIX,
  Q_STATE_SHARES,
  Q_TOP_STATE,
  qDrivers,
  type CellAgg,
} from "./queries";
import { computeSignals, scoreCell, type CellContext } from "./signals";
import type { SignalDetail } from "../types";

export interface DetectionResult {
  run_id: string;
  window_start: string;
  window_end: string;
  baseline_start: string;
  baseline_end: string;
  cells_examined: number;
  cells_scored: number;
  alerts_created: number;
  alerts_updated: number;
  alerts_stale: number;
  status: "ok" | "error";
  error?: string;
}

interface Windows {
  windowStart: string;
  windowEnd: string;
  baselineStart: string;
  baselineEnd: string;
}

/**
 * Where the detection window sits.
 *
 * Not "today", and not the newest complaint on file either. Both of those put
 * the window inside data the CFPB has not finished publishing, which reads as a
 * collapse in volume, a drift in the response mix, and an evidence packet with
 * no narratives in it. The window therefore ends publicationLagDays before
 * today - see the maturity table on that constant - and is additionally capped
 * at the newest complaint on file so that a database still backfilling cannot
 * be measured against a window it has no rows for.
 */
export async function resolveWindows(
  env: Env,
  asOf?: string | null,
): Promise<Windows | null> {
  let end = asOf ?? null;
  if (!end) {
    const row = await env.DB.prepare(
      `SELECT MAX(date_received) AS d FROM complaints`,
    ).first<{ d: string | null }>();
    if (!row?.d) return null;
    const matured = addDays(today(), -DETECTION.publicationLagDays);
    const newest = addDays(row.d, 1);
    end = matured < newest ? matured : newest;
  }
  const windowStart = addDays(end, -DETECTION.detectionWindowDays);
  return {
    windowEnd: end,
    windowStart,
    // The baseline ends where the detection window begins, so the signal never
    // contaminates the baseline it is being measured against.
    baselineEnd: windowStart,
    baselineStart: addDays(windowStart, -DETECTION.baselineWindowDays),
  };
}

type Row = Record<string, unknown>;

function index<T>(rows: T[], key: keyof T): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(String(r[key]), r);
  return m;
}

export interface PreviewCell {
  cell_key: string;
  company: string;
  product: string;
  issue: string;
  window_n: number;
  baseline_n: number;
  score: number;
  dominant: string;
  signals: unknown[];
}

/**
 * Score every cell and return the ranking without writing anything.
 *
 * Thresholds and saturation points are judgement calls, and a judgement call
 * made without looking at the distribution it applies to is a guess. This is
 * how that distribution gets inspected.
 */
export async function previewDetection(
  env: Env,
  asOf?: string | null,
  top = 25,
): Promise<{ windows: Windows | null; cells_scored: number; cells: PreviewCell[] }> {
  const out = await scoreAllCells(env, asOf);
  if (!out) return { windows: null, cells_scored: 0, cells: [] };
  return {
    windows: out.w,
    cells_scored: out.candidates.length,
    cells: out.candidates
      .sort((a: Candidate, b: Candidate) => b.score - a.score)
      .slice(0, top)
      .map((c: Candidate) => ({
        cell_key: c.cell.cell_key,
        company: c.cell.company,
        product: c.cell.product,
        issue: c.cell.issue,
        window_n: c.cell.n,
        baseline_n: c.baseline.n,
        score: c.score,
        dominant: c.dominant,
        signals: c.signals,
      })),
  };
}

export async function runDetection(
  env: Env,
  asOf?: string | null,
): Promise<DetectionResult> {
  const runId = newId("det");
  const startedAt = nowIso();
  const w = await resolveWindows(env, asOf);
  if (!w) {
    return {
      run_id: runId,
      window_start: "",
      window_end: "",
      baseline_start: "",
      baseline_end: "",
      cells_examined: 0,
      cells_scored: 0,
      alerts_created: 0,
      alerts_updated: 0,
      alerts_stale: 0,
      status: "error",
      error: "no complaints ingested",
    };
  }

  await env.DB.prepare(
    `INSERT INTO detection_runs (id, started_at, window_start, window_end,
       baseline_start, baseline_end, status) VALUES (?1,?2,?3,?4,?5,?6,'running')`,
  )
    .bind(runId, startedAt, w.windowStart, w.windowEnd, w.baselineStart, w.baselineEnd)
    .run();

  const result: DetectionResult = {
    run_id: runId,
    window_start: w.windowStart,
    window_end: w.windowEnd,
    baseline_start: w.baselineStart,
    baseline_end: w.baselineEnd,
    cells_examined: 0,
    cells_scored: 0,
    alerts_created: 0,
    alerts_updated: 0,
    alerts_stale: 0,
    status: "ok",
  };


  try {
    const out = await scoreAllCells(env, asOf);
    if (!out) throw new Error("no complaints ingested");
    const {
      candidates: allCells,
      bCells,
      bMedian,
      mixByCell,
      companyTotalsB,
      marketB,
      marketTotalB,
    } = out;
    result.cells_examined = out.examined;
    result.cells_scored = allCells.length;
    const candidates = allCells.filter((c) => c.score >= DETECTION.alertThreshold);

    // Persist the baselines the run used, so an alert's score is reconstructible
    // later without recomputing anything.
    await persistBaselines(env, w, bCells, bMedian, mixByCell, companyTotalsB, marketB, marketTotalB);

    // Drivers: the complaints behind each alert, fetched only for cells that
    // actually produced one. D1 caps bound parameters at 100 per query, so the
    // IN list is chunked.
    const drivers = new Map<string, string[]>();
    const keys = candidates.map((c) => c.cell.cell_key);
    for (let i = 0; i < keys.length; i += 90) {
      const chunk = keys.slice(i, i + 90);
      const rows = await env.DB.prepare(
        qDrivers(chunk.length, ENRICH.maxPacketComplaints),
      )
        .bind(w.windowStart, w.windowEnd, ...chunk)
        .all<{ cell_key: string; complaint_id: string }>();
      for (const r of rows.results) {
        const list = drivers.get(r.cell_key) ?? [];
        list.push(r.complaint_id);
        drivers.set(r.cell_key, list);
      }
    }

    const at = nowIso();
    // The alerts table holds hundreds of rows, not millions, so reading its
    // keys up front is cheaper than trying to infer created-vs-updated from
    // D1's change counts, which report 1 for both an insert and a conflict
    // update.
    const existing = new Set(
      (
        await env.DB.prepare(`SELECT cell_key, signal_type FROM alerts`).all<{
          cell_key: string;
          signal_type: string;
        }>()
      ).results.map((r) => `${r.cell_key}|${r.signal_type}`),
    );

    const upsert = env.DB.prepare(`
INSERT INTO alerts (
  id, cell_key, company, product, issue, signal_type, score, status,
  window_start, window_end, baseline_start, baseline_end,
  window_n, window_narrative_n, baseline_n, signals_json,
  driver_complaint_ids_json, weights_version, first_seen_at, last_seen_at
) VALUES (?1,?2,?3,?4,?5,?6,?7,'open',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?18)
ON CONFLICT(cell_key, signal_type) DO UPDATE SET
  score = excluded.score,
  window_start = excluded.window_start,
  window_end = excluded.window_end,
  baseline_start = excluded.baseline_start,
  baseline_end = excluded.baseline_end,
  window_n = excluded.window_n,
  window_narrative_n = excluded.window_narrative_n,
  baseline_n = excluded.baseline_n,
  signals_json = excluded.signals_json,
  driver_complaint_ids_json = excluded.driver_complaint_ids_json,
  weights_version = excluded.weights_version,
  last_seen_at = excluded.last_seen_at,
  -- An alert that fires again on a later day is the same alert with a longer
  -- life, not a new one. Reopening a dispositioned alert would also destroy the
  -- label attached to it, so a dispositioned alert stays dispositioned.
  status = CASE WHEN alerts.status = 'dispositioned' THEN 'dispositioned' ELSE 'open' END`);

    for (const c of candidates) {
      if (existing.has(`${c.cell.cell_key}|${c.dominant}`)) result.alerts_updated++;
      else result.alerts_created++;
    }

    for (let i = 0; i < candidates.length; i += 50) {
      const chunk = candidates.slice(i, i + 50);
      await env.DB.batch(
        chunk.map((c) =>
          upsert.bind(
            newId("alt"),
            c.cell.cell_key,
            c.cell.company,
            c.cell.product,
            c.cell.issue,
            c.dominant,
            c.score,
            w.windowStart,
            w.windowEnd,
            w.baselineStart,
            w.baselineEnd,
            c.cell.n,
            c.cell.n_narrative,
            c.baseline.n,
            JSON.stringify(c.signals),
            JSON.stringify(drivers.get(c.cell.cell_key) ?? []),
            WEIGHTS_VERSION,
            at,
          ),
        ),
      );
    }

    // Anything open that this run did not re-fire has gone quiet.
    const stale = await env.DB.prepare(
      `UPDATE alerts SET status='stale' WHERE status='open' AND last_seen_at < ?1`,
    )
      .bind(at)
      .run();
    result.alerts_stale = stale.meta?.changes ?? 0;
  } catch (e) {
    result.status = "error";
    result.error = e instanceof Error ? e.message : String(e);
  }

  await env.DB.prepare(
    `UPDATE detection_runs SET finished_at=?2, cells_examined=?3, cells_scored=?4,
       alerts_created=?5, alerts_updated=?6, status=?7, error=?8 WHERE id=?1`,
  )
    .bind(
      runId,
      nowIso(),
      result.cells_examined,
      result.cells_scored,
      result.alerts_created,
      result.alerts_updated,
      result.status,
      result.error ?? null,
    )
    .run();

  return result;
}

async function persistBaselines(
  env: Env,
  w: Windows,
  bCells: Map<string, CellAgg>,
  bMedian: Map<string, Row>,
  mixByCell: Map<string, Record<string, number>>,
  companyTotalsB: Map<string, Row>,
  marketB: Map<string, number>,
  marketTotalB: number,
): Promise<void> {
  const at = nowIso();
  const days = daysBetween(w.baselineStart, w.baselineEnd);
  const stmt = env.DB.prepare(`
INSERT INTO baselines (cell_key, company, product, issue, window_start, window_end,
  n, mean_daily, stddev_daily, median_response_days, untimely_share, adverse_share,
  top_state, top_state_share, issue_share, market_issue_share, response_mix_json, computed_at)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
ON CONFLICT(cell_key, window_start, window_end) DO UPDATE SET
  n=excluded.n, mean_daily=excluded.mean_daily, stddev_daily=excluded.stddev_daily,
  median_response_days=excluded.median_response_days, untimely_share=excluded.untimely_share,
  adverse_share=excluded.adverse_share, issue_share=excluded.issue_share,
  market_issue_share=excluded.market_issue_share, response_mix_json=excluded.response_mix_json,
  computed_at=excluded.computed_at`);

  const all = [...bCells.values()];
  for (let i = 0; i < all.length; i += 50) {
    const chunk = all.slice(i, i + 50);
    await env.DB.batch(
      chunk.map((c) => {
        const mean = c.n / days;
        const stddev = Math.sqrt(Math.max(0, c.sumsq / days - mean * mean));
        const compB = Number(companyTotalsB.get(c.company)?.n ?? 0);
        return stmt.bind(
          c.cell_key,
          c.company,
          c.product,
          c.issue,
          w.baselineStart,
          w.baselineEnd,
          c.n,
          round(mean, 4),
          round(stddev, 4),
          bMedian.get(c.cell_key)?.median_response_days != null
            ? round(Number(bMedian.get(c.cell_key)!.median_response_days), 3)
            : null,
          c.n_settled > 0 ? round(c.n_untimely / c.n_settled, 4) : null,
          c.n_settled > 0 ? round(c.n_adverse / c.n_settled, 4) : null,
          null,
          null,
          compB > 0 ? round(c.n / compB, 5) : null,
          marketTotalB > 0
            ? round((marketB.get(`${c.product}|${c.issue}`) ?? 0) / marketTotalB, 5)
            : null,
          JSON.stringify(mixByCell.get(c.cell_key) ?? {}),
          at,
        );
      }),
    );
  }
}

interface Candidate {
  cell: CellAgg;
  baseline: CellAgg;
  score: number;
  dominant: string;
  signals: SignalDetail[];
  ctx: CellContext;
}

interface ScoredRun {
  w: Windows;
  examined: number;
  candidates: Candidate[];
  bCells: Map<string, CellAgg>;
  bMedian: Map<string, Record<string, unknown>>;
  mixByCell: Map<string, Record<string, number>>;
  companyTotalsB: Map<string, Record<string, unknown>>;
  marketB: Map<string, number>;
  marketTotalB: number;
}

/**
 * Aggregate, then score every cell that clears the volume floors. Returns the
 * full ranking with no threshold applied, so the same code path serves both a
 * real detection run and a dry-run preview of the score distribution.
 */
async function scoreAllCells(env: Env, asOf?: string | null): Promise<ScoredRun | null> {
  const w = await resolveWindows(env, asOf);
  if (!w) return null;
  let examined = 0;
  let scored_count = 0;

  // One batch, twelve aggregates. D1 does all the work; the Worker only ever
  // sees a few hundred pre-aggregated rows.
  const wArgs = [w.windowStart, w.windowEnd] as const;
  const bArgs = [w.baselineStart, w.baselineEnd] as const;
  const res = await env.DB.batch([
    env.DB.prepare(Q_CELL_AGG).bind(...wArgs, DETECTION.minWindowVolume),
    env.DB.prepare(Q_CELL_AGG).bind(...bArgs, DETECTION.minBaselineVolume),
    env.DB.prepare(Q_MEDIAN_RESPONSE).bind(...wArgs),
    env.DB.prepare(Q_MEDIAN_RESPONSE).bind(...bArgs),
    env.DB.prepare(Q_TOP_STATE).bind(...wArgs),
    env.DB.prepare(Q_STATE_SHARES).bind(...bArgs),
    env.DB.prepare(Q_COMPANY_TOTALS).bind(...wArgs),
    env.DB.prepare(Q_COMPANY_TOTALS).bind(...bArgs),
    env.DB.prepare(Q_MARKET_ISSUE).bind(...wArgs),
    env.DB.prepare(Q_MARKET_ISSUE).bind(...bArgs),
    env.DB.prepare(Q_RESPONSE_MIX).bind(...wArgs),
  ]);

  const wCells = res[0].results as unknown as CellAgg[];
  const bCells = index(res[1].results as unknown as CellAgg[], "cell_key");
  const wMedian = index(res[2].results as Row[], "cell_key");
  const bMedian = index(res[3].results as Row[], "cell_key");
  const wTopState = index(res[4].results as Row[], "cell_key");

  const bStateShare = new Map<string, number>();
  for (const r of res[5].results as Row[]) {
    bStateShare.set(
      `${r.cell_key}|${r.state}`,
      Number(r.c) / Math.max(1, Number(r.total)),
    );
  }

  const companyTotalsW = index(res[6].results as Row[], "company");
  const companyTotalsB = index(res[7].results as Row[], "company");

  const marketW = new Map<string, number>();
  let marketTotalW = 0;
  for (const r of res[8].results as Row[]) {
    marketW.set(`${r.product}|${r.issue}`, Number(r.n));
    marketTotalW += Number(r.n);
  }
  const marketB = new Map<string, number>();
  let marketTotalB = 0;
  for (const r of res[9].results as Row[]) {
    marketB.set(`${r.product}|${r.issue}`, Number(r.n));
    marketTotalB += Number(r.n);
  }

  const mixByCell = new Map<string, Record<string, number>>();
  for (const r of res[10].results as Row[]) {
    const k = String(r.cell_key);
    const m = mixByCell.get(k) ?? {};
    m[String(r.response ?? "unknown")] = Number(r.c);
    mixByCell.set(k, m);
  }

  const windowDays = daysBetween(w.windowStart, w.windowEnd);
  const baselineDays = daysBetween(w.baselineStart, w.baselineEnd);

  const candidates: Candidate[] = [];

  for (const cell of wCells) {
    examined++;
    const baseline = bCells.get(cell.cell_key);
    // Cells below the minimum baseline volume are excluded, not scored. A
    // cell moving from 1 complaint to 4 carries a huge z-score and no
    // information whatsoever.
    if (!baseline || baseline.n < DETECTION.minBaselineVolume) continue;
    scored_count++;

    const topStateRow = wTopState.get(cell.cell_key);
    const topState = topStateRow
      ? {
          state: String(topStateRow.state),
          share: Number(topStateRow.c) / Math.max(1, Number(topStateRow.total)),
        }
      : null;

    const compW = Number(companyTotalsW.get(cell.company)?.n ?? 0);
    const compB = Number(companyTotalsB.get(cell.company)?.n ?? 0);
    const piKey = `${cell.product}|${cell.issue}`;

    const ctx: CellContext = {
      windowDays,
      baselineDays,
      window: cell,
      baseline,
      windowMedianResponse:
        wMedian.get(cell.cell_key)?.median_response_days != null
          ? Number(wMedian.get(cell.cell_key)!.median_response_days)
          : null,
      baselineMedianResponse:
        bMedian.get(cell.cell_key)?.median_response_days != null
          ? Number(bMedian.get(cell.cell_key)!.median_response_days)
          : null,
      windowTopState: topState,
      baselineStateShare: topState
        ? (bStateShare.get(`${cell.cell_key}|${topState.state}`) ?? null)
        : null,
      windowIssueShare: compW > 0 ? cell.n / compW : 0,
      baselineIssueShare: compB > 0 ? baseline.n / compB : 0,
      windowMarketShare:
        marketTotalW > 0 ? (marketW.get(piKey) ?? 0) / marketTotalW : 0,
      baselineMarketShare:
        marketTotalB > 0 ? (marketB.get(piKey) ?? 0) / marketTotalB : 0,
    };

    const signals = computeSignals(ctx);
    const scored = scoreCell(signals);
    candidates.push({
      cell,
      baseline,
      score: scored.score,
      dominant: scored.dominant,
      signals: scored.signals,
      ctx,
    });
  }


  return {
    w,
    examined,
    candidates,
    bCells,
    bMedian,
    mixByCell,
    companyTotalsB,
    marketB,
    marketTotalB,
  };
}
