import type { Env } from "./types";
import { serverError } from "./lib/http";
import { handleApi } from "./api/routes";
import { cronIngest } from "./ingest/run";
import { runDetection } from "./detect/run";

export { EnrichBatch } from "./enrich/batch-do";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const res = await handleApi(request, env, ctx);
      if (res) return res;
    } catch (e) {
      return serverError(e);
    }
    // Anything that is not an API route is the single-page app.
    return env.ASSETS.fetch(request);
  },

  /**
   * Nightly: pull what the source has changed, then re-detect.
   *
   * Detection runs on every cron tick even when ingestion added nothing, because
   * the detection window slides with the data: a cell can cross the alert
   * threshold purely because a quiet day aged out of the baseline.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await cronIngest(env);
        await runDetection(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
