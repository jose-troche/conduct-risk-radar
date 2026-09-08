import {
  DETECTION,
  ENRICH,
  EVAL_GATE,
  SCOPE,
  SIGNAL_LABELS,
  VARIANTS,
  WEIGHTS,
  WEIGHTS_VERSION,
  DEFAULT_VARIANT_ID,
  SEVERITIES,
  isSeedAnalyst,
} from "../config";
import type { AlertRow, Env } from "../types";
import { badRequest, json, newId, notFound } from "../lib/http";
import { addDays, nowIso, today } from "../lib/time";
import { cronIngest, ingestDays, parseDaysParam } from "../ingest/run";
import { runDetection, previewDetection } from "../detect/run";
import { enrichAlert, getVariant, loadAlert } from "../enrich/run";
import { variantAvailable } from "../enrich/providers";
import { runEval } from "../evaluation/run";

/** Admin routes mutate data or spend model budget, so they are token-gated when
 *  ADMIN_TOKEN is set. Read routes are open: everything here is public data. */
function authorised(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return true;
  const header = request.headers.get("authorization") ?? "";
  const url = new URL(request.url);
  return (
    header === `Bearer ${env.ADMIN_TOKEN}` ||
    url.searchParams.get("token") === env.ADMIN_TOKEN
  );
}

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith("/api/")) return null;

  // ---- config -------------------------------------------------------------
  if (path === "/api/config" && method === "GET") {
    return json({
      weights: WEIGHTS,
      weights_version: WEIGHTS_VERSION,
      signal_labels: SIGNAL_LABELS,
      detection: DETECTION,
      scope: SCOPE,
      severities: SEVERITIES,
      eval_gate: EVAL_GATE,
      default_variant: DEFAULT_VARIANT_ID,
      variants: VARIANTS.map((v) => ({
        id: v.id,
        label: v.label,
        model: v.model,
        provider: v.provider,
        prompt_style: v.promptStyle,
        description: v.description,
        available: variantAvailable(env, v),
      })),
    });
  }

  // ---- alerts -------------------------------------------------------------
  if (path === "/api/alerts" && method === "GET") {
    const status = url.searchParams.get("status");
    const company = url.searchParams.get("company");
    const product = url.searchParams.get("product");
    const signal = url.searchParams.get("signal");
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
    const cursor = url.searchParams.get("cursor");

    const where: string[] = [];
    const binds: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      binds.push(value);
      where.push(clause.replace("?", `?${binds.length}`));
    };
    if (status && status !== "all") add("a.status = ?", status);
    if (company) add("a.company = ?", company);
    if (product) add("a.product = ?", product);
    if (signal) add("a.signal_type = ?", signal);
    // Keyset pagination on (score, id): stable under concurrent detection runs
    // in a way that OFFSET is not.
    if (cursor) {
      const [cScore, cId] = cursor.split("|");
      binds.push(Number(cScore));
      binds.push(cId);
      where.push(`(a.score < ?${binds.length - 1} OR (a.score = ?${binds.length - 1} AND a.id > ?${binds.length}))`);
    }
    binds.push(limit);

    const sql = `
SELECT a.*,
  (SELECT COUNT(*) FROM dispositions d WHERE d.alert_id = a.id) AS disposition_count,
  (SELECT e.validation_status FROM enrichments e WHERE e.alert_id = a.id
     ORDER BY e.created_at DESC LIMIT 1) AS latest_enrichment_status
FROM alerts a
${where.length ? `WHERE ${where.join(" AND ")}` : ""}
ORDER BY a.score DESC, a.id ASC
LIMIT ?${binds.length}`;

    const rows = await env.DB.prepare(sql).bind(...binds).all<AlertRow & { disposition_count: number }>();
    const items = rows.results.map(shapeAlert);
    const last = rows.results.at(-1);
    return json({
      items,
      next_cursor: rows.results.length === limit && last ? `${last.score}|${last.id}` : null,
    });
  }

  const alertMatch = path.match(/^\/api\/alerts\/([^/]+)$/);
  if (alertMatch && method === "GET") {
    const alert = await loadAlert(env, alertMatch[1]!);
    if (!alert) return notFound("alert not found");
    const ids: string[] = JSON.parse(alert.driver_complaint_ids_json || "[]");
    const drivers = ids.length
      ? (
          await env.DB.prepare(
            `SELECT complaint_id, date_received, product, sub_product, issue, sub_issue,
                    state, company_response, timely_response, has_narrative, narrative
             FROM complaints WHERE complaint_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
             ORDER BY has_narrative DESC, date_received DESC`,
          )
            .bind(...ids)
            .all()
        ).results
      : [];

    /**
     * The model's proposal is withheld unless the caller explicitly asks to
     * reveal it. This is the propose-then-reveal requirement enforced at the
     * transport layer rather than by hiding a div: if the proposed severity
     * never reaches the browser before the analyst commits, the agreement
     * number cannot be measuring anchoring. The UI asks for reveal=1 only
     * after the analyst's own severity has been locked.
     */
    const reveal = url.searchParams.get("reveal") === "1";
    const enrichments = reveal
      ? (
          await env.DB.prepare(
            `SELECT id, variant_id, model, prompt_version, summary, proposed_severity,
                    reasoning, citations_json, signals_referenced_json, validation_status,
                    validation_detail, cost_usd, latency_ms, created_at
             FROM enrichments WHERE alert_id = ?1 ORDER BY created_at DESC`,
          )
            .bind(alert.id)
            .all()
        ).results
      : [];

    // Whether a draft exists is not itself a spoiler, and the UI needs it to
    // decide what to offer.
    const enrichmentAvailable = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM enrichments WHERE alert_id = ?1`,
    )
      .bind(alert.id)
      .first<{ c: number }>();

    const dispositions = (
      await env.DB.prepare(
        `SELECT id, action, analyst_severity, reason, analyst_id,
                enrichment_shown_after, created_at
         FROM dispositions WHERE alert_id = ?1 ORDER BY created_at DESC`,
      )
        .bind(alert.id)
        .all()
    ).results;

    return json({
      alert: shapeAlert(alert),
      drivers,
      enrichments,
      enrichment_revealed: reveal,
      enrichment_count: enrichmentAvailable?.c ?? 0,
      dispositions,
      /** Narrative coverage is partial by design; the UI must not bury it. */
      coverage: {
        window_complaints: alert.window_n,
        window_with_narrative: alert.window_narrative_n,
        drivers_returned: drivers.length,
        drivers_with_narrative: drivers.filter((d) => (d as { has_narrative: number }).has_narrative === 1).length,
      },
    });
  }

  // ---- disposition --------------------------------------------------------
  const dispMatch = path.match(/^\/api\/alerts\/([^/]+)\/disposition$/);
  if (dispMatch && method === "POST") {
    const alertId = dispMatch[1]!;
    const body = (await request.json().catch(() => null)) as {
      action?: string;
      analyst_severity?: string;
      reason?: string;
      analyst_id?: string;
      enrichment_shown_after?: boolean;
    } | null;
    if (!body) return badRequest("body must be JSON");

    if (!["escalate", "monitor", "dismiss"].includes(body.action ?? "")) {
      return badRequest("action must be escalate, monitor or dismiss");
    }
    if (!(SEVERITIES as readonly string[]).includes(body.analyst_severity ?? "")) {
      return badRequest("analyst_severity must be low, medium or high");
    }
    if (!body.reason || body.reason.trim().length < 3) {
      return badRequest("reason is required");
    }
    const alert = await loadAlert(env, alertId);
    if (!alert) return notFound("alert not found");

    const enrichmentExisted = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM enrichments WHERE alert_id = ?1 AND validation_status = 'ok'`,
    )
      .bind(alertId)
      .first<{ c: number }>();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dispositions (id, alert_id, action, analyst_severity, reason,
           analyst_id, enrichment_shown_after, enrichment_existed, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      ).bind(
        newId("dsp"),
        alertId,
        body.action,
        body.analyst_severity,
        body.reason.trim(),
        body.analyst_id?.trim() || "analyst",
        // The client asserts that severity was locked before the proposal was
        // revealed. The UI enforces it; this flag records it, and the eval
        // refuses to score any label where it is false.
        body.enrichment_shown_after === false ? 0 : 1,
        (enrichmentExisted?.c ?? 0) > 0 ? 1 : 0,
        nowIso(),
      ),
      env.DB.prepare(`UPDATE alerts SET status='dispositioned' WHERE id=?1`).bind(alertId),
    ]);

    return json({ ok: true });
  }

  // ---- complaints ---------------------------------------------------------
  const complaintMatch = path.match(/^\/api\/complaints\/([^/]+)$/);
  if (complaintMatch && method === "GET") {
    const row = await env.DB.prepare(
      `SELECT * FROM complaints WHERE complaint_id = ?1`,
    )
      .bind(complaintMatch[1]!)
      .first();
    return row ? json(row) : notFound("complaint not found");
  }

  // ---- enrichment ---------------------------------------------------------
  if (path === "/api/enrich" && method === "POST") {
    if (!authorised(request, env)) return json({ error: "unauthorised" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as {
      alert_ids?: string[];
      variant_id?: string;
    } | null;
    const alertIds = body?.alert_ids ?? [];
    if (alertIds.length === 0) return badRequest("alert_ids is required");
    const variantId = body?.variant_id ?? DEFAULT_VARIANT_ID;
    const variant = getVariant(variantId);
    if (!variant) return badRequest(`unknown variant ${variantId}`);
    if (!variantAvailable(env, variant)) {
      return badRequest(`variant ${variantId} is not available in this deployment`);
    }

    const batchId = newId("bat");
    const stub = env.ENRICH_BATCH.get(env.ENRICH_BATCH.idFromName(batchId));
    const res = await stub.fetch("https://do/start", {
      method: "POST",
      body: JSON.stringify({
        batch_id: batchId,
        alert_ids: alertIds.slice(0, ENRICH.maxBatchSize),
        variant_id: variantId,
      }),
    });
    if (!res.ok) return json({ error: await res.text() }, { status: res.status });
    return json({
      batch_id: batchId,
      total: Math.min(alertIds.length, ENRICH.maxBatchSize),
      stream: `/api/enrich/${batchId}/stream`,
    });
  }

  const streamMatch = path.match(/^\/api\/enrich\/([^/]+)\/(stream|status)$/);
  if (streamMatch && method === "GET") {
    const stub = env.ENRICH_BATCH.get(env.ENRICH_BATCH.idFromName(streamMatch[1]!));
    return stub.fetch(`https://do/${streamMatch[2]}`);
  }

  // ---- eval ---------------------------------------------------------------
  if (path === "/api/eval/runs" && method === "POST") {
    if (!authorised(request, env)) return json({ error: "unauthorised" }, { status: 401 });
    const body = (await request.json().catch(() => ({}))) as {
      variant_ids?: string[];
      label_set_version?: string;
      notes?: string;
      analyst_id?: string;
    };
    const variantIds =
      body.variant_ids && body.variant_ids.length > 0
        ? body.variant_ids
        : VARIANTS.filter((v) => variantAvailable(env, v)).map((v) => v.id);
    const result = await runEval(
      env,
      variantIds,
      body.label_set_version ?? today(),
      body.notes ?? null,
      body.analyst_id?.trim() || null,
    );
    return json(result);
  }

  if (path === "/api/eval/runs" && method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, label_set_version, variant_ids_json, started_at, finished_at,
              label_count, status, notes, analyst_filter, reviewers_json
       FROM eval_runs ORDER BY started_at DESC LIMIT 25`,
    ).all();
    return json({ items: rows.results });
  }

  const evalMatch = path.match(/^\/api\/eval\/runs\/([^/]+)$/);
  if (evalMatch && method === "GET") {
    const row = await env.DB.prepare(`SELECT * FROM eval_runs WHERE id = ?1`)
      .bind(evalMatch[1]!)
      .first<{
        results_json: string | null;
        gate_verdict_json: string | null;
        reviewers_json: string | null;
      }>();
    if (!row) return notFound("eval run not found");
    const reviewers = row.reviewers_json ? JSON.parse(row.reviewers_json) : [];
    return json({
      ...row,
      results: row.results_json ? JSON.parse(row.results_json) : null,
      gate: row.gate_verdict_json ? JSON.parse(row.gate_verdict_json) : null,
      reviewers,
      contains_seed_labels: (reviewers as { is_seed: boolean }[]).some((r) => r.is_seed),
    });
  }

  // ---- stats --------------------------------------------------------------
  if (path === "/api/stats" && method === "GET") {
    return json(await stats(env));
  }

  // ---- admin --------------------------------------------------------------
  if (path === "/api/admin/ingest" && method === "POST") {
    if (!authorised(request, env)) return json({ error: "unauthorised" }, { status: 401 });
    const days = parseDaysParam(url);
    const result = days ? await ingestDays(env, days) : await cronIngest(env);
    return json(result);
  }

  if (path === "/api/admin/detect" && method === "POST") {
    if (!authorised(request, env)) return json({ error: "unauthorised" }, { status: 401 });
    // preview scores every cell and writes nothing, so thresholds can be set
    // against the real distribution instead of a guess about it.
    if (url.searchParams.get("preview") === "1") {
      return json(
        await previewDetection(
          env,
          url.searchParams.get("as_of"),
          Number(url.searchParams.get("top") ?? 25),
        ),
      );
    }
    return json(await runDetection(env, url.searchParams.get("as_of")));
  }

  /**
   * Enrich synchronously, one alert at a time. The batch endpoint is what the
   * UI uses; this is what the eval harness uses, because it needs to know the
   * call finished before it scores anything.
   */
  if (path === "/api/admin/enrich-one" && method === "POST") {
    if (!authorised(request, env)) return json({ error: "unauthorised" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as {
      alert_id?: string;
      variant_id?: string;
    } | null;
    if (!body?.alert_id) return badRequest("alert_id is required");
    const variant = getVariant(body.variant_id ?? DEFAULT_VARIANT_ID);
    if (!variant) return badRequest("unknown variant");
    const alert = await loadAlert(env, body.alert_id);
    if (!alert) return notFound("alert not found");
    return json(await enrichAlert(env, alert, variant));
  }

  return notFound("no such route");
}

function shapeAlert(a: AlertRow & { disposition_count?: number }) {
  return {
    ...a,
    signals: JSON.parse(a.signals_json),
    driver_complaint_ids: JSON.parse(a.driver_complaint_ids_json || "[]"),
    signals_json: undefined,
    driver_complaint_ids_json: undefined,
  };
}

async function stats(env: Env) {
  const res = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS complaints, SUM(has_narrative) AS with_narrative,
              MIN(date_received) AS first_day, MAX(date_received) AS last_day,
              COUNT(DISTINCT company) AS companies, COUNT(DISTINCT cell_key) AS cells
       FROM complaints`,
    ),
    env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM alerts GROUP BY status`,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS dispositions,
              SUM(CASE WHEN enrichment_shown_after = 1 THEN 1 ELSE 0 END) AS unanchored
       FROM dispositions`,
    ),
    env.DB.prepare(
      `SELECT analyst_id, COUNT(*) AS c FROM dispositions GROUP BY analyst_id`,
    ),
    env.DB.prepare(
      `SELECT validation_status, COUNT(*) AS c FROM enrichments GROUP BY validation_status`,
    ),
    env.DB.prepare(
      `SELECT id, started_at, finished_at, status, rows_upserted, rows_skipped,
              pages_fetched, cache_hits, window_start, window_end, trigger, error
       FROM ingest_runs ORDER BY started_at DESC LIMIT 5`,
    ),
    env.DB.prepare(
      `SELECT id, started_at, finished_at, status, cells_examined, cells_scored,
              alerts_created, alerts_updated, window_start, window_end, error
       FROM detection_runs ORDER BY started_at DESC LIMIT 5`,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS scored_cells FROM baselines WHERE n >= ${DETECTION.minBaselineVolume}`,
    ),
  ]);

  const c = res[0].results[0] as Record<string, number | string | null>;
  const lastDay = (c.last_day as string | null) ?? null;

  const alertStatus: Record<string, number> = {};
  for (const r of res[1].results as { status: string; c: number }[]) alertStatus[r.status] = r.c;

  const reviewers = (res[3].results as { analyst_id: string; c: number }[]).map((r) => ({
    analyst_id: r.analyst_id,
    labels: r.c,
    is_seed: isSeedAnalyst(r.analyst_id),
  }));

  const validation: Record<string, number> = {};
  let enrichTotal = 0;
  for (const r of res[4].results as { validation_status: string; c: number }[]) {
    validation[r.validation_status] = r.c;
    enrichTotal += r.c;
  }
  const okCount = validation.ok ?? 0;

  const disp = res[2].results[0] as { dispositions: number; unanchored: number | null };

  return {
    coverage: {
      complaints: Number(c.complaints ?? 0),
      with_narrative: Number(c.with_narrative ?? 0),
      narrative_share:
        Number(c.complaints ?? 0) > 0
          ? Number(c.with_narrative ?? 0) / Number(c.complaints ?? 1)
          : 0,
      companies: Number(c.companies ?? 0),
      cells: Number(c.cells ?? 0),
      cells_above_floor: Number(
        (res[7].results[0] as { scored_cells: number }).scored_cells ?? 0,
      ),
      window_days: SCOPE.windowDays,
      products: SCOPE.products,
      scoped_companies: SCOPE.companies.length,
    },
    freshness: {
      first_day: c.first_day,
      last_day: lastDay,
      // Lag between the newest complaint on file and now. This is the honest
      // freshness number: the CFPB itself publishes on a delay, so this will
      // never be zero.
      lag_days: lastDay ? Math.max(0, Math.round((Date.parse(today()) - Date.parse(lastDay)) / 86400000)) : null,
      backfill_floor: addDays(today(), -SCOPE.windowDays),
    },
    alerts: alertStatus,
    dispositions: {
      total: Number(disp?.dispositions ?? 0),
      severity_recorded_before_proposal: Number(disp?.unanchored ?? 0),
      reviewers,
      // Seed labels come from a stated rubric, not a person. Reported here so
      // the coverage page can never imply a human sat in the queue when none did.
      human_labels: reviewers.filter((r) => !r.is_seed).reduce((t, r) => t + r.labels, 0),
      seed_labels: reviewers.filter((r) => r.is_seed).reduce((t, r) => t + r.labels, 0),
    },
    enrichments: {
      total: enrichTotal,
      by_validation_status: validation,
      validation_failure_rate: enrichTotal > 0 ? 1 - okCount / enrichTotal : null,
    },
    ingest_runs: res[5].results,
    detection_runs: res[6].results,
  };
}
