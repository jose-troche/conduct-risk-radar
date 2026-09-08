import { describe, expect, it } from "vitest";
import { normalise, sourceHash, ttlFor, cellKey } from "../src/ingest/cfpb";
import { computeSignals, scoreCell } from "../src/detect/signals";
import { validate, extractJson } from "../src/enrich/validate";
import { classify } from "../src/evaluation/run";
import { normalise as norm, zScore } from "../src/lib/stats";
import { addDays, daysBetween } from "../src/lib/time";
import { WEIGHTS, INGEST } from "../src/config";
import type { CellAgg } from "../src/detect/queries";
import type { EvidencePacket } from "../src/types";

/** A real record, copied verbatim from a live CFPB API response. */
const LIVE_SOURCE = {
  product: "Checking or savings account",
  complaint_what_happened: "",
  date_sent_to_company: "2026-08-31T23:48:35.000Z",
  issue: "Managing an account",
  sub_product: "Savings account",
  zip_code: "74075",
  tags: "Older American",
  has_narrative: false,
  complaint_id: "26186607",
  timely: "Yes",
  company_response: "In progress",
  submitted_via: "Web",
  company: "ALLY FINANCIAL INC.",
  date_received: "2026-08-29T23:43:32.000Z",
  state: "OK",
  company_public_response: null,
  sub_issue: "Deposits and withdrawals",
};

describe("CFPB normalisation", () => {
  it("maps the API envelope field names, not the CSV export names", () => {
    const n = normalise(LIVE_SOURCE)!;
    expect(n.complaint_id).toBe("26186607");
    expect(n.date_received).toBe("2026-08-29");
    expect(n.date_sent_to_company).toBe("2026-08-31");
    expect(n.response_days).toBe(2);
    // "timely" in the envelope, not "timely_response"
    expect(n.timely_response).toBe(1);
    expect(n.cell_key).toBe(
      cellKey("ALLY FINANCIAL INC.", "Checking or savings account", "Managing an account"),
    );
  });

  it("treats an in-progress complaint as unsettled", () => {
    const n = normalise(LIVE_SOURCE)!;
    // This matters: comparing a half-settled window against a fully settled
    // baseline would manufacture drift out of the age of the data alone.
    expect(n.settled).toBe(0);
    expect(n.adverse).toBe(0);
  });

  it("marks a closed-without-relief complaint as settled and adverse", () => {
    const n = normalise({ ...LIVE_SOURCE, company_response: "Closed with explanation" })!;
    expect(n.settled).toBe(1);
    expect(n.adverse).toBe(1);
  });

  it("does not count a narrative flag with an empty body as a narrative", () => {
    const n = normalise({ ...LIVE_SOURCE, has_narrative: true, complaint_what_happened: "   " })!;
    expect(n.has_narrative).toBe(0);
    expect(n.narrative).toBeNull();
  });

  it("reads a published narrative when one is present", () => {
    const n = normalise({
      ...LIVE_SOURCE,
      has_narrative: true,
      complaint_what_happened: "A hold was placed on my deposit.",
    })!;
    expect(n.has_narrative).toBe(1);
    expect(n.narrative).toContain("hold was placed");
  });

  it("rejects a record missing a grouping dimension", () => {
    expect(normalise({ ...LIVE_SOURCE, company: undefined })).toBeNull();
    expect(normalise({ ...LIVE_SOURCE, issue: undefined })).toBeNull();
  });
});

describe("idempotency", () => {
  it("gives the same hash for the same record, so a re-run writes nothing", () => {
    const a = normalise(LIVE_SOURCE)!;
    const b = normalise({ ...LIVE_SOURCE })!;
    expect(a.source_hash).toBe(b.source_hash);
  });

  it("changes the hash when the source amends a record", () => {
    const before = normalise(LIVE_SOURCE)!;
    const after = normalise({ ...LIVE_SOURCE, company_response: "Closed with monetary relief" })!;
    expect(after.source_hash).not.toBe(before.source_hash);
  });

  it("changes the hash when a narrative arrives later", () => {
    const before = normalise(LIVE_SOURCE)!;
    const after = normalise({
      ...LIVE_SOURCE,
      has_narrative: true,
      complaint_what_happened: "Late-arriving narrative.",
    })!;
    expect(after.source_hash).not.toBe(before.source_hash);
  });

  it("is stable against key ordering in the source object", () => {
    const reordered = Object.fromEntries(
      Object.entries(LIVE_SOURCE).reverse(),
    ) as typeof LIVE_SOURCE;
    expect(sourceHash(normalise(reordered)!)).toBe(sourceHash(normalise(LIVE_SOURCE)!));
  });
});

describe("KV TTL policy", () => {
  const ref = "2026-09-07";
  it("keeps recent days short-lived because the source still amends them", () => {
    expect(ttlFor("2026-09-05", ref)).toBe(INGEST.freshTtlSeconds);
    expect(ttlFor(addDays(ref, -INGEST.amendmentHorizonDays), ref)).toBe(INGEST.freshTtlSeconds);
  });
  it("caches settled days hard", () => {
    expect(ttlFor(addDays(ref, -INGEST.amendmentHorizonDays - 1), ref)).toBe(
      INGEST.staleTtlSeconds,
    );
  });
});

describe("time helpers", () => {
  it("counts days across a month boundary", () => {
    expect(daysBetween("2026-08-29", "2026-09-07")).toBe(9);
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("statistics", () => {
  it("floors the standard deviation so a flat baseline cannot produce infinity", () => {
    expect(Number.isFinite(zScore(5, 1, 0))).toBe(true);
  });
  it("clamps a normalised signal to 0-100", () => {
    expect(norm(-3, 4)).toBe(0);
    expect(norm(40, 4)).toBe(100);
    expect(norm(2, 4)).toBe(50);
  });
});

function agg(over: Partial<CellAgg> = {}): CellAgg {
  return {
    cell_key: "C|P|I",
    company: "C",
    product: "P",
    issue: "I",
    n: 60,
    sumsq: 60,
    n_narrative: 20,
    n_settled: 60,
    n_untimely: 3,
    n_adverse: 30,
    rd_sum: 0,
    rd_n: 60,
    ...over,
  };
}

const baseCtx = {
  windowDays: 14,
  baselineDays: 60,
  window: agg({ n: 14, sumsq: 14, n_settled: 14, n_untimely: 1, n_adverse: 7, n_narrative: 5 }),
  baseline: agg(),
  windowMedianResponse: 1,
  baselineMedianResponse: 1,
  windowTopState: { state: "CA", share: 0.2 },
  baselineStateShare: 0.2,
  windowIssueShare: 0.1,
  baselineIssueShare: 0.1,
  windowMarketShare: 0.1,
  baselineMarketShare: 0.1,
};

describe("detection signals", () => {
  it("scores a steady cell near zero", () => {
    const s = scoreCell(computeSignals(baseCtx));
    expect(s.score).toBeLessThan(5);
  });

  it("scores a volume spike and names volume as the dominant signal", () => {
    const s = scoreCell(
      computeSignals({
        ...baseCtx,
        window: agg({ n: 70, sumsq: 350, n_settled: 70, n_untimely: 4, n_adverse: 35 }),
      }),
    );
    expect(s.score).toBeGreaterThan(30);
    expect(s.dominant).toBe("volume_anomaly");
  });

  it("subtracts the market-wide move from the emerging-issue signal", () => {
    // The company's issue share doubles, but so does the whole market's. That
    // is a sector story, not a firm story, and must not score.
    const sectorWide = computeSignals({
      ...baseCtx,
      windowIssueShare: 0.2,
      baselineIssueShare: 0.1,
      windowMarketShare: 0.2,
      baselineMarketShare: 0.1,
    });
    expect(sectorWide.find((s) => s.type === "emerging_issue")!.normalized).toBe(0);

    // Same company move with a flat market is a firm-specific emergence.
    const firmOnly = computeSignals({
      ...baseCtx,
      windowIssueShare: 0.2,
      baselineIssueShare: 0.1,
    });
    expect(firmOnly.find((s) => s.type === "emerging_issue")!.normalized).toBeGreaterThan(50);
  });

  it("does not score handling signals when there are too few settled complaints", () => {
    const s = computeSignals({
      ...baseCtx,
      window: agg({ n: 14, sumsq: 14, n_settled: 2, n_untimely: 2, n_adverse: 2 }),
    });
    const timeliness = s.find((x) => x.type === "timeliness_drift")!;
    expect(timeliness.normalized).toBe(0);
    expect(timeliness.note).toMatch(/too few settled/i);
  });

  it("makes the score reconstructible from the stored contributions", () => {
    const signals = computeSignals({
      ...baseCtx,
      window: agg({ n: 45, sumsq: 200, n_settled: 45, n_untimely: 9, n_adverse: 34 }),
      windowMedianResponse: 3,
    });
    const scored = scoreCell(signals);
    const summed = signals.reduce((t, s) => t + s.contribution, 0);
    expect(Math.abs(summed - scored.score)).toBeLessThan(0.01);
  });

  it("weights sum to one, so the score reads directly as 0-100", () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  });
});

const packet: EvidencePacket = {
  alert_id: "alt_1",
  company: "TEST BANK",
  product: "Credit card",
  issue: "Problem with a purchase",
  window: { start: "2026-08-24", end: "2026-09-07" },
  baseline: { start: "2026-06-25", end: "2026-08-24" },
  score: 61.2,
  dominant_signal: "volume_anomaly",
  window_n: 42,
  baseline_n: 130,
  window_narrative_n: 11,
  signals: [
    {
      type: "volume_anomaly",
      label: "Volume anomaly",
      raw: 3.1,
      window_value: "3/day (42 in 14d)",
      baseline_value: "2.16/day (sd 0.9, n=130)",
      normalized: 77.5,
      weight: 0.35,
      contribution: 27.1,
    },
  ],
  complaints: [
    {
      complaint_id: "12345678",
      date_received: "2026-09-01",
      product: "Credit card",
      sub_product: null,
      issue: "Problem with a purchase",
      sub_issue: null,
      state: "CA",
      company_response: "Closed with explanation",
      narrative: "A charge I disputed was reinstated without notice.",
      narrative_truncated: false,
    },
    {
      complaint_id: "87654321",
      date_received: "2026-09-02",
      product: "Credit card",
      sub_product: null,
      issue: "Problem with a purchase",
      sub_issue: null,
      state: "TX",
      company_response: "Closed with explanation",
      narrative: "My dispute was closed with no explanation given.",
      narrative_truncated: false,
    },
  ],
};

const good = JSON.stringify({
  summary:
    "Consumers report that disputed charges were reinstated without notice [12345678]. Another consumer describes a dispute closed with no explanation [87654321].",
  proposed_severity: "medium",
  reasoning:
    "The volume_anomaly signal carries most of the triage priority score here. Both narratives describe the same dispute-handling pattern rather than isolated events [12345678] [87654321].",
  citations: ["12345678", "87654321"],
  signals_referenced: ["volume_anomaly"],
});

describe("validation gate", () => {
  it("passes a cited, in-scope draft", () => {
    const v = validate(good, packet);
    expect(v.status).toBe("ok");
    expect(v.output?.proposed_severity).toBe("medium");
    expect(v.citations.sort()).toEqual(["12345678", "87654321"]);
  });

  it("recovers JSON from a markdown fence", () => {
    const v = validate("Here you go:\n```json\n" + good + "\n```", packet);
    expect(v.status).toBe("ok");
  });

  it("fails a hallucinated citation", () => {
    const bad = good.replace("87654321", "99999999");
    const v = validate(bad, packet);
    expect(v.status).toBe("bad_citation");
    expect(v.detail).toContain("99999999");
  });

  it("fails an assertion with no citation", () => {
    const v = validate(
      JSON.stringify({
        summary:
          "Many consumers across several states are describing a widespread failure in the dispute handling process.",
        proposed_severity: "high",
        reasoning: "The pattern is consistent across the complaints reviewed in this packet.",
        citations: [],
        signals_referenced: [],
      }),
      packet,
    );
    expect(v.status).toBe("uncited_assertion");
  });

  it("fails a causal claim about the institution", () => {
    const v = validate(
      good.replace(
        "Both narratives describe",
        "The bank changed its dispute policy and both narratives describe",
      ),
      packet,
    );
    expect(v.status).toBe("prohibited_claim");
  });

  it("fails a prediction of enforcement action", () => {
    const v = validate(
      good.replace(
        "Both narratives describe",
        "Regulators will likely open an investigation, and both narratives describe",
      ),
      packet,
    );
    expect(v.status).toBe("prohibited_claim");
  });

  it("fails framing the triage priority as a probability", () => {
    const v = validate(
      good.replace("most of the triage priority score", "the probability of misconduct"),
      packet,
    );
    expect(v.status).toBe("prohibited_claim");
  });

  it("fails an invented volume", () => {
    const v = validate(
      good.replace("Consumers report", "All 480 affected consumers report"),
      packet,
    );
    expect(v.status).toBe("invented_number");
    expect(v.detail).toContain("480");
  });

  it("accepts a figure that is actually in the packet", () => {
    const v = validate(
      good.replace("Consumers report", "Across 42 complaints in the window, consumers report"),
      packet,
    );
    expect(v.status).toBe("ok");
  });

  it("fails a refusal", () => {
    expect(validate("I'm sorry, I cannot assist with that request.", packet).status).toBe(
      "refused",
    );
  });

  it("fails output that is not JSON at all", () => {
    expect(validate("The situation looks bad.", packet).status).toBe("schema_fail");
  });

  it("fails an out-of-enum severity", () => {
    expect(validate(good.replace('"medium"', '"critical"'), packet).status).toBe("schema_fail");
  });

  it("trusts the inline markers over the model's own citations array", () => {
    // A model listing an id it never used has not actually cited anything.
    const v = validate(good.replace('"citations": ["12345678", "87654321"]', '"citations": []'), packet);
    expect(v.status).toBe("ok");
    expect(v.citations).toContain("12345678");
  });
});

describe("extractJson", () => {
  it("finds an object surrounded by prose", () => {
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });
  it("returns null when there is no object", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("agreement classification", () => {
  it("scores an exact match", () => {
    expect(classify("high", "high", true)).toBe("exact");
  });
  it("scores off-by-one as adjacent", () => {
    expect(classify("medium", "high", true)).toBe("adjacent");
  });
  it("scores low against high as a miss", () => {
    expect(classify("low", "high", true)).toBe("miss");
  });
  it("does not score an enrichment that failed validation", () => {
    // A failed enrichment is a validation failure, not a disagreement; folding
    // it into the agreement denominator would confuse two different problems.
    expect(classify("high", "high", false)).toBe("no_output");
    expect(classify(null, "high", true)).toBe("no_output");
  });
});

describe("KV cache key", () => {
  it("distinguishes scopes that have the same shape but different members", async () => {
    const { cacheKey } = await import("../src/ingest/cfpb");
    // Same count, different members. Keying on length alone would collide and
    // serve pages fetched under the old scope as though they were the new one.
    expect(cacheKey("2026-06-01", ["Credit card"])).not.toBe(
      cacheKey("2026-06-01", ["Mortgage"]),
    );
    expect(cacheKey("2026-06-01", ["Credit card", "Mortgage"])).toBe(
      cacheKey("2026-06-01", ["Mortgage", "Credit card"]),
    );
    expect(cacheKey("2026-06-01", ["Credit card"])).not.toBe(
      cacheKey("2026-06-02", ["Credit card"]),
    );
  });
});
