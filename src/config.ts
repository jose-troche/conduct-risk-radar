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
    "Mortgage",
    "Vehicle loan or lease",
    "Student loan",
    "Payday loan, title loan, personal loan, or advance loan",
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
    "Chime Financial Inc",
    "U.S. BANCORP",
    "TRUIST FINANCIAL CORPORATION",
    "AMERICAN EXPRESS COMPANY",
    "DISCOVER BANK",
    "ALLY FINANCIAL INC.",
    "NAVY FEDERAL CREDIT UNION",
    "GOLDMAN SACHS BANK USA",
    "Bread Financial Holdings, Inc.",
    "TD BANK US HOLDING COMPANY",
    "PNC Bank N.A.",
    "BARCLAYS BANK DELAWARE",
    "SOFI TECHNOLOGIES, INC.",
    "SANTANDER HOLDINGS USA, INC.",
    "Rocket Mortgage, LLC",
    "MOHELA",
    "Nelnet, Inc.",
    "Affirm Holdings, Inc",
  ],
  /**
   * Rolling window, in days, that the system keeps ingested.
   *
   * Long enough to hold the detection window, its 60-day baseline, AND the
   * publication lag documented on DETECTION.publicationLagDays. 160 days is
   * roughly 100k rows at ~120 MB, comfortably inside D1's 500 MB free tier.
   */
  windowDays: 160,
} as const;

export const INGEST = {
  apiBase:
    "https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/",
  /**
   * Records per request.
   *
   * The CFPB search API ignores an offset parameter entirely - it paginates via
   * opaque break-points in the response _meta, not via frm/from - so the only
   * reliable way to read a slice whole is to ask for more records than it
   * contains. A day of the scope runs around 360 complaints and peaks near 550,
   * so 1000 reads a day in one request with room to spare, and the ingester
   * verifies the returned count against the reported total rather than assuming
   * it fitted.
   */
  pageSize: 1000,
  /** Hard stop on requests per invocation, well under the free-tier 50 subrequests. */
  maxRequestsPerInvocation: 8,
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
  /**
   * How far back the detection window ends, in days before today.
   *
   * This is the single most consequential number in the system, and it is not a
   * guess. The CFPB publishes a complaint long before that complaint's record
   * is complete, and the three things detection depends on mature at three
   * different rates. Measured over the ingested scope:
   *
   *   weeks ago   complaints/day   settled %   with narrative %
   *      0              18            23             0
   *      1             126            63             0
   *      2             429            53             0
   *      4             383            72             0
   *      6             408            83            10
   *      8             416            96            24
   *     10             417            99            42
   *     12             256           100            45
   *
   * Volume is complete after about two weeks. Company responses settle after
   * about eight. Narratives - which only exist where the consumer consented to
   * publication - do not reach their plateau until about ten weeks.
   *
   * Running detection on fresh data would therefore read the publication lag as
   * a collapse in volume, read half-settled complaints as a drift in the
   * response mix, and hand the model an evidence packet with no narratives in
   * it at all. All three were observed before this constant existed.
   *
   * So the system is retrospective by construction: it analyses a window that
   * ended ten weeks ago, because that is when the data is actually there. The
   * cost is stated plainly rather than hidden - this is not a near-real-time
   * monitor, and it cannot be one on this source.
   */
  publicationLagDays: 70,
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
  minWindowVolume: 15,
  /**
   * Share-based signals (timeliness, response mix) need their own floor, and it
   * has to be higher than a bare volume floor. A cell with six settled
   * complaints can read 100% closed-without-relief and saturate the signal on
   * what is really one or two extra cases. Small-n wrecks a proportion faster
   * than it wrecks a count.
   */
  minShareDenominator: 20,
  /**
   * Alerts below this score are not persisted.
   *
   * Set against the observed distribution rather than picked as a round
   * number. Over 128 scored cells the score runs median 11.7, p75 20.9,
   * p90 34.8, max 58.3, so a floor of 20 admits roughly the top quarter -
   * a queue of about 36 alerts, which is a plausible amount of work rather
   * than a wall of noise.
   */
  alertThreshold: 20,
  /**
   * Enrichment only runs at or above this score. Higher than the queue floor
   * on purpose: the deterministic alert is what has to stand up, and model
   * budget is spent only on the part of the queue where a drafted rationale
   * would actually save an analyst time.
   */
  enrichThreshold: 25,
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
 * Saturation points for normalising each raw signal onto 0-100. A raw value at
 * or beyond the saturation point scores 100.
 *
 * These are calibrated, not invented: each is set near the 95th percentile of
 * that signal's observed positive values across all scored cells, so a signal
 * sitting at its historical extreme scores near 100 and the 0-100 range is
 * actually used. Measured over the ingested scope (92 cells, 14-day window
 * against a 60-day baseline):
 *
 *   signal                      cells > 0    p50     p90     p95     max
 *   volume_anomaly (z)              50       1.07    2.57    3.29    3.64
 *   timeliness_drift (pp)            5       0.021   0.144   0.144   0.144
 *   response_mix_drift (pp)         34       0.057   0.125   0.174   0.202
 *   geo_concentration (pp)          74       0.062   0.171   0.185   0.267
 *   emerging_issue (pp)             54       0.008   0.021   0.038   0.193
 *
 * Calibrating to the data is still a design choice, not a fitted result -
 * nothing here was optimised against an outcome, because there is no outcome
 * label in this data to optimise against. It just means the scale matches the
 * distribution it has to rank, rather than compressing every real anomaly into
 * the bottom fifth of the range, which is what the first uncalibrated pass did.
 */
export const SATURATION = {
  /** Standard errors between the window's daily rate and the baseline's. */
  volume_z: 3.5,
  /** Proportional increase in days-to-company. 1.0 = a doubling. */
  response_time_ratio: 1.0,
  /** Percentage-point rise in the untimely share. Untimely is rare: 0.5% base. */
  untimely_pp: 0.1,
  /** Percentage-point rise in the share closed without relief. */
  adverse_pp: 0.18,
  /** Percentage-point rise in the top state's share of the cell. */
  geo_pp: 0.2,
  /** Percentage-point rise in issue share, in excess of the market-wide move. */
  emerging_pp: 0.06,
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
