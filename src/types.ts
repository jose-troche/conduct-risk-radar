import type { SignalType, Severity } from "./config";

export interface Env {
  DB: D1Database;
  RAW_CACHE: KVNamespace;
  AI: Ai;
  ENRICH_BATCH: DurableObjectNamespace;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string;
}

export interface NormalisedComplaint {
  complaint_id: string;
  date_received: string;
  date_sent_to_company: string | null;
  company: string;
  product: string;
  sub_product: string | null;
  issue: string;
  sub_issue: string | null;
  state: string | null;
  submitted_via: string | null;
  company_response: string | null;
  company_public_response: string | null;
  timely_response: number | null;
  has_narrative: number;
  narrative: string | null;
  cell_key: string;
  response_days: number | null;
  settled: number;
  adverse: number;
  source_hash: string;
}

export interface SignalDetail {
  type: SignalType;
  label: string;
  /** The measured quantity, in its own units. */
  raw: number | null;
  /** Human-readable rendering of raw, window vs baseline. */
  window_value: string;
  baseline_value: string;
  /** 0–100. */
  normalized: number;
  weight: number;
  /** normalized * weight; the signal's share of the alert score. */
  contribution: number;
  /** Why this signal did not score, when it did not. */
  note?: string;
}

export interface AlertRow {
  id: string;
  cell_key: string;
  company: string;
  product: string;
  issue: string;
  signal_type: SignalType;
  score: number;
  status: string;
  window_start: string;
  window_end: string;
  baseline_start: string;
  baseline_end: string;
  window_n: number;
  window_narrative_n: number;
  baseline_n: number;
  signals_json: string;
  driver_complaint_ids_json: string;
  weights_version: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface PacketComplaint {
  complaint_id: string;
  date_received: string;
  product: string;
  sub_product: string | null;
  issue: string;
  sub_issue: string | null;
  state: string | null;
  company_response: string | null;
  narrative: string | null;
  narrative_truncated: boolean;
}

export interface EvidencePacket {
  alert_id: string;
  company: string;
  product: string;
  issue: string;
  window: { start: string; end: string };
  baseline: { start: string; end: string };
  score: number;
  dominant_signal: SignalType;
  window_n: number;
  baseline_n: number;
  window_narrative_n: number;
  signals: SignalDetail[];
  complaints: PacketComplaint[];
}

export interface EnrichmentOutput {
  summary: string;
  proposed_severity: Severity;
  reasoning: string;
  citations: string[];
  signals_referenced: string[];
}
