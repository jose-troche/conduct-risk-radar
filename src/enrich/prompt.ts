import { SIGNAL_LABELS, type Variant } from "../config";
import type { EvidencePacket } from "../types";

/**
 * The prompt states the prohibitions, and the validation gate in validate.ts
 * enforces them independently afterwards. Both halves are necessary: asking a
 * model not to invent a number is not the same as checking that it did not.
 */
const RULES = `You are drafting an analyst-facing rationale for a conduct-risk TRIAGE ALERT.

WHAT THE SCORE IS
The score is a TRIAGE PRIORITY: it ranks which anomaly a person should look at
first. It is not a probability, not a risk rating, and not a prediction of any
outcome. Never describe it as any of those.

WHAT THE DATA IS
These are consumer complaints filed with the CFPB. They are ALLEGATIONS: they
are consumer-submitted and unverified. Nothing here establishes that the
institution did anything wrong. Complaint volume also tracks attention - market
share, press coverage, product launches - as much as it tracks conduct.

CITATION FORMAT - THIS IS ENFORCED
Every sentence you write in "summary" and "reasoning" that makes a factual
assertion MUST end with one or more inline citations in square brackets, each
holding a single complaint_id from the evidence below. Shape:

  Several consumers describe holds placed on deposited funds without notice
  [COMPLAINT_ID] [COMPLAINT_ID].

Replace each COMPLAINT_ID with an id copied from the DRIVING COMPLAINTS section
below. The ids in the evidence packet are the ONLY ids that exist. Never cite a
number that appears anywhere in these instructions - they are placeholders, not
complaints.

A sentence with no citation will fail validation and the whole enrichment will
be discarded. Do not invent an id. Do not cite a range.

You may leave a sentence uncited ONLY if it refers purely to the computed
signals given below, in which case name the signal instead, e.g. "The volume
anomaly signal contributes most of the score."

PROHIBITED - the output is rejected if it does any of these
1. Inventing volumes, dates, counts or percentages that are not in the evidence.
   Use the numbers given; do not compute new ones.
2. Causal claims about the institution. You may not say the firm changed a
   policy, cut staff, altered a system, or caused anything. You did not observe
   that, and the data cannot support it.
3. Predictions about regulatory, supervisory or enforcement action.
4. Any factual assertion without a citation.

OUTPUT
Reply with a single JSON object and nothing else - no prose before or after, no
markdown fences:

{
  "summary": "2-4 sentences, plain language, what appears to be happening. Cited.",
  "proposed_severity": "low" | "medium" | "high",
  "reasoning": "2-5 sentences justifying that severity. Cited.",
  "citations": ["complaint_id", ...],
  "signals_referenced": ["volume_anomaly", ...]
}

"citations" must list every complaint_id you cited inline. "signals_referenced"
must name only signals from the computed signal list below.`;

function renderSignals(packet: EvidencePacket): string {
  return packet.signals
    .map((s) => {
      const head = `- ${SIGNAL_LABELS[s.type] ?? s.type} (${s.type})`;
      const body = `  window: ${s.window_value}\n  baseline: ${s.baseline_value}\n  normalised ${s.normalized}/100, weight ${s.weight}, contributes ${s.contribution} points`;
      return s.note ? `${head}\n${body}\n  note: ${s.note}` : `${head}\n${body}`;
    })
    .join("\n");
}

function renderComplaints(packet: EvidencePacket): string {
  if (packet.complaints.length === 0) {
    return "(none of the driving complaints carry a published narrative)";
  }
  return packet.complaints
    .map((c) => {
      const head = `[${c.complaint_id}] ${c.date_received} | ${c.product}${
        c.sub_product ? ` / ${c.sub_product}` : ""
      } | ${c.issue}${c.sub_issue ? ` / ${c.sub_issue}` : ""} | ${
        c.state ?? "state unknown"
      } | company response: ${c.company_response ?? "none recorded"}`;
      const body = c.narrative
        ? `  narrative: ${c.narrative}${c.narrative_truncated ? " [...truncated]" : ""}`
        : "  narrative: not published (the consumer did not consent to publication)";
      return `${head}\n${body}`;
    })
    .join("\n\n");
}

export function buildPrompt(packet: EvidencePacket, variant: Variant): string {
  const coverage = `${packet.window_narrative_n} of ${packet.window_n} complaints in the window carry a published narrative; ${packet.complaints.length} are included below.`;

  const header = `ALERT ${packet.alert_id}
Institution: ${packet.company}
Product: ${packet.product}
Issue: ${packet.issue}
Detection window: ${packet.window.start} to ${packet.window.end}
Baseline window: ${packet.baseline.start} to ${packet.baseline.end}
Triage priority score: ${packet.score}/100 (dominant signal: ${packet.dominant_signal})
Complaints in window: ${packet.window_n}. In baseline: ${packet.baseline_n}.
Narrative coverage: ${coverage}`;

  if (variant.promptStyle === "terse") {
    // The terse variant keeps the rules that the gate enforces and drops the
    // scaffolding around them. The comparison is meant to show how much of the
    // quality comes from the prompt rather than the model.
    return `Draft an analyst rationale for this conduct-risk triage alert. The score is a triage priority, not a prediction. Complaints are unverified allegations.

Cite every factual sentence inline as [complaint_id]. Uncited sentences, invented numbers, causal claims about the firm, and predictions of enforcement action are all rejected.

Reply with only a JSON object: {"summary","proposed_severity":"low"|"medium"|"high","reasoning","citations":[],"signals_referenced":[]}

${header}

COMPUTED SIGNALS
${renderSignals(packet)}

COMPLAINTS
${renderComplaints(packet)}`;
  }

  return `${RULES}

=== EVIDENCE PACKET ===
${header}

--- COMPUTED SIGNALS (these numbers are given; do not recompute them) ---
${renderSignals(packet)}

--- DRIVING COMPLAINTS (the only complaints you may cite) ---
${renderComplaints(packet)}
=== END OF EVIDENCE PACKET ===

There is nothing else available to you. Do not refer to any complaint, figure or
event that is not printed above.`;
}
