import { SEVERITIES, type Severity, type SignalType } from "../config";
import type { EnrichmentOutput, EvidencePacket } from "../types";
import { citableIds, packetNumbers } from "./packet";

export type ValidationStatus =
  | "ok"
  | "schema_fail"
  | "bad_citation"
  | "uncited_assertion"
  | "prohibited_claim"
  | "invented_number"
  | "refused"
  | "error";

export interface ValidationResult {
  status: ValidationStatus;
  detail: string | null;
  output: EnrichmentOutput | null;
  /** Citations recovered from the inline markers, whatever the model listed. */
  citations: string[];
}

/**
 * Models fence JSON in markdown, prepend "Here is the JSON:", or emit a single
 * object surrounded by chatter. Recovering the object is a parsing problem, not
 * a correctness one, so we are permissive here and strict everywhere after.
 */
export function extractJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      const start = c.indexOf("{");
      const end = c.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(c.slice(start, end + 1));
        } catch {
          /* fall through to the next candidate */
        }
      }
    }
  }
  return null;
}

const CITATION_RE = /\[\s*(\d{4,})\s*\]/g;
/** Non-global twin. A /g regex carries lastIndex across .test() calls, which
 *  silently makes every other sentence look uncited. */
const HAS_CITATION = /\[\s*\d{4,}\s*\]/;

/** Split on sentence terminators, keeping the citation markers attached. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * A sentence is exempt from citation if it makes no factual assertion about the
 * complaints - it only refers to the computed signals, which are given to the
 * model rather than derived by it.
 */
function refersOnlyToSignals(sentence: string, signalTypes: Set<string>): boolean {
  const lower = sentence.toLowerCase();
  for (const t of signalTypes) {
    if (lower.includes(t) || lower.includes(t.replace(/_/g, " "))) return true;
  }
  return /\b(triage priority|score|signal|baseline|contribut)/i.test(sentence);
}

/**
 * Causal and predictive language. These patterns are deliberately narrow: they
 * target the specific claims the spec prohibits rather than trying to police
 * tone. A false positive here throws away a usable enrichment, and the
 * deterministic alert is what actually has to stand up.
 */
const PROHIBITED: { re: RegExp; label: string }[] = [
  {
    re: /\b(?:the )?(?:bank|company|firm|institution|they)\s+(?:has |have |had )?(?:changed|altered|modified|reduced|cut|removed|implemented|introduced|updated|revised)\b/i,
    label: "causal claim about an institutional action that was not observed",
  },
  {
    re: /\b(?:regulator|regulators|cfpb|enforcement|supervisory|examiner)\w*\s+(?:will|are likely to|is likely to|may|could|would)\b/i,
    label: "prediction about regulatory or enforcement action",
  },
  {
    re: /\b(?:will|likely to|expected to)\s+(?:face|trigger|result in|lead to)\s+(?:an? )?(?:enforcement|fine|penalty|action|investigation)/i,
    label: "prediction of enforcement consequences",
  },
  {
    re: /\b(?:probability|likelihood) of\b|\brisk rating\b|\bpredicts?\b|\bforecast/i,
    label: "framing the triage priority as a probability, rating or prediction",
  },
  {
    re: /\bbecause the (?:bank|company|firm|institution)\b/i,
    label: "causal attribution to the institution",
  },
];

const REFUSAL =
  /\b(?:I(?:'m| am) (?:sorry|unable|not able)|I cannot (?:assist|help|comply)|as an AI language model)\b/i;

export function validate(
  raw: string,
  packet: EvidencePacket,
): ValidationResult {
  const fail = (status: ValidationStatus, detail: string): ValidationResult => ({
    status,
    detail,
    output: null,
    citations: [],
  });

  if (REFUSAL.test(raw.slice(0, 400))) {
    return fail("refused", "The model declined to produce a rationale.");
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return fail("schema_fail", "Output was not a JSON object.");
  }
  const o = parsed as Record<string, unknown>;

  const summary = typeof o.summary === "string" ? o.summary : null;
  const reasoning = typeof o.reasoning === "string" ? o.reasoning : null;
  const severity = typeof o.proposed_severity === "string" ? o.proposed_severity.toLowerCase() : null;

  if (!summary || !reasoning) {
    return fail("schema_fail", "Missing summary or reasoning.");
  }
  if (!severity || !(SEVERITIES as readonly string[]).includes(severity)) {
    return fail(
      "schema_fail",
      `proposed_severity must be one of low/medium/high, got ${JSON.stringify(o.proposed_severity)}.`,
    );
  }

  const body = `${summary}\n${reasoning}`;

  for (const p of PROHIBITED) {
    const m = body.match(p.re);
    if (m) return fail("prohibited_claim", `${p.label}: "${m[0]}"`);
  }

  // --- Citations ------------------------------------------------------------
  // The inline markers are authoritative, not the model's own citations array:
  // a model that lists an id it never used has not actually cited anything.
  const allowed = citableIds(packet);
  const inline = [...body.matchAll(CITATION_RE)].map((m) => m[1]);
  const declared = Array.isArray(o.citations) ? o.citations.map(String) : [];
  const cited = [...new Set([...inline, ...declared])];

  if (allowed.size > 0 && inline.length === 0) {
    return fail(
      "uncited_assertion",
      "No inline citations at all, and the packet contained citable complaints.",
    );
  }
  const bad = cited.filter((c) => !allowed.has(c));
  if (bad.length > 0) {
    return fail(
      "bad_citation",
      `Cited complaint ids not present in the evidence packet: ${bad.slice(0, 5).join(", ")}.`,
    );
  }

  // Every assertive sentence needs a citation. Sentences that only discuss the
  // computed signals are exempt, because those numbers were handed over rather
  // than drawn from a complaint.
  const signalTypes = new Set(packet.signals.map((s) => s.type as string));
  if (allowed.size > 0) {
    for (const s of sentences(body)) {
      if (s.length < 40) continue;
      if (HAS_CITATION.test(s)) continue;
      if (refersOnlyToSignals(s, signalTypes)) continue;
      return fail(
        "uncited_assertion",
        `Assertion with no citation: "${s.slice(0, 160)}"`,
      );
    }
  }

  // --- Invented figures -----------------------------------------------------
  // Integers of three or more digits that are neither a citation nor present
  // anywhere in the packet. Small integers are excluded because "two consumers"
  // and "3 of the complaints" are countable from the packet itself.
  const known = packetNumbers(packet);
  const stripped = body.replace(CITATION_RE, " ");
  for (const m of stripped.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const token = m[0].replace(/,/g, "");
    const value = Number(token);
    if (!Number.isFinite(value)) continue;
    if (value < 100) continue;
    if (known.has(token) || known.has(String(Math.round(value)))) continue;
    return fail(
      "invented_number",
      `Figure "${m[0]}" does not appear anywhere in the evidence packet.`,
    );
  }

  const signalsReferenced = Array.isArray(o.signals_referenced)
    ? o.signals_referenced.map(String).filter((s) => signalTypes.has(s))
    : [];

  return {
    status: "ok",
    detail: null,
    citations: cited,
    output: {
      summary,
      reasoning,
      proposed_severity: severity as Severity,
      citations: cited,
      signals_referenced: signalsReferenced as SignalType[],
    },
  };
}
