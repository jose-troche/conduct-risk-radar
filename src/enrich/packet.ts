import { ENRICH } from "../config";
import type { AlertRow, EvidencePacket, PacketComplaint, SignalDetail, Env } from "../types";

/**
 * The evidence packet is the complete and only input the model gets.
 *
 * Nothing is retrieved at generation time: no web access, no other alerts, no
 * lookups the model asks for. The packet is assembled from rows the
 * deterministic layer already wrote, which is what makes the model's output
 * auditable - every claim it can legitimately make is traceable to something in
 * here, and the validation gate checks exactly that.
 */
export async function buildPacket(
  env: Env,
  alert: AlertRow,
): Promise<EvidencePacket> {
  const ids: string[] = JSON.parse(alert.driver_complaint_ids_json || "[]");
  const bounded = ids.slice(0, ENRICH.maxPacketComplaints);

  let complaints: PacketComplaint[] = [];
  if (bounded.length > 0) {
    const placeholders = bounded.map((_, i) => `?${i + 1}`).join(",");
    const rows = await env.DB.prepare(
      `SELECT complaint_id, date_received, product, sub_product, issue, sub_issue,
              state, company_response, narrative, has_narrative
       FROM complaints WHERE complaint_id IN (${placeholders})
       ORDER BY has_narrative DESC, date_received DESC`,
    )
      .bind(...bounded)
      .all<{
        complaint_id: string;
        date_received: string;
        product: string;
        sub_product: string | null;
        issue: string;
        sub_issue: string | null;
        state: string | null;
        company_response: string | null;
        narrative: string | null;
        has_narrative: number;
      }>();

    complaints = rows.results.map((r) => {
      const full = r.has_narrative === 1 ? r.narrative : null;
      const truncated = !!full && full.length > ENRICH.maxNarrativeChars;
      return {
        complaint_id: r.complaint_id,
        date_received: r.date_received,
        product: r.product,
        sub_product: r.sub_product,
        issue: r.issue,
        sub_issue: r.sub_issue,
        state: r.state,
        company_response: r.company_response,
        narrative: truncated ? full!.slice(0, ENRICH.maxNarrativeChars) : full,
        narrative_truncated: truncated,
      };
    });
  }

  const signals: SignalDetail[] = JSON.parse(alert.signals_json);

  return {
    alert_id: alert.id,
    company: alert.company,
    product: alert.product,
    issue: alert.issue,
    window: { start: alert.window_start, end: alert.window_end },
    baseline: { start: alert.baseline_start, end: alert.baseline_end },
    score: alert.score,
    dominant_signal: alert.signal_type,
    window_n: alert.window_n,
    baseline_n: alert.baseline_n,
    window_narrative_n: alert.window_narrative_n,
    signals,
    complaints,
  };
}

/** Every complaint id the model is permitted to cite. */
export function citableIds(packet: EvidencePacket): Set<string> {
  return new Set(packet.complaints.map((c) => c.complaint_id));
}

/**
 * Every number the packet actually contains, as strings. The validation gate
 * uses this to catch invented volumes, dates and counts: a figure in the output
 * that is not in this set was not derived from the evidence.
 */
export function packetNumbers(packet: EvidencePacket): Set<string> {
  const nums = new Set<string>();
  const add = (v: unknown) => {
    if (v === null || v === undefined) return;
    for (const m of String(v).matchAll(/\d+(?:\.\d+)?/g)) {
      nums.add(m[0]);
      // A figure the model rounds off is still derived from the packet, so both
      // "12.5" and "12" count as present.
      if (m[0].includes(".")) nums.add(String(Math.round(Number(m[0]))));
    }
  };
  add(packet.window_n);
  add(packet.baseline_n);
  add(packet.window_narrative_n);
  add(packet.score);
  add(packet.window.start);
  add(packet.window.end);
  add(packet.baseline.start);
  add(packet.baseline.end);
  add(packet.complaints.length);
  for (const s of packet.signals) {
    add(s.raw);
    add(s.normalized);
    add(s.weight);
    add(s.contribution);
    add(s.window_value);
    add(s.baseline_value);
  }
  for (const c of packet.complaints) {
    add(c.complaint_id);
    add(c.date_received);
  }
  return nums;
}
