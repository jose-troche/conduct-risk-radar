#!/usr/bin/env bash
#
# Everything that still needs D1 quota, in the order it has to run.
#
# The build exhausted D1's free-tier daily read AND write budgets: the 160-day
# backfill ran twice (once per scope revision) at five row-writes per complaint,
# before migration 0002 cut that to two. Both budgets reset at midnight UTC.
#
# Run this after the reset. It is idempotent - re-running ingestion writes zero
# rows for days already on file, and detection upserts alerts on
# (cell_key, signal_type) rather than duplicating them.
#
#   ./scripts/finish.sh https://conduct-risk-radar.troche.workers.dev "$(cat .admin-token)"
#
set -euo pipefail

BASE="${1:?usage: finish.sh <base-url> <admin-token>}"
TOKEN="${2:?usage: finish.sh <base-url> <admin-token>}"
AUTH=(-H "authorization: Bearer ${TOKEN}")

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "1/6  Trim the indexes on complaints (5 row-writes per complaint -> 2)"
# Do this FIRST. Every write after it is cheaper, and rebuilding the one
# composite index costs a single pass rather than four.
npx wrangler d1 migrations apply crr-db --remote

step "2/6  Top up the rolling window"
# Only the most recent days are missing; the rest are already on file and will
# report as unchanged, writing nothing.
node scripts/backfill.mjs "$BASE" "$TOKEN" 160 5

step "3/6  Re-run detection"
curl -sS -X POST "${AUTH[@]}" "$BASE/api/admin/detect" | python3 -m json.tool

step "4/6  Enrich the queue with both Workers AI variants"
# Two variants, same labelled set, so the eval has something to compare.
node scripts/enrich.mjs "$BASE" "$TOKEN" v1-workers-ai 3
node scripts/enrich.mjs "$BASE" "$TOKEN" v2-workers-ai-terse 3

step "5/6  Write the seed label set"
# A stated rubric, NOT judgements - see the header of seed-labels.mjs. This
# exists so the eval machinery can be exercised; replace it with labels captured
# through the UI before reporting any agreement number.
node scripts/seed-labels.mjs "$BASE" "$TOKEN" seed-rubric

step "6/6  Run the evaluation against the seed labels"
curl -sS -X POST "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"analyst_id":"seed-rubric","notes":"rubric smoke test, not a result"}' \
  "$BASE/api/eval/runs" | python3 -m json.tool

cat <<'NOTE'

Done. What you have now is the pipeline proven end to end against a rubric.

To get a result rather than a smoke test:
  1. Open the queue and disposition 20-60 alerts yourself. The UI locks your
     severity before it will fetch the model's proposal, so your labels stay
     unanchored.
  2. Re-run the eval filtered to your own reviewer id:
       curl -X POST -H "authorization: Bearer $TOKEN" \
         -H 'content-type: application/json' \
         -d '{"analyst_id":"<your-name>"}' <base>/api/eval/runs
NOTE
