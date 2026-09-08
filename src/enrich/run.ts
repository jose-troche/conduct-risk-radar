import { PROMPT_VERSION, VARIANTS, type Variant } from "../config";
import type { AlertRow, Env } from "../types";
import { newId } from "../lib/http";
import { nowIso } from "../lib/time";
import { buildPacket } from "./packet";
import { buildPrompt } from "./prompt";
import { callModel, priceCall, variantAvailable } from "./providers";
import { validate, type ValidationStatus } from "./validate";

export function getVariant(id: string): Variant | undefined {
  return VARIANTS.find((v) => v.id === id);
}

export interface EnrichmentResult {
  id: string;
  alert_id: string;
  variant_id: string;
  validation_status: ValidationStatus;
  validation_detail: string | null;
  proposed_severity: string | null;
  summary: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
}

/**
 * Enrich one alert with one variant.
 *
 * A failed enrichment is recorded, not thrown away: the validation failure rate
 * is one of the numbers this experiment exists to produce. The alert itself is
 * never touched, so it continues to display - with its computed signals intact
 * and no drafted rationale - exactly as it would if the model were switched off.
 */
export async function enrichAlert(
  env: Env,
  alert: AlertRow,
  variant: Variant,
  batchId: string | null = null,
): Promise<EnrichmentResult> {
  const id = newId("enr");
  const at = nowIso();
  const packet = await buildPacket(env, alert);
  const prompt = buildPrompt(packet, variant);
  const packetIds = packet.complaints.map((c) => c.complaint_id);

  let status: ValidationStatus = "error";
  let detail: string | null = null;
  let raw = "";
  let latency: number | null = null;
  let inTok: number | null = null;
  let outTok: number | null = null;
  let output: ReturnType<typeof validate>["output"] = null;
  let citations: string[] = [];

  try {
    if (!variantAvailable(env, variant)) {
      throw new Error(`Variant ${variant.id} is not available in this deployment.`);
    }
    const call = await callModel(env, variant, prompt);
    raw = call.text;
    latency = call.latency_ms;
    inTok = call.input_tokens;
    outTok = call.output_tokens;
    const v = validate(raw, packet);
    status = v.status;
    detail = v.detail;
    output = v.output;
    citations = v.citations;
  } catch (e) {
    status = "error";
    detail = e instanceof Error ? e.message : String(e);
  }

  const cost = priceCall(variant, inTok, outTok);

  await env.DB.prepare(`
INSERT INTO enrichments (
  id, alert_id, batch_id, variant_id, model, prompt_version, summary,
  proposed_severity, reasoning, citations_json, signals_referenced_json,
  packet_complaint_ids_json, validation_status, validation_detail, raw_output,
  input_tokens, output_tokens, cost_usd, latency_ms, created_at
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`)
    .bind(
      id,
      alert.id,
      batchId,
      variant.id,
      variant.model,
      PROMPT_VERSION,
      output?.summary ?? null,
      output?.proposed_severity ?? null,
      output?.reasoning ?? null,
      JSON.stringify(citations),
      JSON.stringify(output?.signals_referenced ?? []),
      JSON.stringify(packetIds),
      status,
      detail,
      // The raw output is kept even when validation passes: without it a
      // failure rate is a number nobody can go and check.
      raw.slice(0, 8000),
      inTok,
      outTok,
      cost,
      latency,
      at,
    )
    .run();

  return {
    id,
    alert_id: alert.id,
    variant_id: variant.id,
    validation_status: status,
    validation_detail: detail,
    proposed_severity: output?.proposed_severity ?? null,
    summary: output?.summary ?? null,
    latency_ms: latency,
    cost_usd: cost,
  };
}

export async function loadAlert(env: Env, id: string): Promise<AlertRow | null> {
  return await env.DB.prepare(`SELECT * FROM alerts WHERE id = ?1`)
    .bind(id)
    .first<AlertRow>();
}

export async function loadAlerts(env: Env, ids: string[]): Promise<AlertRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
  const rows = await env.DB.prepare(
    `SELECT * FROM alerts WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<AlertRow>();
  return rows.results;
}
