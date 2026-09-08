#!/usr/bin/env node
/**
 * Produce a SEED label set, so the eval, the per-segment breakdown and the ship
 * gate can be exercised end to end before a human has sat in the queue.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE QUOTING ANY NUMBER COMPUTED AGAINST THESE LABELS.
 *
 * These are not judgements. They are a stated rubric, applied mechanically to
 * the same computed signals the model is shown. An agreement number measured
 * against them therefore tells you whether the model reproduces a rubric - it
 * is a smoke test of the eval machinery, and it is not a result. It cannot tell
 * you whether the system agrees with a person, because no person was involved.
 *
 * The spec is explicit that dispositions are a human's triage judgements, and
 * that agreement is agreement with one reviewer. Replace these with real labels
 * captured through the UI (which enforces propose-then-reveal) before reporting
 * anything. The eval filters by reviewer, so both sets can coexist:
 *
 *   POST /api/eval/runs { "analyst_id": "your-name" }     ← human labels only
 *   POST /api/eval/runs { "analyst_id": "seed-rubric" }   ← this rubric only
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The rubric, stated so it can be argued with:
 *
 *   high    score >= 45, or a cell whose window volume more than doubled its
 *           baseline rate while its response mix also moved against consumers
 *   medium  score >= 30, or any cell whose dominant signal is emerging_issue
 *   low     everything else
 *
 * Action follows severity: high -> escalate, medium -> monitor, low -> dismiss.
 *
 * The script fetches each alert WITHOUT reveal=1, so it never sees a model
 * proposal - the same guarantee the UI gives a human. That is what makes the
 * enrichment_shown_after flag truthful for these rows.
 *
 * Usage:
 *   node scripts/seed-labels.mjs <base-url> <admin-token> [analyst-id]
 */

const [, , baseArg, token, analystArg = "seed-rubric"] = process.argv;
if (!baseArg || !token) {
  console.error("usage: seed-labels.mjs <base-url> <admin-token> [analyst-id]");
  process.exit(1);
}
if (!analystArg.startsWith("seed-")) {
  console.error(
    `analyst id must start with "seed-" so the eval can tell rubric labels from human ones; got "${analystArg}"`,
  );
  process.exit(1);
}
const base = baseArg.replace(/\/$/, "");

const signal = (alert, type) => alert.signals.find((s) => s.type === type);

function rubric(alert) {
  const volume = signal(alert, "volume_anomaly");
  const mix = signal(alert, "response_mix_drift");
  const doubled = (volume?.normalized ?? 0) >= 60;
  const mixWorsened = (mix?.normalized ?? 0) >= 50;

  if (alert.score >= 45 || (doubled && mixWorsened)) {
    return {
      severity: "high",
      action: "escalate",
      reason:
        `Seed rubric: priority ${alert.score.toFixed(1)} with ${alert.window_n} complaints ` +
        `against a baseline of ${alert.baseline_n}; dominant signal ${alert.signal_type}` +
        (doubled && mixWorsened ? ", volume and response mix both moved against consumers." : "."),
    };
  }
  if (alert.score >= 30 || alert.signal_type === "emerging_issue") {
    return {
      severity: "medium",
      action: "monitor",
      reason:
        `Seed rubric: priority ${alert.score.toFixed(1)}, dominant signal ${alert.signal_type}. ` +
        `Worth watching but not above the escalation band.`,
    };
  }
  return {
    severity: "low",
    action: "dismiss",
    reason:
      `Seed rubric: priority ${alert.score.toFixed(1)} sits in the lower band; ` +
      `${alert.window_n} complaints against a baseline of ${alert.baseline_n}.`,
  };
}

const { items } = await (await fetch(`${base}/api/alerts?status=all&limit=200`)).json();
console.log(`${items.length} alerts in the queue`);

const counts = {};
let done = 0;
const failures = [];

for (const alert of items) {
  // Fetched without reveal=1 on purpose: the rubric must not be able to see a
  // model proposal, for the same reason a human must not.
  const detail = await (await fetch(`${base}/api/alerts/${alert.id}`)).json();
  if (detail.enrichment_revealed) {
    console.error("refusing to label: the API revealed an enrichment");
    process.exit(1);
  }

  const { severity, action, reason } = rubric(alert);
  const res = await fetch(`${base}/api/alerts/${alert.id}/disposition`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      action,
      analyst_severity: severity,
      reason,
      analyst_id: analystArg,
      enrichment_shown_after: true,
    }),
  });
  if (!res.ok) {
    failures.push(`${alert.id}: ${(await res.text()).slice(0, 120)}`);
  } else {
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  done++;
  process.stdout.write(`\r${done}/${items.length}   `);
}

console.log(`\n\nseed labels written as "${analystArg}"`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(8)} ${v}`);
if (failures.length) {
  console.log(`  failed: ${failures.length}`);
  for (const f of failures.slice(0, 5)) console.log(`    ${f}`);
}
console.log(
  `\nThese are rubric labels, not judgements. Run the eval against them to check the\n` +
    `machinery, then replace them with labels captured through the UI before reporting.`,
);
