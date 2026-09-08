import {
  DETECTION,
  SATURATION,
  SIGNAL_LABELS,
  WEIGHTS,
  type SignalType,
} from "../config";
import type { SignalDetail } from "../types";
import { normalise, pct, round, zScore } from "../lib/stats";
import type { CellAgg } from "./queries";

export interface CellContext {
  windowDays: number;
  baselineDays: number;
  window: CellAgg;
  baseline: CellAgg;
  windowMedianResponse: number | null;
  baselineMedianResponse: number | null;
  windowTopState: { state: string; share: number } | null;
  baselineStateShare: number | null;
  /** This cell's share of its company's total volume. */
  windowIssueShare: number;
  baselineIssueShare: number;
  /** The same (product, issue) pair's share of the whole market. */
  windowMarketShare: number;
  baselineMarketShare: number;
}

function detail(
  type: SignalType,
  raw: number | null,
  windowValue: string,
  baselineValue: string,
  normalized: number,
  note?: string,
): SignalDetail {
  const weight = WEIGHTS[type];
  return {
    type,
    label: SIGNAL_LABELS[type],
    raw: raw === null ? null : round(raw, 4),
    window_value: windowValue,
    baseline_value: baselineValue,
    normalized: round(normalized),
    weight,
    contribution: round(normalized * weight),
    ...(note ? { note } : {}),
  };
}

/**
 * Daily mean and standard deviation from the per-cell sum and sum-of-squares,
 * divided by the full window length so that zero-complaint days count.
 */
function dailyStats(agg: CellAgg, days: number) {
  const mean = agg.n / days;
  const variance = Math.max(0, agg.sumsq / days - mean * mean);
  return { mean, stddev: Math.sqrt(variance) };
}

export function computeSignals(ctx: CellContext): SignalDetail[] {
  const out: SignalDetail[] = [];
  const b = dailyStats(ctx.baseline, ctx.baselineDays);
  const windowRate = ctx.window.n / ctx.windowDays;

  // --- Volume anomaly -------------------------------------------------------
  const z = zScore(windowRate, b.mean, b.stddev, ctx.windowDays);
  out.push(
    detail(
      "volume_anomaly",
      z,
      `${round(windowRate, 2)}/day (${ctx.window.n} in ${ctx.windowDays}d)`,
      `${round(b.mean, 2)}/day (sd ${round(b.stddev, 2)}, n=${ctx.baseline.n})`,
      normalise(z, SATURATION.volume_z),
    ),
  );

  // --- Response-time degradation -------------------------------------------
  //
  // The spec asks for a median, and the median is what is reported. But the
  // CFPB routes 93.6% of complaints to the company on the day it receives them,
  // so the median days-to-company is 0 in almost every cell, in almost every
  // window - a median of 0 against a baseline of 0 is inert, and this signal
  // spent its whole weight contributing nothing.
  //
  // The tail is where the movement actually is, so when both medians are zero
  // the comparison falls back to the mean, which does move. The reported values
  // say which statistic was used, because a signal that quietly switched
  // definitions would be worse than one that did nothing.
  const wm = ctx.windowMedianResponse;
  const bm = ctx.baselineMedianResponse;
  const wMean = ctx.window.rd_n > 0 ? ctx.window.rd_sum / ctx.window.rd_n : null;
  const bMean = ctx.baseline.rd_n > 0 ? ctx.baseline.rd_sum / ctx.baseline.rd_n : null;

  if (wm === null || bm === null) {
    out.push(
      detail(
        "response_time_degradation",
        null,
        wm === null ? "no data" : `${round(wm, 1)}d`,
        bm === null ? "no data" : `${round(bm, 1)}d`,
        0,
        "No dates sent to company recorded in one of the periods.",
      ),
    );
  } else if (wm === 0 && bm === 0 && wMean !== null && bMean !== null) {
    const ratio = (wMean - bMean) / Math.max(bMean, 0.05);
    out.push(
      detail(
        "response_time_degradation",
        ratio,
        `${round(wMean, 2)}d mean`,
        `${round(bMean, 2)}d mean`,
        normalise(ratio, SATURATION.response_time_ratio),
        "Median is 0 in both periods - this source routes same-day - so the mean is compared instead.",
      ),
    );
  } else {
    // Proportional, not absolute: one extra day matters far more against a
    // same-day baseline than against a two-week one.
    const ratio = (wm - bm) / Math.max(bm, 0.5);
    out.push(
      detail(
        "response_time_degradation",
        ratio,
        `${round(wm, 1)}d median`,
        `${round(bm, 1)}d median`,
        normalise(ratio, SATURATION.response_time_ratio),
      ),
    );
  }

  // --- Timeliness drift -----------------------------------------------------
  // Computed over settled complaints only. Recent complaints are
  // disproportionately still "In progress", and comparing a half-settled window
  // against a fully-settled baseline manufactures drift out of nothing but the
  // age of the data.
  const wShareDen = ctx.window.n_settled;
  const bShareDen = ctx.baseline.n_settled;
  if (
    wShareDen < DETECTION.minShareDenominator ||
    bShareDen < DETECTION.minShareDenominator
  ) {
    out.push(
      detail(
        "timeliness_drift",
        null,
        `${wShareDen} settled`,
        `${bShareDen} settled`,
        0,
        "Too few settled complaints to compare timeliness.",
      ),
    );
  } else {
    const wUntimely = ctx.window.n_untimely / wShareDen;
    const bUntimely = ctx.baseline.n_untimely / bShareDen;
    const delta = wUntimely - bUntimely;
    out.push(
      detail(
        "timeliness_drift",
        delta,
        `${pct(wUntimely)} untimely (${ctx.window.n_untimely}/${wShareDen})`,
        `${pct(bUntimely)} untimely (${ctx.baseline.n_untimely}/${bShareDen})`,
        normalise(delta, SATURATION.untimely_pp),
      ),
    );
  }

  // --- Response-mix drift ---------------------------------------------------
  if (
    wShareDen < DETECTION.minShareDenominator ||
    bShareDen < DETECTION.minShareDenominator
  ) {
    out.push(
      detail(
        "response_mix_drift",
        null,
        `${wShareDen} settled`,
        `${bShareDen} settled`,
        0,
        "Too few settled complaints to compare the response mix.",
      ),
    );
  } else {
    const wAdverse = ctx.window.n_adverse / wShareDen;
    const bAdverse = ctx.baseline.n_adverse / bShareDen;
    const delta = wAdverse - bAdverse;
    out.push(
      detail(
        "response_mix_drift",
        delta,
        `${pct(wAdverse)} closed without relief`,
        `${pct(bAdverse)} closed without relief`,
        normalise(delta, SATURATION.adverse_pp),
      ),
    );
  }

  // --- Geographic clustering ------------------------------------------------
  const top = ctx.windowTopState;
  if (!top) {
    out.push(
      detail("geo_concentration", null, "no state data", "no state data", 0),
    );
  } else {
    const baseShare = ctx.baselineStateShare ?? 0;
    const delta = top.share - baseShare;
    out.push(
      detail(
        "geo_concentration",
        delta,
        `${top.state} ${pct(top.share)} of window`,
        ctx.baselineStateShare === null
          ? `${top.state} outside baseline top 8`
          : `${top.state} ${pct(baseShare)} of baseline`,
        normalise(delta, SATURATION.geo_pp),
      ),
    );
  }

  // --- Emerging issue -------------------------------------------------------
  // The company's own move in this issue's share, minus the move the whole
  // market made in the same issue. Subtracting the market is the entire point:
  // without it, a sector-wide seasonal shift lights up every company at once.
  const companyDelta = ctx.windowIssueShare - ctx.baselineIssueShare;
  const marketDelta = ctx.windowMarketShare - ctx.baselineMarketShare;
  const excess = companyDelta - marketDelta;
  out.push(
    detail(
      "emerging_issue",
      excess,
      `${pct(ctx.windowIssueShare)} of company volume`,
      `${pct(ctx.baselineIssueShare)} of company volume (market moved ${
        marketDelta >= 0 ? "+" : ""
      }${pct(marketDelta)})`,
      normalise(excess, SATURATION.emerging_pp),
    ),
  );

  return out;
}

export interface ScoredCell {
  score: number;
  dominant: SignalType;
  signals: SignalDetail[];
}

/** Weighted sum of the normalised signals. Weights sum to 1, so the score reads
 *  directly as 0-100. It is a triage priority: it ranks what to look at first,
 *  and it estimates the probability of nothing. */
export function scoreCell(signals: SignalDetail[]): ScoredCell {
  let score = 0;
  let dominant = signals[0];
  for (const s of signals) {
    score += s.contribution;
    if (s.contribution > dominant.contribution) dominant = s;
  }
  return { score: round(score), dominant: dominant.type, signals };
}
