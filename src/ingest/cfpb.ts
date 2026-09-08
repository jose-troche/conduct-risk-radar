import { INGEST, SCOPE, DETECTION } from "../config";
import type { NormalisedComplaint } from "../types";
import { toDay, daysBetween, today } from "../lib/time";

/**
 * The CFPB search API's response envelope does NOT use the field names printed
 * on the CSV export. Verified live against the API while building this mapper:
 *
 *   CSV export name                  API envelope name
 *   consumer_complaint_narrative  -> complaint_what_happened
 *   timely_response               -> timely
 *   (not in the CSV)              -> has_narrative (boolean, authoritative)
 *
 * Getting this wrong silently yields a database with no narratives at all, so
 * the mapper is written against the envelope and tested against a real payload.
 */
export interface CfpbSource {
  complaint_id?: string;
  date_received?: string;
  date_sent_to_company?: string | null;
  company?: string;
  product?: string;
  sub_product?: string | null;
  issue?: string;
  sub_issue?: string | null;
  state?: string | null;
  submitted_via?: string | null;
  company_response?: string | null;
  company_public_response?: string | null;
  timely?: string | null;
  has_narrative?: boolean;
  complaint_what_happened?: string | null;
  zip_code?: string | null;
  tags?: string | null;
}

export interface CfpbPage {
  hits: { hits: { _source: CfpbSource }[]; total: { value: number } };
}

/**
 * One day of the scope, paginated. The day is the unit of work because a day of
 * the scoped feed is roughly 350 records - small enough to parse inside the
 * free tier's 10ms CPU budget, and stable enough to cache as a unit.
 */
export function pageUrl(day: string, offset: number): string {
  const u = new URL(INGEST.apiBase);
  u.searchParams.set("date_received_min", day);
  u.searchParams.set("date_received_max", day);
  u.searchParams.set("size", String(INGEST.pageSize));
  u.searchParams.set("frm", String(offset));
  u.searchParams.set("sort", "created_date_desc");
  u.searchParams.set("no_aggs", "true");
  for (const p of SCOPE.products) u.searchParams.append("product", p);
  for (const c of SCOPE.companies) u.searchParams.append("company", c);
  return u.toString();
}

export function cacheKey(day: string, offset: number): string {
  return `cfpb:v1:${SCOPE.products.length}x${SCOPE.companies.length}:${day}:${offset}`;
}

/**
 * TTL policy. The source refreshes once daily, so nothing under 24h buys
 * anything and it only burns quota. But the feed is not append-only: narratives
 * arrive and company_response moves off "In progress" for weeks after filing.
 * So days inside the amendment horizon get the 24h TTL, and days beyond it -
 * which have settled and will not change again - get 30 days.
 */
export function ttlFor(day: string, ref = today()): number {
  const age = daysBetween(day, ref);
  return age > INGEST.amendmentHorizonDays
    ? INGEST.staleTtlSeconds
    : INGEST.freshTtlSeconds;
}

const SETTLED = new Set<string>(DETECTION.settledResponses);
const ADVERSE = new Set<string>(DETECTION.adverseResponses);

export function cellKey(company: string, product: string, issue: string): string {
  return `${company}|${product}|${issue}`;
}

/**
 * Stable digest of the fields we store, so an unchanged record can be skipped
 * instead of rewritten. D1's free tier meters row writes far more tightly than
 * row reads, and re-ingesting a settled day rewrites nothing.
 */
export function sourceHash(c: Omit<NormalisedComplaint, "source_hash">): string {
  const s = [
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
    c.narrative ? c.narrative.length : 0,
  ].join("");
  // FNV-1a, 32-bit. A collision here costs a missed update, not a correctness
  // failure: the next full re-ingest of that day picks the change up.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function normalise(src: CfpbSource): NormalisedComplaint | null {
  const id = src.complaint_id;
  if (!id || !src.date_received || !src.company || !src.product || !src.issue) {
    return null;
  }
  const date_received = toDay(src.date_received);
  const date_sent_to_company = src.date_sent_to_company
    ? toDay(src.date_sent_to_company)
    : null;
  const response_days =
    date_sent_to_company !== null
      ? Math.max(0, daysBetween(date_received, date_sent_to_company))
      : null;
  const response = src.company_response ?? null;
  const settled = response !== null && SETTLED.has(response) ? 1 : 0;
  const narrative =
    src.complaint_what_happened && src.complaint_what_happened.trim().length > 0
      ? src.complaint_what_happened
      : null;
  const timely = src.timely === "Yes" ? 1 : src.timely === "No" ? 0 : null;

  const base: Omit<NormalisedComplaint, "source_hash"> = {
    complaint_id: String(id),
    date_received,
    date_sent_to_company,
    company: src.company,
    product: src.product,
    sub_product: src.sub_product ?? null,
    issue: src.issue,
    sub_issue: src.sub_issue ?? null,
    state: src.state ?? null,
    submitted_via: src.submitted_via ?? null,
    company_response: response,
    company_public_response: src.company_public_response ?? null,
    timely_response: timely,
    // has_narrative is taken from the source, but a record flagged as having a
    // narrative with an empty body is treated as not having one.
    has_narrative: src.has_narrative === true && narrative !== null ? 1 : 0,
    narrative,
    cell_key: cellKey(src.company, src.product, src.issue),
    response_days,
    settled,
    adverse: settled === 1 && response !== null && ADVERSE.has(response) ? 1 : 0,
  };
  return { ...base, source_hash: sourceHash(base) };
}
