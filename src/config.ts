/**
 * Every tunable in the system lives here. Weights are a stated design choice,
 * not a fitted result: nothing in this repo learned them from data, and the
 * README says so. Changing them should bump WEIGHTS_VERSION so that alerts
 * scored under different weights are never silently compared.
 */

export const WEIGHTS_VERSION = "w1";
export const PROMPT_VERSION = "p1";

/**
 * Ingestion scope. A rolling window over a handful of products and institutions
 * — not the full database. D1's free tier (500 MB, 100k row writes/day) makes
 * full ingestion impossible; the honest answer is to design around it and write
 * the limit down rather than pretend to coverage we do not have.
 *
 * Credit reporting is deliberately excluded: it is 93% of the database by volume
 * and is dominated by three bureaus, so including it would drown every other
 * cell and turn the queue into a credit-bureau monitor.
 */
export const SCOPE = {
  products: [
    "Credit card",
    "Checking or savings account",
    "Money transfer, virtual currency, or money service",
    "Prepaid card",
  ],
  companies: [
    "CAPITAL ONE FINANCIAL CORPORATION",
    "JPMORGAN CHASE & CO.",
    "BANK OF AMERICA, NATIONAL ASSOCIATION",
    "CITIBANK, N.A.",
    "WELLS FARGO & COMPANY",
    "SYNCHRONY FINANCIAL",
    "Block, Inc.",
    "Paypal Holdings, Inc",
    "U.S. BANCORP",
    "TRUIST FINANCIAL CORPORATION",
    "AMERICAN EXPRESS COMPANY",
    "DISCOVER BANK",
    "ALLY FINANCIAL INC.",
    "NAVY FEDERAL CREDIT UNION",
  ],
  /** Rolling window, in days, that the system keeps ingested. */
  windowDays: 90,
} as const;

export const INGEST = {
  apiBase:
    "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/",
  /**
   * Records per API page. Deliberately small: the Workers free tier allows 10ms
   * of CPU per invocation, and JSON.parse of a full 1000-record page alone can
   * exceed that. 250 keeps parse + bind comfortably inside the budget.
   */
  pageSize: 250,
  /** Hard stop on pages per invocation, well under the free-tier 50 subrequests. */
  maxPagesPerInvocation: 8,
  /**
   * KV TTLs for raw API pages.
   *
   * The CFPB refreshes the public database once daily, so anything under 24h
   * buys nothing and burns quota. But the source is not append-only — it
   * backfills narratives and amends company_response for weeks after a
   * complaint is filed (a complaint filed today reads "In progress" and gains
   * its narrative months later). So recent days must be re-fetched daily while
   * older days can be cached hard.
   */
  freshTtlSeconds: 24 * 60 * 60, // days inside the amendment horizon
  staleTtlSeconds: 30 * 24 * 60 * 60, // days that have settled
  /** Days back from today that the source still meaningfully amends. */
  amendmentHorizonDays: 45,
  /** Days of recent data the cron re-checks on every run. */
  cronRefreshDays: 3,
  /** Days of backfill the cron advances per run. */
  cronBackfillDays: 3,
} as const;

export const DETECTION = {
  /** Length of the window being tested for an anomaly. */
  detectionWindowDays: 14,
  /** Trailing baseline, ending where the detection window begins. */
  baselineWindowDays: 60,
  /**
   * Cells below this baseline volume are excluded, not scored. A cell going
   * from 1 complaint to 4 carries a large z-score and means nothing.
   */
  minBaselineVolume: 20,
  /** A cell must also have this many complaints in the detection window. */
  minWindowVolume: 5,
  /** Alerts below this score are not persisted. */
  alertThreshold: 35,
  /** Enrichment only runs at or above this score. */
  enrichThreshold: 45,
  /**
   * Company responses that mean the complaint has reached a final state.
   * Signals about timeliness and response mix are computed over settled
   * complaints only — recent complaints are disproportionately "In progress",
   * and comparing a fresh window against a settled baseline would manufacture
   * a drift signal out of nothing but the age of the data.
   */
  settledResponses: [
    "Closed with explanation",
    "Closed with monetary relief",
    "Closed with non-monetary relief",
    "Closed without relief",
    "Closed with relief",
    "Closed",
    "Untimely response",
  ],
  /** Settled responses that gave the consumer nothing. */
  adverseResponses: [
    "Closed with explanation",
    "Closed without relief",
    "Closed",
    "Untimely response",
  ],
} as const;

export type SignalType =
  | "volume_anomaly"
  | "response_time_degradation"
  | "timeliness_drift"
  | "response_mix_drift"
  | "geo_concentration"
  | "emerging_issue";

/**
 * Weights sum to 1.0, so the alert score is directly readable as 0–100.
 *
 * Rationale, stated rather than fitted: volume is the signal with the least
 * ambiguous interpretation and the largest sample behind it, so it carries the
 * most weight. Emerging-issue is next because it is the only signal that
 * separates "this firm has a new problem" from "the whole market has this
 * problem". The handling signals (timeliness, response mix, response time)
 * describe how a firm reacts rather than what consumers report, so they are
 * secondary. Geographic concentration is weighted lowest: it is the noisiest
 * of the six and the easiest to trip on a single state's small denominator.
 */
export const WEIGHTS: Record<SignalType, number> = {
  volume_anomaly: 0.35,
  emerging_issue: 0.2,
  timeliness_drift: 0.15,
  response_mix_drift: 0.12,
  response_time_degradation: 0.1,
  geo_concentration: 0.08,
};

/**
 * Saturation points for normalising each raw signal onto 0–100. A raw value at
 * or beyond the saturation point scores 100. These are judgement calls about
 * what "as bad as it gets" looks like, and are as much a design choice as the
 * weights.
 */
export const SATURATION = {
  /** z-score of the window's daily rate against the baseline. */
  volume_z: 4,
  /** Proportional increase in median days-to-company. 1.0 = a doubling. */
  response_time_ratio: 1.0,
  /** Percentage-point rise in the untimely share. */
  untimely_pp: 0.2,
  /** Percentage-point rise in the share closed without relief. */
  adverse_pp: 0.2,
  /** Percentage-point rise in the top state's share of the cell. */
  geo_pp: 0.25,
  /** Percentage-point rise in issue share, in excess of the market-wide move. */
  emerging_pp: 0.15,
} as const;

export const SIGNAL_LABELS: Record<SignalType, string> = {
  volume_anomaly: "Volume anomaly",
  response_time_degradation: "Response-time degradation",
  timeliness_drift: "Timeliness drift",
  response_mix_drift: "Response-mix drift",
  geo_concentration: "Geographic clustering",
  emerging_issue: "Emerging issue",
};

export const ENRICH = {
  /** Hard cap on complaints handed to the model. Nothing else is in scope. */
  maxPacketComplaints: 15,
  /** Characters of narrative per complaint. Truncation is marked in the packet. */
  maxNarrativeChars: 1400,
  /** Alerts per enrichment batch invocation; stays under 50 subrequests. */
  maxBatchSize: 10,
} as const;

export interface Variant {
  id: string;
  label: string;
  /** "workers-ai" runs on the Workers AI binding; "anthropic" is the BYOK tier. */
  provider: "workers-ai" | "anthropic";
  model: string;
  promptStyle: "structured" | "terse";
  /** USD per million tokens, used to price a run. */
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  description: string;
}

/**
 * Variants under comparison. The Workers AI path is the default and is what the
 * deployed system runs on; the Anthropic path is the BYOK frontier comparison
 * and is skipped when no API key is bound.
 */
export const VARIANTS: Variant[] = [
  {
    id: "v1-workers-ai",
    label: "Workers AI · Llama 3.3 70B · structured prompt",
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    promptStyle: "structured",
    inputCostPerMTok: 0.29,
    outputCostPerMTok: 2.25,
    description:
      "Default path. Full structured prompt with the evidence packet rendered as labelled sections.",
  },
  {
    id: "v2-workers-ai-terse",
    label: "Workers AI · Llama 3.3 70B · terse prompt",
    provider: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    promptStyle: "terse",
    inputCostPerMTok: 0.29,
    outputCostPerMTok: 2.25,
    description:
      "Same model, compressed prompt. Isolates how much of the quality comes from prompt scaffolding rather than the model.",
  },
  {
    id: "v3-anthropic",
    label: "Anthropic · Claude Haiku 4.5 · structured prompt",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    promptStyle: "structured",
    inputCostPerMTok: 1.0,
    outputCostPerMTok: 5.0,
    description:
      "BYOK frontier comparison. Skipped when ANTHROPIC_API_KEY is not bound.",
  },
];

export const DEFAULT_VARIANT_ID = "v1-workers-ai";

/**
 * The ship gate. A variant ships only if it clears the floor in EVERY segment.
 * A variant that lifts the mean while collapsing on one product is a
 * regression, and averaging is exactly how you fail to notice.
 */
export const EVAL_GATE = {
  /** Minimum exact-match severity agreement, per segment. */
  minExactAgreement: 0.5,
  /** Minimum exact-or-adjacent agreement, per segment. */
  minAdjacentAgreement: 0.85,
  /** Maximum citation-validation failure rate, per segment. */
  maxValidationFailure: 0.1,
  /** Segments smaller than this are reported but not gated — too few labels. */
  minSegmentSize: 3,
} as const;

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];
