export interface SignalDetail {
  type: string;
  label: string;
  raw: number | null;
  window_value: string;
  baseline_value: string;
  normalized: number;
  weight: number;
  contribution: number;
  note?: string;
}

export interface Alert {
  id: string;
  cell_key: string;
  company: string;
  product: string;
  issue: string;
  signal_type: string;
  score: number;
  status: string;
  window_start: string;
  window_end: string;
  baseline_start: string;
  baseline_end: string;
  window_n: number;
  window_narrative_n: number;
  baseline_n: number;
  signals: SignalDetail[];
  driver_complaint_ids: string[];
  weights_version: string;
  first_seen_at: string;
  last_seen_at: string;
  disposition_count?: number;
  latest_enrichment_status?: string | null;
}

export interface Driver {
  complaint_id: string;
  date_received: string;
  product: string;
  sub_product: string | null;
  issue: string;
  sub_issue: string | null;
  state: string | null;
  company_response: string | null;
  timely_response: number | null;
  has_narrative: number;
  narrative: string | null;
}

export interface Enrichment {
  id: string;
  variant_id: string;
  model: string;
  prompt_version: string;
  summary: string | null;
  proposed_severity: string | null;
  reasoning: string | null;
  citations_json: string;
  signals_referenced_json: string;
  validation_status: string;
  validation_detail: string | null;
  cost_usd: number | null;
  latency_ms: number | null;
  created_at: string;
}

export interface Disposition {
  id: string;
  action: string;
  analyst_severity: string;
  reason: string;
  analyst_id: string;
  enrichment_shown_after: number;
  created_at: string;
}

export interface AlertDetail {
  alert: Alert;
  drivers: Driver[];
  enrichments: Enrichment[];
  enrichment_revealed: boolean;
  enrichment_count: number;
  dispositions: Disposition[];
  coverage: {
    window_complaints: number;
    window_with_narrative: number;
    drivers_returned: number;
    drivers_with_narrative: number;
  };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export const api = {
  config: () => req<any>("/api/config"),
  stats: () => req<any>("/api/stats"),
  alerts: (params: Record<string, string>) =>
    req<{ items: Alert[]; next_cursor: string | null }>(
      `/api/alerts?${new URLSearchParams(params)}`,
    ),
  /** reveal must stay false until the analyst's own severity is locked. */
  alert: (id: string, reveal: boolean) =>
    req<AlertDetail>(`/api/alerts/${id}${reveal ? "?reveal=1" : ""}`),
  disposition: (id: string, body: unknown) =>
    req<{ ok: true }>(`/api/alerts/${id}/disposition`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  enrich: (alertIds: string[], variantId: string, token: string) =>
    req<{ batch_id: string; total: number; stream: string }>("/api/enrich", {
      method: "POST",
      body: JSON.stringify({ alert_ids: alertIds, variant_id: variantId }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  evalRuns: () => req<{ items: any[] }>("/api/eval/runs"),
  evalRun: (id: string) => req<any>(`/api/eval/runs/${id}`),
  runEval: (variantIds: string[], token: string) =>
    req<any>("/api/eval/runs", {
      method: "POST",
      body: JSON.stringify({ variant_ids: variantIds }),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
};
