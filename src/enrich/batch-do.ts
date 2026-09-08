import { DurableObject } from "cloudflare:workers";
import { ENRICH } from "../config";
import type { Env } from "../types";
import { enrichAlert, getVariant, loadAlerts } from "./run";

interface BatchEvent {
  type: "started" | "item" | "done" | "error";
  batch_id: string;
  index?: number;
  total?: number;
  alert_id?: string;
  validation_status?: string;
  proposed_severity?: string | null;
  latency_ms?: number | null;
  message?: string;
}

interface BatchState {
  batch_id: string;
  variant_id: string;
  total: number;
  completed: number;
  status: "idle" | "running" | "done" | "error";
  results: BatchEvent[];
  error?: string;
}

const EMPTY: BatchState = {
  batch_id: "",
  variant_id: "",
  total: 0,
  completed: 0,
  status: "idle",
  results: [],
};

/**
 * One Durable Object per enrichment batch.
 *
 * The DO exists to give the UI a live view of a run that takes tens of seconds:
 * a batch of ten alerts is ten sequential model calls, and a progress bar that
 * only moves when the whole thing finishes is not a progress bar. Subscribers
 * attach over SSE and the DO fans each completed item out to all of them.
 *
 * It is SQLite-backed, which is the only Durable Object class the Cloudflare
 * free plan will create.
 */
export class EnrichBatch extends DurableObject<Env> {
  private subscribers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private encoder = new TextEncoder();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/start")) {
      const body = (await request.json()) as {
        batch_id: string;
        alert_ids: string[];
        variant_id: string;
      };
      const state = await this.load();
      if (state.status === "running") {
        return Response.json({ error: "batch already running" }, { status: 409 });
      }
      const next: BatchState = {
        batch_id: body.batch_id,
        variant_id: body.variant_id,
        total: Math.min(body.alert_ids.length, ENRICH.maxBatchSize),
        completed: 0,
        status: "running",
        results: [],
      };
      await this.ctx.storage.put("state", next);
      // Runs past the response. waitUntil keeps the DO alive for the work
      // without making the caller sit through ten model calls.
      this.ctx.waitUntil(this.process(body.alert_ids.slice(0, ENRICH.maxBatchSize), body.variant_id));
      return Response.json({ ok: true, batch_id: body.batch_id, total: next.total });
    }

    if (url.pathname.endsWith("/stream")) {
      return this.subscribe();
    }

    if (url.pathname.endsWith("/status")) {
      return Response.json(await this.load());
    }

    return new Response("not found", { status: 404 });
  }

  private async load(): Promise<BatchState> {
    return ((await this.ctx.storage.get<BatchState>("state")) ?? EMPTY);
  }

  private subscribe(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.subscribers.add(writer);

    // Replay what has already happened, so a client that connects late still
    // sees a complete picture rather than only the tail.
    this.ctx.waitUntil(
      (async () => {
        const state = await this.load();
        for (const ev of state.results) await this.write(writer, ev);
        if (state.status === "done" || state.status === "error") {
          await this.write(writer, {
            type: state.status === "done" ? "done" : "error",
            batch_id: state.batch_id,
            total: state.total,
            message: state.error,
          });
          await writer.close().catch(() => {});
          this.subscribers.delete(writer);
        }
      })(),
    );

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  private async write(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    event: BatchEvent,
  ): Promise<void> {
    try {
      await writer.write(this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    } catch {
      // A disconnected subscriber is normal, not an error worth surfacing.
      this.subscribers.delete(writer);
    }
  }

  private async broadcast(event: BatchEvent): Promise<void> {
    for (const w of [...this.subscribers]) await this.write(w, event);
  }

  private async process(alertIds: string[], variantId: string): Promise<void> {
    const state = await this.load();
    const variant = getVariant(variantId);
    try {
      if (!variant) throw new Error(`unknown variant ${variantId}`);
      const alerts = await loadAlerts(this.env, alertIds);
      // Preserve the caller's ordering rather than whatever the IN clause
      // happened to return.
      const byId = new Map(alerts.map((a) => [a.id, a]));
      const ordered = alertIds.map((id) => byId.get(id)).filter((a) => !!a);

      state.total = ordered.length;
      await this.broadcast({
        type: "started",
        batch_id: state.batch_id,
        total: ordered.length,
      });

      for (let i = 0; i < ordered.length; i++) {
        const alert = ordered[i]!;
        const r = await enrichAlert(this.env, alert, variant, state.batch_id);
        const ev: BatchEvent = {
          type: "item",
          batch_id: state.batch_id,
          index: i + 1,
          total: ordered.length,
          alert_id: alert.id,
          validation_status: r.validation_status,
          proposed_severity: r.proposed_severity,
          latency_ms: r.latency_ms,
          message: r.validation_detail ?? undefined,
        };
        state.completed = i + 1;
        state.results.push(ev);
        await this.ctx.storage.put("state", state);
        await this.broadcast(ev);
      }

      state.status = "done";
      await this.ctx.storage.put("state", state);
      await this.broadcast({ type: "done", batch_id: state.batch_id, total: state.total });
    } catch (e) {
      state.status = "error";
      state.error = e instanceof Error ? e.message : String(e);
      await this.ctx.storage.put("state", state);
      await this.broadcast({ type: "error", batch_id: state.batch_id, message: state.error });
    } finally {
      for (const w of [...this.subscribers]) {
        await w.close().catch(() => {});
        this.subscribers.delete(w);
      }
    }
  }
}
