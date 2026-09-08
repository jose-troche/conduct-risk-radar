import type { Variant } from "../config";
import type { Env } from "../types";

export interface ModelCall {
  text: string;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number;
}

/** USD for a call, from the variant's declared per-million-token rates. */
export function priceCall(v: Variant, inTok: number | null, outTok: number | null): number | null {
  if (inTok === null && outTok === null) return null;
  return (
    ((inTok ?? 0) / 1_000_000) * v.inputCostPerMTok +
    ((outTok ?? 0) / 1_000_000) * v.outputCostPerMTok
  );
}

async function runWorkersAi(env: Env, variant: Variant, prompt: string): Promise<ModelCall> {
  const started = Date.now();
  const res = (await env.AI.run(variant.model as never, {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 900,
    // Low but non-zero: the eval compares variants across repeated runs, and a
    // fully greedy decode would hide variance that is really there.
    temperature: 0.2,
  } as never)) as {
    response?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  // Workers AI usually returns `response` as a string, but not always - some
  // models hand back an object. Coercing here keeps a surprising shape from
  // throwing later, where it would lose the enrichment record entirely.
  const raw = res?.response;
  return {
    text: typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw),
    input_tokens: res?.usage?.prompt_tokens ?? null,
    output_tokens: res?.usage?.completion_tokens ?? null,
    latency_ms: Date.now() - started,
  };
}

async function runAnthropic(env: Env, variant: Variant, prompt: string): Promise<ModelCall> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not bound; this variant is unavailable.");
  }
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: variant.model,
      max_tokens: 900,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text =
    body.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") ?? "";
  return {
    text,
    input_tokens: body.usage?.input_tokens ?? null,
    output_tokens: body.usage?.output_tokens ?? null,
    latency_ms: Date.now() - started,
  };
}

export function variantAvailable(env: Env, variant: Variant): boolean {
  return variant.provider !== "anthropic" || !!env.ANTHROPIC_API_KEY;
}

export function callModel(env: Env, variant: Variant, prompt: string): Promise<ModelCall> {
  return variant.provider === "anthropic"
    ? runAnthropic(env, variant, prompt)
    : runWorkersAi(env, variant, prompt);
}
