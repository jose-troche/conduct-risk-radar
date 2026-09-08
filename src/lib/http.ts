export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

export function badRequest(message: string, detail?: unknown): Response {
  return json({ error: message, detail }, { status: 400 });
}

export function notFound(message = "not found"): Response {
  return json({ error: message }, { status: 404 });
}

export function serverError(e: unknown): Response {
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: "internal_error", detail: message }, { status: 500 });
}

/** Cheap unique id. Not a security primitive. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
