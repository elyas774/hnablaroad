/*
 * Server-side username bridge for Supabase Auth.
 *
 * Configure SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and
 * SUPABASE_SERVICE_ROLE_KEY in Netlify Functions scope. Never expose the service
 * role key to browser code. This endpoint intentionally does not implement
 * signup; legacy account linking and student data authorization remain separate.
 */
const MAX_BODY_BYTES = 8 * 1024;
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s-]{7,19}$/;

function env(name) {
  try {
    const fromNetlify = globalThis.Netlify?.env?.get?.(name);
    if (fromNetlify) return fromNetlify;
  } catch (_) { /* outside Netlify CLI/runtime */ }
  return globalThis.process?.env?.[name] || "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "pragma": "no-cache"
    }
  });
}

function error(status, code) {
  const e = new Error(code);
  e.status = status;
  return e;
}

function baseUrl() { return String(env("SUPABASE_URL") || "").replace(/\/+$/, ""); }

async function serviceRows(base, service, query) {
  const url = `${base}/rest/v1/app_users?${query}`;
  const response = await fetch(url, {
    headers: { apikey: service, authorization: `Bearer ${service}` }
  });
  if (!response.ok) throw error(503, "auth_unavailable");
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function linkedAuthUser(base, service, authUserId) {
  const rows = await serviceRows(
    base,
    service,
    `auth_user_id=eq.${encodeURIComponent(authUserId)}&select=legacy_id,auth_user_id,username,display_name,needs_password_reset&limit=2`
  );
  return rows.length === 1 && rows[0].legacy_id ? rows[0] : null;
}

async function authJson(base, path, { method = "POST", key, bearer, body } = {}) {
  const headers = { apikey: key, "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await response.json(); } catch (_) { /* Empty response is valid on logout. */ }
  return { ok: response.ok, status: response.status, data };
}

function safeSession(data) {
  const userId = data?.user?.id;
  if (!userId || typeof data.access_token !== "string" || typeof data.refresh_token !== "string") {
    throw error(502, "auth_unavailable");
  }
  const expiresIn = Math.max(0, Number(data.expires_in) || 0);
  return {
    session: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: expiresIn,
      expires_at: Number(data.expires_at) || Math.floor(Date.now() / 1000) + expiresIn,
      token_type: data.token_type || "bearer",
      user: { id: userId }
    }
  };
}

async function login(base, publishable, service, body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!USERNAME_RE.test(username) || !password || password.length > 256) {
    throw error(400, "invalid_credentials");
  }

  const rows = await serviceRows(
    base,
    service,
    `username=eq.${encodeURIComponent(username)}&select=legacy_id,auth_user_id,username,display_name,needs_password_reset&limit=2`
  );
  if (rows.length !== 1 || !rows[0].auth_user_id) throw error(401, "invalid_credentials");

  const adminResult = await authJson(base, `/auth/v1/admin/users/${encodeURIComponent(rows[0].auth_user_id)}`, {
    method: "GET", key: service, bearer: service
  });
  const authUser = adminResult.data?.user || adminResult.data;
  if (!adminResult.ok || authUser?.id !== rows[0].auth_user_id || typeof authUser?.email !== "string") {
    throw error(401, "invalid_credentials");
  }

  const result = await authJson(base, "/auth/v1/token?grant_type=password", {
    key: publishable,
    body: { email: authUser.email, password }
  });
  if (!result.ok) {
    const message = String(result.data?.msg || result.data?.message || "").toLowerCase();
    if (result.data?.error_code === "email_not_confirmed" || message.includes("email not confirmed")) {
      throw error(403, "email_not_confirmed");
    }
    throw error(401, "invalid_credentials");
  }
  const safe = safeSession(result.data);
  if (safe.session.user.id !== rows[0].auth_user_id) throw error(401, "invalid_credentials");
  safe.user = {
    id: rows[0].legacy_id,
    username: rows[0].username,
    name: rows[0].display_name || rows[0].username,
    needsPasswordReset: !!rows[0].needs_password_reset
  };
  return safe;
}

async function supabaseRequest(base, path, { method = "GET", key, body, prefer } = {}) {
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  const response = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw error(503, "registration_failed");
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
}

async function register(base, publishable, service, body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!USERNAME_RE.test(username) || name.length < 2 || name.length > 120
      || !EMAIL_RE.test(email) || !PHONE_RE.test(phone)
      || password.length < 12 || password.length > 128) {
    throw error(400, "invalid_registration");
  }
  const existing = await serviceRows(base, service,
    `username=eq.${encodeURIComponent(username)}&select=legacy_id&limit=1`);
  if (existing.length) throw error(409, "username_taken");

  const created = await authJson(base, "/auth/v1/signup", {
    key: publishable,
    body: { email, password, data: { full_name: name, username, phone } }
  });
  if (!created.ok) {
    const message = String(created.data?.msg || created.data?.message || "").toLowerCase();
    if (message.includes("already registered") || message.includes("already exists")) throw error(409, "email_taken");
    throw error(400, "registration_failed");
  }
  const authUser = created.data?.user;
  if (!authUser?.id) throw error(503, "registration_failed");
  const legacyId = `user_${crypto.randomUUID()}`;
  try {
    await supabaseRequest(base, "/rest/v1/app_users", {
      method: "POST", key: service, prefer: "return=minimal",
      body: { legacy_id: legacyId, auth_user_id: authUser.id, username, display_name: name,
        profile: { email, phone }, needs_password_reset: false }
    });
    const usersRows = await supabaseRequest(base, "/rest/v1/shared?id=eq.users&select=id,data,version&limit=1", { key: service });
    const row = Array.isArray(usersRows) ? usersRows[0] : null;
    const users = Array.isArray(row?.data?.value) ? row.data.value : [];
    const nextUsers = [...users, { id: legacyId, name, username, email, phone, points: 0, completedTasks: [], journey: {} }];
    await supabaseRequest(base, "/rest/v1/shared", {
      method: "POST", key: service, prefer: "resolution=merge-duplicates,return=minimal",
      body: { id: "users", data: { value: nextUsers }, version: Number(row?.version || 0) + 1, updated_at: new Date().toISOString() }
    });
  } catch (e) {
    await authJson(base, `/auth/v1/admin/users/${encodeURIComponent(authUser.id)}`, { method: "DELETE", key: service, bearer: service });
    throw error(503, "registration_failed");
  }
  return {
    registered: true,
    emailVerificationRequired: !created.data?.session,
    message: !created.data?.session ? "تم إنشاء الحساب. تحقق من بريدك الإلكتروني ثم سجّل الدخول." : "تم إنشاء الحساب وتسجيل الدخول."
  };
}

async function refresh(base, publishable, service, body) {
  const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
  if (!refreshToken || refreshToken.length > 4096) throw error(401, "session_expired");
  const result = await authJson(base, "/auth/v1/token?grant_type=refresh_token", {
    key: publishable,
    body: { refresh_token: refreshToken }
  });
  if (!result.ok) throw error(401, "session_expired");
  const safe = safeSession(result.data);
  const mapping = await linkedAuthUser(base, service, safe.session.user.id);
  if (!mapping) {
    await authJson(base, "/auth/v1/logout", {
      key: publishable,
      bearer: safe.session.access_token
    }).catch(() => {});
    throw error(403, "account_not_linked");
  }
  safe.user = {
    id: mapping.legacy_id,
    username: mapping.username,
    name: mapping.display_name || mapping.username,
    needsPasswordReset: !!mapping.needs_password_reset
  };
  return safe;
}

async function logout(base, publishable, body) {
  const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
  if (accessToken.length > 8192) throw error(400, "invalid_request");
  if (accessToken) {
    await authJson(base, "/auth/v1/logout", {
      key: publishable,
      bearer: accessToken
    });
  }
  return { ok: true };
}

async function changePassword(base, publishable, service, request, body) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get("authorization") || "");
  const accessToken = match?.[1] || "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!accessToken || accessToken.length > 8192 || !currentPassword || currentPassword.length > 256
      || newPassword.length < 12 || newPassword.length > 128 || newPassword === currentPassword) {
    throw error(400, "invalid_request");
  }

  const currentAuth = await authJson(base, "/auth/v1/user", {
    method: "GET", key: publishable, bearer: accessToken
  });
  const authUserId = currentAuth.data?.id;
  if (!currentAuth.ok || !authUserId) throw error(401, "session_expired");
  const mapping = await linkedAuthUser(base, service, authUserId);
  if (!mapping) throw error(403, "account_not_linked");
  if (mapping.needs_password_reset) throw error(403, "password_reset_required");

  const adminResult = await authJson(base, `/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
    method: "GET", key: service, bearer: service
  });
  const adminUser = adminResult.data?.user || adminResult.data;
  if (!adminResult.ok || adminUser?.id !== authUserId || typeof adminUser?.email !== "string") {
    throw error(401, "invalid_credentials");
  }

  const verification = await authJson(base, "/auth/v1/token?grant_type=password", {
    key: publishable,
    body: { email: adminUser.email, password: currentPassword }
  });
  if (!verification.ok || verification.data?.user?.id !== authUserId) throw error(401, "invalid_credentials");

  const updated = await authJson(base, `/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
    method: "PUT", key: service, bearer: service, body: { password: newPassword }
  });
  if (!updated.ok) throw error(502, "password_change_failed");
  return { ok: true };
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
    let body;
    try { body = JSON.parse(raw); }
    catch (_) { throw error(400, "invalid_request"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw error(400, "invalid_request");

    const base = baseUrl();
    const publishable = env("SUPABASE_PUBLISHABLE_KEY");
    const service = env("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !publishable || !service) throw error(503, "server_not_configured");

    if (body.action === "register") return json(await register(base, publishable, service, body));
    if (body.action === "login") return json(await login(base, publishable, service, body));
    if (body.action === "refresh") return json(await refresh(base, publishable, service, body));
    if (body.action === "logout") return json(await logout(base, publishable, body));
    if (body.action === "change_password") return json(await changePassword(base, publishable, service, request, body));
    return json({ error: "unsupported_action" }, 400);
  } catch (e) {
    const status = Number(e?.status) || 503;
    const allowed = new Set(["invalid_credentials", "email_not_confirmed", "invalid_registration", "username_taken", "email_taken", "registration_failed", "session_expired", "account_not_linked", "password_reset_required", "password_change_failed", "invalid_request", "payload_too_large", "unsupported_action", "server_not_configured", "auth_unavailable"]);
    const code = allowed.has(e?.message) ? e.message : "auth_unavailable";
    if (status >= 500) console.error("auth endpoint failed", { status, code });
    return json({ error: code }, status);
  }
}

export const config = {
  rateLimit: {
    action: "rate_limit",
    aggregateBy: "ip",
    windowSize: 60,
    windowLimit: 20
  }
};
