import { useEffect, useState } from "react";
import { api } from "./api";
import { Queue } from "./Queue";
import { AlertDetailView } from "./AlertDetail";
import { StatsView } from "./Stats";
import { EvalView } from "./Eval";

export type Route =
  | { name: "queue" }
  | { name: "alert"; id: string }
  | { name: "stats" }
  | { name: "eval" };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("alert/")) return { name: "alert", id: h.slice(6) };
  if (h === "stats") return { name: "stats" };
  if (h === "eval") return { name: "eval" };
  return { name: "queue" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [config, setConfig] = useState<any>(null);
  // The admin token gates anything that spends model budget. It is held in the
  // tab only, never persisted: this is a demo control, not an auth system.
  const [token, setToken] = useState("");

  useEffect(() => {
    const on = () => setRoute(parseHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(() => setConfig(null));
  }, []);

  const go = (r: string) => {
    location.hash = r;
  };

  return (
    <div className="app">
      <header className="top">
        <h1>Conduct Risk Radar</h1>
        <span className="tag">
          CFPB consumer complaints &middot; deterministic detection, model downstream
        </span>
        <nav className="tabs">
          <button aria-current={route.name === "queue" || route.name === "alert"} onClick={() => go("/")}>
            Queue
          </button>
          <button aria-current={route.name === "eval"} onClick={() => go("/eval")}>
            Eval
          </button>
          <button aria-current={route.name === "stats"} onClick={() => go("/stats")}>
            Coverage
          </button>
        </nav>
      </header>

      <div className="banner">
        <strong>The score is a triage priority, not a prediction.</strong> It ranks which
        anomaly to look at first. Complaints are consumer-submitted allegations and are
        unverified; nothing here asserts that an institution did anything wrong. Volume
        tracks attention as much as conduct.
      </div>

      {route.name === "queue" && <Queue config={config} token={token} setToken={setToken} />}
      {route.name === "alert" && <AlertDetailView id={route.id} config={config} token={token} />}
      {route.name === "stats" && <StatsView />}
      {route.name === "eval" && <EvalView config={config} token={token} />}

      <footer className="foot">
        Source: CFPB Consumer Complaint Database (public, CC0). Rolling{" "}
        {config?.scope?.windowDays ?? 90}-day window over{" "}
        {config?.scope?.products?.length ?? 4} products and{" "}
        {config?.variants ? config.scope.companies.length : "several"} institutions &mdash; not the
        full database. An experiment, not a production system.
      </footer>
    </div>
  );
}
