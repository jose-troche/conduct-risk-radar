#!/usr/bin/env node
/**
 * Drive the rolling-window backfill from outside the Worker.
 *
 * The Workers free tier allows 50 subrequests and 10ms of CPU per invocation,
 * so a 90-day backfill cannot happen in one request - the ingest endpoint does
 * one day per call by design. The cron trigger walks the window a few days at a
 * time on its own, which takes a month of nights to fill; this script does the
 * same walk in a couple of minutes so the deployment has data today.
 *
 * Usage:
 *   node scripts/backfill.mjs <base-url> <admin-token> [days] [concurrency]
 */

const [, , baseArg, token, daysArg = "90", concArg = "4"] = process.argv;
if (!baseArg || !token) {
  console.error("usage: backfill.mjs <base-url> <admin-token> [days] [concurrency]");
  process.exit(1);
}
const base = baseArg.replace(/\/$/, "");
const days = Number(daysArg);
const concurrency = Number(concArg);

const day = (offset) =>
  new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

const queue = Array.from({ length: days }, (_, i) => day(i));
const totals = { upserted: 0, skipped: 0, seen: 0, pages: 0, cacheHits: 0, failed: [] };
let done = 0;

async function ingest(date) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${base}/api/admin/ingest?date=${date}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok || body.status === "error") {
        throw new Error(body.error ?? body.detail ?? body.error_detail ?? JSON.stringify(body).slice(0, 200));
      }
      totals.upserted += body.rows_upserted;
      totals.skipped += body.rows_skipped;
      totals.seen += body.rows_seen;
      totals.pages += body.pages_fetched;
      totals.cacheHits += body.cache_hits;
      done++;
      process.stdout.write(
        `\r${done}/${days} days · ${totals.seen} seen · ${totals.upserted} upserted · ${totals.skipped} unchanged   `,
      );
      return;
    } catch (e) {
      if (attempt === 3) {
        totals.failed.push({ date, error: String(e.message ?? e) });
        done++;
        return;
      }
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
}

async function worker() {
  while (queue.length) {
    const d = queue.shift();
    if (d) await ingest(d);
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`\n\nfinished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`  pages fetched : ${totals.pages} (${totals.cacheHits} served from KV)`);
console.log(`  rows seen     : ${totals.seen}`);
console.log(`  rows upserted : ${totals.upserted}`);
console.log(`  rows unchanged: ${totals.skipped}`);
if (totals.failed.length) {
  console.log(`  FAILED DAYS   : ${totals.failed.length}`);
  for (const f of totals.failed.slice(0, 10)) console.log(`    ${f.date}: ${f.error}`);
  process.exitCode = 1;
}
