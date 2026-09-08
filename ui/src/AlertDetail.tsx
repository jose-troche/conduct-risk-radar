import { useEffect, useState } from "react";
import { api, type AlertDetail, type Enrichment } from "./api";
import { Score } from "./Queue";

const CFPB_URL = (id: string) =>
  `https://www.consumerfinance.gov/data-research/consumer-complaints/search/detail/${id}`;

/** Render inline [complaint_id] markers as links back to the specific complaint. */
function Cited({ text }: { text: string }) {
  const parts = text.split(/(\[\s*\d{4,}\s*\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[\s*(\d{4,})\s*\]$/);
        if (!m) return <span key={i}>{p}</span>;
        return (
          <a key={i} href={CFPB_URL(m[1]!)} target="_blank" rel="noreferrer" className="mono">
            [{m[1]}]
          </a>
        );
      })}
    </>
  );
}

export function AlertDetailView({
  id,
  config,
  token,
}: {
  id: string;
  config: any;
  token: string;
}) {
  const [data, setData] = useState<AlertDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- The propose-then-reveal state machine --------------------------------
  // severity -> locked -> reveal -> action + reason -> submit. Once locked, the
  // severity control is disabled and there is no path back: this is the whole
  // reason the agreement number means anything, so it is a hard rule rather
  // than a nudge.
  const [severity, setSeverity] = useState("");
  const [locked, setLocked] = useState(false);
  const [action, setAction] = useState("");
  const [reason, setReason] = useState("");
  const [analyst, setAnalyst] = useState(
    () => localStorage.getItem("crr.analyst") ?? "analyst",
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = (reveal: boolean) =>
    api
      .alert(id, reveal)
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    setLocked(false);
    setSeverity("");
    setAction("");
    setReason("");
    setSaved(false);
    load(false);
  }, [id]);

  if (error) return <div className="panel">Error: {error}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  const a = data.alert;
  const alreadyDispositioned = data.dispositions.length > 0;
  const enrichment: Enrichment | null = data.enrichments[0] ?? null;

  const lockSeverity = async () => {
    setLocked(true);
    // The proposal is fetched only now. Before this call, it has not been sent
    // to the browser at all.
    await load(true);
  };

  const submit = async () => {
    setSaving(true);
    try {
      localStorage.setItem("crr.analyst", analyst);
      await api.disposition(id, {
        action,
        analyst_severity: severity,
        reason,
        analyst_id: analyst,
        enrichment_shown_after: true,
      });
      setSaved(true);
      await load(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p className="small">
        <a href="#/">&larr; Back to queue</a>
      </p>

      <div className="panel">
        <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <h3 style={{ fontSize: 17 }}>{a.company}</h3>
            <div className="muted">
              {a.product} &middot; {a.issue}
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              Detection window {a.window_start} to {a.window_end} &middot; baseline{" "}
              {a.baseline_start} to {a.baseline_end} &middot; weights {a.weights_version}
            </div>
          </div>
          <div style={{ minWidth: 190 }}>
            <div className="small muted">Triage priority</div>
            <Score score={a.score} />
            <div className="small muted" style={{ marginTop: 4 }}>
              dominant: {config?.signal_labels?.[a.signal_type] ?? a.signal_type}
            </div>
            <div className="small muted">status: {a.status}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Computed signals</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Each signal normalises to 0&ndash;100 and is weighted into the score. The weights
          are a stated design choice, not a fitted result. The contributions below sum to
          the score, so it is reconstructible from what is stored.
        </p>
        <div className="overflow">
          <table className="sigtable">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Window</th>
                <th>Baseline</th>
                <th className="num">Normalised</th>
                <th className="num">Weight</th>
                <th className="num">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {a.signals.map((s) => (
                <tr key={s.type} className={s.contribution === 0 ? "dim" : ""}>
                  <td>
                    {s.label}
                    {s.note && <div className="small muted">{s.note}</div>}
                  </td>
                  <td className="small">{s.window_value}</td>
                  <td className="small">{s.baseline_value}</td>
                  <td className="num">{s.normalized.toFixed(1)}</td>
                  <td className="num">{s.weight}</td>
                  <td className="num">
                    <strong>{s.contribution.toFixed(2)}</strong>
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={5} style={{ textAlign: "right" }}>
                  <strong>Score</strong>
                </td>
                <td className="num">
                  <strong>{a.score.toFixed(2)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>Driving complaints</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Counts above are computed over <strong>all {data.coverage.window_complaints}</strong>{" "}
          complaints in the window. Only{" "}
          <strong>{data.coverage.window_with_narrative}</strong> of them carry a published
          narrative &mdash; a narrative exists only where the consumer consented to
          publication &mdash; and the model's evidence is drawn only from those.{" "}
          {data.coverage.drivers_with_narrative} of the {data.coverage.drivers_returned}{" "}
          complaints below have one.
        </p>
        {data.drivers.map((d) => (
          <details key={d.complaint_id} className="driver">
            <summary>
              <span className="cid">[{d.complaint_id}]</span> {d.date_received} &middot;{" "}
              {d.sub_issue ?? d.issue} &middot; {d.state ?? "state n/a"} &middot;{" "}
              {d.company_response ?? "no response recorded"}
              {d.has_narrative ? "" : " · no narrative"}
            </summary>
            <div className="body">
              {d.has_narrative
                ? d.narrative
                : "This consumer did not consent to publication, so no narrative is available. The complaint still counts toward every figure above."}
            </div>
            <div className="body small">
              <a href={CFPB_URL(d.complaint_id)} target="_blank" rel="noreferrer">
                View on consumerfinance.gov
              </a>
            </div>
          </details>
        ))}
        {data.drivers.length === 0 && (
          <p className="muted small">No driving complaints recorded for this alert.</p>
        )}
      </div>

      {/* ---- Disposition: severity first, proposal second ------------------ */}
      <div className="panel">
        <h2>Your disposition</h2>

        {alreadyDispositioned && (
          <div className="locked" style={{ marginBottom: 14 }}>
            {data.dispositions.map((d) => (
              <div key={d.id} className="small">
                <span className={`pill ${d.analyst_severity}`}>{d.analyst_severity}</span>{" "}
                <strong>{d.action}</strong> by {d.analyst_id} &middot;{" "}
                {new Date(d.created_at).toLocaleString()}
                {d.enrichment_shown_after === 1 ? "" : " · anchoring guard not satisfied"}
                <div className="muted">{d.reason}</div>
              </div>
            ))}
          </div>
        )}

        {!saved && (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>
              Record your severity <strong>before</strong> the drafted rationale is
              revealed. The draft has not been sent to this page yet. Once you lock your
              severity you cannot change it &mdash; otherwise the agreement number measures
              anchoring rather than agreement.
            </p>

            <div className="sevpick" style={{ marginBottom: 12 }}>
              {["low", "medium", "high"].map((s) => (
                <label key={s} className={severity === s ? "sel" : ""}>
                  <input
                    type="radio"
                    name="sev"
                    value={s}
                    disabled={locked}
                    checked={severity === s}
                    onChange={() => setSeverity(s)}
                  />
                  {s}
                </label>
              ))}
            </div>

            {!locked && (
              <button className="btn" disabled={!severity} onClick={lockSeverity}>
                Lock severity and reveal the draft
              </button>
            )}
          </>
        )}

        {locked && !saved && (
          <>
            <div className="locked" style={{ margin: "14px 0" }}>
              <span className="small muted">Your severity, locked: </span>
              <span className={`pill ${severity}`}>{severity}</span>
            </div>

            {enrichment ? (
              <div style={{ margin: "14px 0" }}>
                <h3>
                  Drafted rationale{" "}
                  <span className="pill">{enrichment.model}</span>{" "}
                  <span
                    className={`pill ${enrichment.validation_status === "ok" ? "ok" : "bad"}`}
                  >
                    {enrichment.validation_status}
                  </span>
                </h3>
                {enrichment.validation_status === "ok" ? (
                  <>
                    <p>
                      <Cited text={enrichment.summary ?? ""} />
                    </p>
                    <p className="small">
                      <strong>Proposed severity:</strong>{" "}
                      <span className={`pill ${enrichment.proposed_severity}`}>
                        {enrichment.proposed_severity}
                      </span>
                    </p>
                    <p className="small">
                      <Cited text={enrichment.reasoning ?? ""} />
                    </p>
                    <p className="small muted">
                      Signals leaned on:{" "}
                      {(JSON.parse(enrichment.signals_referenced_json) as string[]).join(", ") ||
                        "none named"}{" "}
                      &middot; {enrichment.latency_ms ?? "?"}ms &middot;{" "}
                      {enrichment.cost_usd != null ? `$${enrichment.cost_usd.toFixed(6)}` : "cost n/a"}
                    </p>
                  </>
                ) : (
                  <p className="small">
                    This draft failed the validation gate and is not shown.{" "}
                    <span className="muted">{enrichment.validation_detail}</span> The alert
                    above stands on its own: the deterministic layer produced it without the
                    model.
                  </p>
                )}
              </div>
            ) : (
              <p className="small muted" style={{ margin: "14px 0" }}>
                No draft has been generated for this alert. Run an enrichment batch from the
                queue. The alert stands without one.
              </p>
            )}

            <div style={{ marginTop: 12 }}>
              <div className="filters">
                {["escalate", "monitor", "dismiss"].map((x) => (
                  <button
                    key={x}
                    className={`btn ${action === x ? "" : "secondary"}`}
                    onClick={() => setAction(x)}
                  >
                    {x}
                  </button>
                ))}
                <input
                  type="text"
                  value={analyst}
                  onChange={(e) => setAnalyst(e.target.value)}
                  placeholder="analyst id"
                  style={{ width: 130 }}
                />
              </div>
              <textarea
                placeholder="Why? (required) — what you saw, and what you would do next."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                className="btn"
                style={{ marginTop: 8 }}
                disabled={!action || reason.trim().length < 3 || saving}
                onClick={submit}
              >
                {saving ? "Saving…" : "Record disposition"}
              </button>
            </div>
          </>
        )}

        {saved && <p className="small">Disposition recorded. It is now part of the labelled set.</p>}
      </div>
    </>
  );
}
