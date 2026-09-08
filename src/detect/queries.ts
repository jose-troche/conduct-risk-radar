/**
 * Every figure detection needs is computed by D1, not by the Worker.
 *
 * This is not a style preference. The Workers free tier allows 10ms of CPU per
 * invocation, which is nowhere near enough to stream tens of thousands of
 * complaint rows through JavaScript. So each query below returns at most a few
 * hundred pre-aggregated rows, and the Worker only does arithmetic on those.
 */

export interface CellAgg {
  cell_key: string;
  company: string;
  product: string;
  issue: string;
  n: number;
  sumsq: number;
  n_narrative: number;
  n_settled: number;
  n_untimely: number;
  n_adverse: number;
  rd_sum: number;
  rd_n: number;
}

/**
 * Per-cell volume and handling aggregates for a window.
 *
 * The inner query collapses to one row per (cell, day) so that SUM(c*c) gives
 * the sum of squared daily counts. Days on which a cell saw nothing contribute
 * zero to both sums, so dividing by the window length - not by the number of
 * active days - yields the correct mean and variance. Counting only active days
 * would overstate the baseline mean for sparse cells and suppress real spikes.
 */
export const Q_CELL_AGG = `
SELECT cell_key,
       MAX(company)  AS company,
       MAX(product)  AS product,
       MAX(issue)    AS issue,
       SUM(c)        AS n,
       SUM(c * c)    AS sumsq,
       SUM(nn)       AS n_narrative,
       SUM(ns)       AS n_settled,
       SUM(nu)       AS n_untimely,
       SUM(na)       AS n_adverse,
       SUM(rds)      AS rd_sum,
       SUM(rdn)      AS rd_n
FROM (
  SELECT cell_key,
         MAX(company) AS company,
         MAX(product) AS product,
         MAX(issue)   AS issue,
         COUNT(*)     AS c,
         SUM(has_narrative) AS nn,
         SUM(settled)       AS ns,
         SUM(CASE WHEN settled = 1 AND timely_response = 0 THEN 1 ELSE 0 END) AS nu,
         SUM(CASE WHEN settled = 1 AND adverse = 1 THEN 1 ELSE 0 END)         AS na,
         SUM(COALESCE(response_days, 0))                                      AS rds,
         SUM(CASE WHEN response_days IS NOT NULL THEN 1 ELSE 0 END)           AS rdn
  FROM complaints
  WHERE date_received >= ?1 AND date_received < ?2
  GROUP BY cell_key, date_received
)
GROUP BY cell_key
HAVING SUM(c) >= ?3`;

/**
 * Median days from receipt to the company, per cell.
 *
 * SQLite has no median aggregate. The window-function form below picks the
 * middle one or two ordered rows per cell and averages them, which is the
 * textbook median for both odd and even counts.
 */
export const Q_MEDIAN_RESPONSE = `
SELECT cell_key, AVG(response_days) AS median_response_days
FROM (
  SELECT cell_key, response_days,
         ROW_NUMBER() OVER (PARTITION BY cell_key ORDER BY response_days) AS rn,
         COUNT(*)     OVER (PARTITION BY cell_key)                        AS cnt
  FROM complaints
  WHERE date_received >= ?1 AND date_received < ?2 AND response_days IS NOT NULL
)
WHERE rn IN ((cnt + 1) / 2, (cnt + 2) / 2)
GROUP BY cell_key`;

/** The single most concentrated state per cell in the window. */
export const Q_TOP_STATE = `
SELECT cell_key, state, c, total
FROM (
  SELECT cell_key, state, COUNT(*) AS c,
         SUM(COUNT(*)) OVER (PARTITION BY cell_key) AS total,
         ROW_NUMBER()  OVER (PARTITION BY cell_key ORDER BY COUNT(*) DESC) AS rn
  FROM complaints
  WHERE date_received >= ?1 AND date_received < ?2 AND state IS NOT NULL
  GROUP BY cell_key, state
)
WHERE rn = 1`;

/**
 * Baseline state shares, top 8 per cell.
 *
 * Capped so the result stays small. If the window's leading state is not in a
 * cell's baseline top 8, its baseline share is treated as zero - which scores
 * the signal high. That is the right reading: a state that was not among a
 * cell's eight most common now leading it IS a concentration event.
 */
export const Q_STATE_SHARES = `
SELECT cell_key, state, c, total
FROM (
  SELECT cell_key, state, COUNT(*) AS c,
         SUM(COUNT(*)) OVER (PARTITION BY cell_key) AS total,
         ROW_NUMBER()  OVER (PARTITION BY cell_key ORDER BY COUNT(*) DESC) AS rn
  FROM complaints
  WHERE date_received >= ?1 AND date_received < ?2 AND state IS NOT NULL
  GROUP BY cell_key, state
)
WHERE rn <= 8`;

/** Total complaints per company in a window - the denominator for issue share. */
export const Q_COMPANY_TOTALS = `
SELECT company, COUNT(*) AS n
FROM complaints
WHERE date_received >= ?1 AND date_received < ?2
GROUP BY company`;

/**
 * Market-wide volume per (product, issue). This is what separates "this firm
 * has a new problem" from "every firm has this problem this month".
 */
export const Q_MARKET_ISSUE = `
SELECT product, issue, COUNT(*) AS n
FROM complaints
WHERE date_received >= ?1 AND date_received < ?2
GROUP BY product, issue`;

/** Distribution of company_response per cell, for the stored response mix. */
export const Q_RESPONSE_MIX = `
SELECT cell_key, company_response AS response, COUNT(*) AS c
FROM complaints
WHERE date_received >= ?1 AND date_received < ?2 AND settled = 1
GROUP BY cell_key, company_response`;

/**
 * The complaints driving an alert: most recent first, but narrative-bearing
 * ones ahead of silent ones, because a complaint with no narrative is evidence
 * of a count and nothing else.
 */
export function qDrivers(cellCount: number, limit: number): string {
  const placeholders = Array.from({ length: cellCount }, (_, i) => `?${i + 3}`).join(",");
  return `
SELECT cell_key, complaint_id, has_narrative
FROM (
  SELECT cell_key, complaint_id, has_narrative,
         ROW_NUMBER() OVER (
           PARTITION BY cell_key
           ORDER BY has_narrative DESC, date_received DESC, complaint_id DESC
         ) AS rn
  FROM complaints
  WHERE date_received >= ?1 AND date_received < ?2
    AND cell_key IN (${placeholders})
)
WHERE rn <= ${limit}`;
}
