import { useEffect, useState } from "react";
import { api, type Alert } from "./api";

export function Score({ score }: { score: number }) {
  return (
    <div className="scorecell">
      <span className="scorenum">{score.toFixed(0)}</span>
      <span className="scorebar">
        <i style={{ width: `${Math.min(100, score)}%` }} />
      </span>
    </div>
  );
}

export function Queue({
  config,
  token,
  setToken,
}: {
  config: any;
  token: string;
  setToken: (t: string) => void;
}) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("open");
  const [company, setCompany] = useState("");
  const [product, setProduct] = useState("");
  const [signal, setSignal] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [variant, setVariant] = useState("");
  const [progress, setProgress] = useState<string[]>([]);
  const [enriching, setEnriching] = useState(false);

  useEffect(() => {
    if (config?.default_variant && !variant) setVariant(config.default_variant);
  }, [config]);

  const load = () => {
    setLoading(true);
    const params: Record<string, string> = { status, limit: "100" };
    if (company) params.company = company;
    if (product) params.product = product;
    if (signal) params.signal = signal;
    api
      .alerts(params)
      .then((r) => {
        setAlerts(r.items);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [status, company, product, signal]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  /**
   * Enrichment runs as a Durable Object batch and reports progress over SSE.
   * A batch of ten alerts is ten sequential model calls, so a bar that only
   * moves at the end would not be telling anyone anything.
   */
  const enrich = async () => {
    setEnriching(true);
    setProgress([]);
    try {
      const { batch_id } = await api.enrich([...selected], variant, token);
      const es = new EventSource(`/api/enrich/${batch_id}/stream`);
      es.onmessage = (ev) => {
        const d = JSON.parse(ev.data);
        if (d.type === "started") setProgress((p) => [...p, `starting ${d.total} enrichments`]);
        if (d.type === "item")
          setProgress((p) => [
            ...p,
            `${d.index}/${d.total}  ${d.alert_id}  ${d.validation_status}${
              d.proposed_severity ? ` (${d.proposed_severity})` : ""
            }  ${d.latency_ms ?? "?"}ms${d.message ? `  - ${d.message}` : ""}`,
          ]);
        if (d.type === "done" || d.type === "error") {
          setProgress((p) => [...p, d.type === "done" ? "done" : `error: ${d.message}`]);
          es.close();
          setEnriching(false);
          setSelected(new Set());
          load();
        }
      };
      es.onerror = () => {
        es.close();
        setEnriching(false);
        load();
      };
    } catch (e) {
      setProgress([`error: ${(e as Error).message}`]);
      setEnriching(false);
    }
  };

  const companies = [...new Set(alerts.map((a) => a.company))].sort();
  const threshold = config?.detection?.enrichThreshold ?? 45;

  return (
    <>
      <div className="panel">
        <h2>Triage queue</h2>
        <div className="filters">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="dispositioned">Dispositioned</option>
            <option value="stale">Stale</option>
            <option value="all">All</option>
          </select>
          <select value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All institutions</option>
            {companies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select value={product} onChange={(e) => setProduct(e.target.value)}>
            <option value="">All products</option>
            {(config?.scope?.products ?? []).map((p: string) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select value={signal} onChange={(e) => setSignal(e.target.value)}>
            <option value="">All dominant signals</option>
            {Object.entries(config?.signal_labels ?? {}).map(([k, v]) => (
              <option key={k} value={k}>
                {v as string}
              </option>
            ))}
          </select>
          <span className="muted small">
            {loading ? "loading…" : `${alerts.length} alerts`}
          </span>
        </div>

        {error && <p className="small" style={{ color: "var(--high)" }}>{error}</p>}

        <div className="overflow">
          <table className="queue">
            <thead>
              <tr>
                <th />
                <th>Priority</th>
                <th>Institution</th>
                <th>Product / issue</th>
                <th>Dominant signal</th>
                <th>Window</th>
                <th>Narrative</th>
                <th>Draft</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className="row">
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      disabled={a.score < threshold}
                      title={
                        a.score < threshold
                          ? `Below the enrichment threshold of ${threshold}`
                          : "Select for enrichment"
                      }
                      onChange={() => toggle(a.id)}
                    />
                  </td>
                  <td onClick={() => (location.hash = `/alert/${a.id}`)}>
                    <Score score={a.score} />
                  </td>
                  <td className="co" onClick={() => (location.hash = `/alert/${a.id}`)}>
                    {a.company}
                  </td>
                  <td onClick={() => (location.hash = `/alert/${a.id}`)}>
                    <div>{a.product}</div>
                    <div className="muted small">{a.issue}</div>
                  </td>
                  <td onClick={() => (location.hash = `/alert/${a.id}`)}>
                    <span className="pill">
                      {config?.signal_labels?.[a.signal_type] ?? a.signal_type}
                    </span>
                  </td>
                  <td className="small muted" onClick={() => (location.hash = `/alert/${a.id}`)}>
                    {a.window_n} vs {a.baseline_n} baseline
                  </td>
                  <td className="small muted" onClick={() => (location.hash = `/alert/${a.id}`)}>
                    {a.window_narrative_n}/{a.window_n}
                  </td>
                  <td className="small" onClick={() => (location.hash = `/alert/${a.id}`)}>
                    {a.latest_enrichment_status ? (
                      <span
                        className={`pill ${a.latest_enrichment_status === "ok" ? "ok" : "bad"}`}
                      >
                        {a.latest_enrichment_status}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && alerts.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted small" style={{ padding: "18px 10px" }}>
                    No alerts match. Detection needs ingested complaints and cells above the
                    minimum baseline volume; see Coverage.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Enrichment batch</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          The model only explains an alert that already exists, from a bounded evidence
          packet. Every alert above ranks and displays with the model switched off.
        </p>
        <div className="filters">
          <select value={variant} onChange={(e) => setVariant(e.target.value)}>
            {(config?.variants ?? []).map((v: any) => (
              <option key={v.id} value={v.id} disabled={!v.available}>
                {v.label}
                {v.available ? "" : " (no API key bound)"}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="admin token (if set)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ width: 190 }}
          />
          <button className="btn" disabled={selected.size === 0 || enriching} onClick={enrich}>
            {enriching ? "Running…" : `Enrich ${selected.size} selected`}
          </button>
          <span className="muted small">
            Alerts below the threshold of {threshold} are not enriched.
          </span>
        </div>
        {progress.length > 0 && (
          <div className="progress">
            {progress.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
