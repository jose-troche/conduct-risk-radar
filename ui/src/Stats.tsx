import { useEffect, useState } from "react";
import { api } from "./api";

function Stat({ k, v, s }: { k: string; v: string | number; s?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

export function StatsView() {
  const [d, setD] = useState<any>(null);
  useEffect(() => {
    api.stats().then(setD).catch(() => setD(null));
  }, []);
  if (!d) return <div className="panel muted">Loading…</div>;

  const c = d.coverage;
  const f = d.freshness;
  const e = d.enrichments;

  return (
    <>
      <div className="panel">
        <h2>Coverage</h2>
        <div className="grid3">
          <Stat
            k="Complaints in scope"
            v={c.complaints.toLocaleString()}
            s={`${c.window_days}-day rolling window`}
          />
          <Stat
            k="With a narrative"
            v={`${(c.narrative_share * 100).toFixed(1)}%`}
            s={`${c.with_narrative.toLocaleString()} of ${c.complaints.toLocaleString()} — consent-gated`}
          />
          <Stat
            k="Cells above the volume floor"
            v={c.cells_above_floor}
            s={`of ${c.cells} observed (company × product × issue)`}
          />
        </div>
        <p className="small muted">
          Scope: {c.scoped_companies} institutions across {c.products.length} products (
          {c.products.join(", ")}). This is deliberately not the full database &mdash; D1's
          free-tier limits make full ingestion impossible, and designing around the
          constraint is the honest answer.
        </p>
      </div>

      <div className="panel">
        <h2>Freshness</h2>
        <div className="grid3">
          <Stat k="Most recent complaint" v={f.last_day ?? "—"} s={`oldest on file: ${f.first_day ?? "—"}`} />
          <Stat
            k="Ingest lag"
            v={f.lag_days === null ? "—" : `${f.lag_days}d`}
            s="never zero — the CFPB itself publishes on a delay"
          />
          <Stat k="Window floor" v={f.backfill_floor} s="rows older than this are dropped" />
        </div>
      </div>

      <div className="panel">
        <h2>Alerts and labels</h2>
        <div className="grid3">
          <Stat
            k="Alerts"
            v={Object.values(d.alerts).reduce((a: any, b: any) => a + b, 0) as number}
            s={Object.entries(d.alerts)
              .map(([k, v]) => `${v} ${k}`)
              .join(" · ")}
          />
          <Stat
            k="Dispositions"
            v={d.dispositions.total}
            s={`${d.dispositions.severity_recorded_before_proposal} with severity recorded before the proposal`}
          />
          <Stat
            k="Enrichment validation failures"
            v={
              e.validation_failure_rate === null
                ? "—"
                : `${(e.validation_failure_rate * 100).toFixed(1)}%`
            }
            s={`${e.total} enrichments run`}
          />
        </div>
        {e.total > 0 && (
          <p className="small muted">
            By status:{" "}
            {Object.entries(e.by_validation_status)
              .map(([k, v]) => `${k} ${v}`)
              .join(" · ")}
            . A failed enrichment is recorded with its reason and the alert displays without
            it; the deterministic alert always stands on its own.
          </p>
        )}
      </div>

      <div className="panel">
        <h2>Ingest health</h2>
        <div className="overflow">
          <table className="queue">
            <thead>
              <tr>
                <th>Started</th>
                <th>Window</th>
                <th>Pages</th>
                <th>Cache hits</th>
                <th>Upserted</th>
                <th>Skipped</th>
                <th>Trigger</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.ingest_runs.map((r: any) => (
                <tr key={r.id}>
                  <td className="small">{new Date(r.started_at).toLocaleString()}</td>
                  <td className="small">
                    {r.window_start} → {r.window_end}
                  </td>
                  <td>{r.pages_fetched}</td>
                  <td>{r.cache_hits}</td>
                  <td>{r.rows_upserted}</td>
                  <td>{r.rows_skipped}</td>
                  <td className="small">{r.trigger}</td>
                  <td className="small">
                    <span className={`pill ${r.status === "ok" ? "ok" : "bad"}`}>{r.status}</span>
                    {r.error && <div className="muted small">{r.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Skipped rows are not failures: re-ingesting an unchanged day writes nothing, which
          is what makes the window idempotent.
        </p>
      </div>

      <div className="panel">
        <h2>Detection runs</h2>
        <div className="overflow">
          <table className="queue">
            <thead>
              <tr>
                <th>Started</th>
                <th>Window</th>
                <th>Cells examined</th>
                <th>Cells scored</th>
                <th>Alerts created</th>
                <th>Alerts updated</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.detection_runs.map((r: any) => (
                <tr key={r.id}>
                  <td className="small">{new Date(r.started_at).toLocaleString()}</td>
                  <td className="small">
                    {r.window_start} → {r.window_end}
                  </td>
                  <td>{r.cells_examined}</td>
                  <td>{r.cells_scored}</td>
                  <td>{r.alerts_created}</td>
                  <td>{r.alerts_updated}</td>
                  <td className="small">
                    <span className={`pill ${r.status === "ok" ? "ok" : "bad"}`}>{r.status}</span>
                    {r.error && <div className="muted small">{r.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          "Examined" counts cells with enough window volume; "scored" counts those that also
          cleared the minimum baseline volume. The gap is cells excluded for small-n, not
          cells that scored zero.
        </p>
      </div>
    </>
  );
}
