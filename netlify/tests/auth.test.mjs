import test from "node:test";
import assert from "node:assert/strict";
import handler, { config } from "../functions/auth.mjs";

const AUTH_ID = "00000000-0000-4000-8000-000000000001";
const ACCESS = "access-token-for-test";
const REFRESH = "refresh-token-for-test";

test("Auth endpoint uses a per-IP rate limit", () => {
  assert.deepEqual(config.rateLimit, {
    action: "rate_limit",
    aggregateBy: "ip",
    windowSize: 60,
    windowLimit: 20
  });
});

async function withAuthEnv(mapping, run, customFetch = () => undefined) {
  const oldFetch = globalThis.fetch;
  const names = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    SUPABASE_URL: "https://supabase.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "publishable-test-only",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-only"
  });
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body, headers: options.headers });
    const custom = await customFetch(String(url), options, calls);
    if (custom) return custom;
    if (String(url).includes("/rest/v1/app_users?")) return Response.json(mapping ? [mapping] : []);
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: AUTH_ID });
    if (String(url).includes(`/auth/v1/admin/users/${AUTH_ID}`)) {
      return Response.json({ id: AUTH_ID, email: "private-test@example.invalid" });
    }
    if (String(url).includes("/auth/v1/token?grant_type=password")) {
      return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: "bearer", user: { id: AUTH_ID, email: "private-test@example.invalid" } });
    }
    if (String(url).includes("/auth/v1/token?grant_type=refresh_token")) {
      return Response.json({ access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 3600, token_type: "bearer", user: { id: AUTH_ID, email: "private-test@example.invalid" } });
    }
    if (String(url).includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    return Response.json({}, { status: 404 });
  };
  try { await run(calls); }
  finally {
    globalThis.fetch = oldFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function invoke(body, options = {}) {
  return handler(new Request("https://site.invalid/.netlify/functions/auth", {
    method: options.method || "POST",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: options.raw ?? JSON.stringify(body)
  }));
}

const linkedMapping = {
  legacy_id: "student-1",
  auth_user_id: AUTH_ID,
  username: "Elyas702",
  display_name: "Student",
  needs_password_reset: true
};

test("username login resolves Auth email server-side and returns no email or password", async () => {
  await withAuthEnv(linkedMapping, async calls => {
    const response = await invoke({ action: "login", username: "Elyas702", password: "temporary-password" });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.user.id, "student-1");
    assert.equal(data.user.needsPasswordReset, true);
    assert.equal(data.session.user.id, AUTH_ID);
    assert.equal("email" in data.session.user, false);
    assert.equal(JSON.stringify(data).includes("temporary-password"), false);
    assert.equal(JSON.stringify(data).includes("private-test@example.invalid"), false);
    assert.equal(calls.some(call => call.url.includes("/auth/v1/admin/users/")), true);
  });
});

test("unknown username returns the same generic credential error", async () => {
  await withAuthEnv(null, async () => {
    const response = await invoke({ action: "login", username: "missing", password: "guess" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_credentials" });
  });
});

test("bad password does not reveal the mapped Auth email", async () => {
  await withAuthEnv(linkedMapping, async () => {
    const response = await invoke({ action: "login", username: "Elyas702", password: "wrong" }, {
      // The mocked Auth server rejects the password grant.
      raw: JSON.stringify({ action: "login", username: "Elyas702", password: "wrong" })
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_credentials" });
  }, url => url.includes("/auth/v1/token?grant_type=password")
    ? Response.json({ message: "Invalid login credentials" }, { status: 400 })
    : undefined);
});

test("password change reauthenticates the linked user before updating Auth", async () => {
  const mapping = { ...linkedMapping, needs_password_reset: false };
  await withAuthEnv(mapping, async calls => {
    const response = await invoke({ action: "change_password", currentPassword: "correct-current", newPassword: "new-password-long" }, {
      headers: { authorization: `Bearer ${ACCESS}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const reauth = calls.find(call => call.url.includes("grant_type=password"));
    assert.equal(JSON.parse(reauth.body).password, "correct-current");
    const update = calls.find(call => call.method === "PUT" && call.url.includes(`/auth/v1/admin/users/${AUTH_ID}`));
    assert.deepEqual(JSON.parse(update.body), { password: "new-password-long" });
  });
});

test("failed current-password verification does not update Auth and returns a generic error", async () => {
  const mapping = { ...linkedMapping, needs_password_reset: false };
  await withAuthEnv(mapping, async calls => {
    const response = await invoke({ action: "change_password", currentPassword: "wrong", newPassword: "new-password-long" }, {
      headers: { authorization: `Bearer ${ACCESS}` }
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_credentials" });
    assert.equal(calls.some(call => call.method === "PUT" && call.url.includes(`/auth/v1/admin/users/${AUTH_ID}`)), false);
  }, url => url.includes("/auth/v1/token?grant_type=password")
    ? Response.json({ message: "Invalid login credentials" }, { status: 400 })
    : undefined);
});

test("temporary-reset accounts cannot use the general password-change action", async () => {
  await withAuthEnv(linkedMapping, async calls => {
    const response = await invoke({ action: "change_password", currentPassword: "temporary", newPassword: "new-password-long" }, {
      headers: { authorization: `Bearer ${ACCESS}` }
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "password_reset_required" });
    assert.equal(calls.some(call => call.url.includes("grant_type=password")), false);
  });
});

test("refresh returns only a linked session and server-resolves the app identity", async () => {
  await withAuthEnv(linkedMapping, async calls => {
    const response = await invoke({ action: "refresh", refreshToken: REFRESH });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.session.access_token, "refreshed-access");
    assert.equal(data.user.id, "student-1");
    assert.equal("email" in data.session.user, false);
    assert.equal(calls.some(call => call.url.includes("auth_user_id=eq.")), true);
  });
});

test("refresh revokes a token if its Auth identity no longer maps to an app user", async () => {
  await withAuthEnv(null, async calls => {
    const response = await invoke({ action: "refresh", refreshToken: REFRESH });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "account_not_linked" });
    assert.equal(calls.some(call => call.url.endsWith("/auth/v1/logout")), true);
  });
});

test("unsupported methods and oversized requests are rejected", async () => {
  const methodResponse = await handler(new Request("https://site.invalid/.netlify/functions/auth", { method: "GET" }));
  assert.equal(methodResponse.status, 405);
  const malformedResponse = await handler(new Request("https://site.invalid/.netlify/functions/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{"
  }));
  assert.equal(malformedResponse.status, 400);
  const largeResponse = await handler(new Request("https://site.invalid/.netlify/functions/auth", {
    method: "POST",
    headers: { "content-length": "9000", "content-type": "application/json" },
    body: "{}"
  }));
  assert.equal(largeResponse.status, 413);
});
