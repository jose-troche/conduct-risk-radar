import { useEffect, useState } from "react";
import { api } from "./api";

const SEV = ["low", "medium", "high"];

function rate(v: number | null) {
  return v === null ? "—" : `${(v * 100).toFixed(0)}%`;
}

function Confusion({ m }: { m: Record<string, Record<string, number>> }) {
  const cols = [...SEV, "no_output"];
  return (
    <div className="overflow">
      <table className="matrix">
        <thead>
          <tr>
            <th>human \ proposed</th>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SEV.map((h) => (
            <tr key={h}>
              <th>{h}</th>
              {cols.map((p) => (
                <td key={p} className={h === p ? "diag" : ""}>
                  {m[h]?.[p] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvalView({ config, token }: { config: any; token: string }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [current, setCurrent] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = () => api.evalRuns().then((r) => setRuns(r.items)).catch(() => {});
  useEffect(() => {
    loadRuns();
  }, []);

  const open = async (id: string) => {
    const r = await api.evalRun(id);
    setCurrent(r);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = (config?.variants ?? []).filter((v: any) => v.available).map((v: any) => v.id);
      const r = await api.runEval(ids, token);
      setCurrent({ ...r, results: r.variants, gate: r.gate });
      loadRuns();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const g = config?.eval_gate;
  const variants = current?.results ?? [];

  return (
    <>
      <div className="panel">
        <h2>Evaluation</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          This reports <strong>agreement</strong>, not accuracy. There is no ground truth in
          this data beyond the reviewer, and calling it accuracy would claim one. It measures
          consistency with a single reviewer's triage judgement. Only dispositions where the
          severity was recorded before the model's proposal was revealed are scored.
        </p>
        <div className="filters">
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? "Running…" : "Run evaluation on all available variants"}
          </button>
          {runs.length > 0 && (
            <select
              onChange={(e) => e.target.value && open(e.target.value)}
              defaultValue=""
            >
              <option value="">Load a previous run…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.started_at).toLocaleString()} · {r.label_count} labels
                </option>
              ))}
            </select>
          )}
        </div>
        {error && <p className="small" style={{ color: "var(--high)" }}>{error}</p>}
        {g && (
          <p className="small muted">
            Ship gate: a variant ships only if it clears <strong>every</strong> gated segment
            &mdash; exact agreement ≥ {g.minExactAgreement * 100}%, adjacent ≥{" "}
            {g.minAdjacentAgreement * 100}%, validation failures ≤{" "}
            {g.maxValidationFailure * 100}%. Segments with fewer than {g.minSegmentSize}{" "}
            labels are reported but not gated. A variant that lifts the mean while collapsing
            on one product is a regression.
          </p>
        )}
      </div>

      {current && (
        <div className="panel">
          <h2>
            Labels: {current.label_count ?? current.results?.[0]?.n ?? 0}
          </h2>
          {(current.label_count ?? 0) < 20 && (
            <p className="small" style={{ color: "var(--medium)" }}>
              Fewer than 20 labels. Every number below is directional at best.
            </p>
          )}
        </div>
      )}

      {variants.map((v: any) => (
        <div className="panel" key={v.variant_id}>
          <h3>
            {v.label}{" "}
            <span className={`pill ${v.gate?.ships ? "ok" : "bad"}`}>
              {v.gate?.ships ? "ships" : "blocked"}
            </span>
          </h3>
          <div className="grid3" style={{ marginBottom: 14 }}>
            <div className="stat">
              <div className="k">Exact agreement</div>
              <div className="v">{rate(v.exact_rate)}</div>
              <div className="s">{v.n_scored} scored of {v.n} labels</div>
            </div>
            <div className="stat">
              <div className="k">Adjacent (off-by-one)</div>
              <div className="v">{rate(v.adjacent_rate)}</div>
              <div className="s">exact or one level away</div>
            </div>
            <div className="stat">
              <div className="k">Validation failures</div>
              <div className="v">{rate(v.validation_failure_rate)}</div>
              <div className="s">
                {Object.entries(v.validation_status_counts ?? {})
                  .map(([k, c]) => `${k} ${c}`)
                  .join(" · ")}
              </div>
            </div>
            <div className="stat">
              <div className="k">Cost per enrichment</div>
              <div className="v">
                {v.cost_usd_per_enrichment != null
                  ? `$${v.cost_usd_per_enrichment.toFixed(6)}`
                  : "—"}
              </div>
              <div className="s">${(v.cost_usd_total ?? 0).toFixed(5)} total</div>
            </div>
            <div className="stat">
              <div className="k">Latency p50</div>
              <div className="v">{v.latency_p50_ms ?? "—"}ms</div>
              <div className="s">p95 {v.latency_p95_ms ?? "—"}ms</div>
            </div>
            <div className="stat">
              <div className="k">Blocking segments</div>
              <div className="v">{v.gate?.blocking_segments?.length ?? 0}</div>
              <div className="s">{v.gate?.blocking_segments?.join(", ") || "none"}</div>
            </div>
          </div>

          <h3>Confusion: human severity × proposed severity</h3>
          <Confusion m={v.confusion} />

          <h3 style={{ marginTop: 16 }}>Per segment</h3>
          <div className="overflow">
            <table className="sigtable">
              <thead>
                <tr>
                  <th>Segment</th>
                  <th>Value</th>
                  <th className="num">n</th>
                  <th className="num">Scored</th>
                  <th className="num">Exact</th>
                  <th className="num">Adjacent</th>
                  <th className="num">Val. failures</th>
                  <th>Gate</th>
                </tr>
              </thead>
              <tbody>
                {v.segments.map((s: any) => (
                  <tr key={`${s.segment}-${s.value}`} className={s.gated ? "" : "dim"}>
                    <td className="small">{s.segment}</td>
                    <td className="small">{s.value}</td>
                    <td className="num">{s.n}</td>
                    <td className="num">{s.n_scored}</td>
                    <td className="num">{rate(s.exact_rate)}</td>
                    <td className="num">{rate(s.adjacent_rate)}</td>
                    <td className="num">{rate(s.validation_failure_rate)}</td>
                    <td className="small">
                      {s.passes === null ? (
                        <span className="muted">not gated (n &lt; floor)</span>
                      ) : s.passes ? (
                        <span className="pill ok">pass</span>
                      ) : (
                        <>
                          <span className="pill bad">fail</span>
                          <div className="muted small">{s.failures.join("; ")}</div>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {current && variants.length === 0 && (
        <div className="panel muted small">
          This run scored no variants. Enrich some dispositioned alerts first.
        </div>
      )}
    </>
  );
}
