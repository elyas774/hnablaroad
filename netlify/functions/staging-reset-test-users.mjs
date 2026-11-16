const TARGETS = new Set([
  "703420ca-936d-47c8-9319-10072be6e905",
  "f32bc6b3-5c8e-4d91-8263-daef782c7d6b"
]);
const ONE_TIME_TOKEN = "UvRFZPsPHXSVXnJ_TEVlhWbqRh6wvB0vaHpqydcfjkU";

function env(name) {
  try {
    const value = globalThis.Netlify?.env?.get?.(name);
    if (value) return value;
  } catch (_) {}
  return globalThis.process?.env?.[name] || "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export default async function handler(request) {
  if (!(["GET", "POST"].includes(request.method))) return json({ error: "method_not_allowed" }, 405);
  const queryToken = new URL(request.url).searchParams.get("token");
  if (request.headers.get("x-staging-reset-token") !== ONE_TIME_TOKEN && queryToken !== ONE_TIME_TOKEN) {
    return json({ error: "not_found" }, 404);
  }
  const base = String(env("SUPABASE_URL") || "").replace(/\/+$/, "");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !service) return json({ error: "not_configured" }, 503);
  const password = "1234567890";
  const results = [];
  for (const id of TARGETS) {
    const response = await fetch(`${base}/auth/v1/admin/users/${id}`, {
      method: "PUT",
      headers: { apikey: service, authorization: `Bearer ${service}`, "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    results.push({ id, ok: response.ok, status: response.status });
  }
  return json({ ok: results.every((item) => item.ok), results });
}
