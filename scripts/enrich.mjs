#!/usr/bin/env node
/**
 * Run one variant across every alert at or above the enrichment threshold.
 *
 * The UI drives enrichment through the Durable Object batch endpoint, which
 * caps at 10 alerts so a single invocation stays inside the free tier's 50
 * subrequests. The eval harness needs something different: it has to know each
 * call finished before it scores anything, so it drives the synchronous
 * per-alert endpoint instead and reports the validation outcome of each.
 *
 * Usage:
 *   node scripts/enrich.mjs <base-url> <admin-token> <variant-id> [concurrency]
 */

const [, , baseArg, token, variantId, concArg = "3"] = process.argv;
if (!baseArg || !token || !variantId) {
  console.error("usage: enrich.mjs <base-url> <admin-token> <variant-id> [concurrency]");
  process.exit(1);
}
const base = baseArg.replace(/\/$/, "");
const concurrency = Number(concArg);

const cfg = await (await fetch(`${base}/api/config`)).json();
const threshold = cfg.detection.enrichThreshold;

const { items } = await (
  await fetch(`${base}/api/alerts?status=all&limit=200`)
).json();
const targets = items.filter((a) => a.score >= threshold);

console.log(
  `${targets.length} alerts at or above the enrichment threshold of ${threshold}; variant ${variantId}`,
);

const queue = [...targets];
const outcomes = [];
let done = 0;

async function one(alert) {
  try {
    const res = await fetch(`${base}/api/admin/enrich-one`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ alert_id: alert.id, variant_id: variantId }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
    outcomes.push(body);
    done++;
    process.stdout.write(
      `\r${done}/${targets.length}  last: ${body.validation_status}${
        body.proposed_severity ? ` (${body.proposed_severity})` : ""
      }        `,
    );
  } catch (e) {
    done++;
    outcomes.push({ validation_status: "transport_error", validation_detail: String(e.message ?? e) });
  }
}

async function worker() {
  while (queue.length) {
    const a = queue.shift();
    if (a) await one(a);
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, worker));

const byStatus = {};
let cost = 0;
const latencies = [];
for (const o of outcomes) {
  byStatus[o.validation_status] = (byStatus[o.validation_status] ?? 0) + 1;
  if (o.cost_usd) cost += o.cost_usd;
  if (o.latency_ms) latencies.push(o.latency_ms);
}
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))];

console.log(`\n\n${variantId}: ${outcomes.length} enrichments in ${((Date.now() - started) / 1000).toFixed(0)}s`);
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${v}`);
}
const ok = byStatus.ok ?? 0;
console.log(`  validation failure rate: ${(((outcomes.length - ok) / outcomes.length) * 100).toFixed(1)}%`);
console.log(`  cost: $${cost.toFixed(5)} total, $${(cost / Math.max(1, outcomes.length)).toFixed(6)} each`);
console.log(`  latency: p50 ${pct(50)}ms, p95 ${pct(95)}ms`);

const failures = outcomes.filter((o) => o.validation_status !== "ok").slice(0, 8);
if (failures.length) {
  console.log(`\n  sample failures:`);
  for (const f of failures) console.log(`    ${f.validation_status}: ${String(f.validation_detail).slice(0, 150)}`);
}
