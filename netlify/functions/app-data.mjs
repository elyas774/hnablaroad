/*
 * Supabase-backed data gateway for the legacy app.
 *
 * IMPORTANT: configure SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and
 * SUPABASE_SERVICE_ROLE_KEY in Netlify Functions scope before deployment.
 * The service-role key is used only here and must never enter browser code.
 * No database tables or RPCs are exposed directly to anon/authenticated roles.
 *
 * Conservative first stage: students may read cohort-safe state, their own
 * complete profile, send text chat, change only their own notifPref, and mark
 * eligible notifications read. Generic document writes remain current-leader-only
 * until each student self-service workflow has an explicit validated operation.
 */

const ALLOWED_TABLES = new Set(["shared", "chat_messages"]);
const FEATURE_OWNED_SHARED_KEYS = new Set(["leaveRequests", "excuses"]);
const STUDENT_SHARED_KEYS = new Set([
  "meeting", "weekLeaderId", "requiredMemorization", "memorizationPlan",
  "deductions", "pointAdditions", "notifications", "weeklyChallenge", "posts",
  "achievements", "customTasks", "taskRenewals", "smartRecitation",
  "examQuestions", "currentAdvice", "adviceArchive", "leaderHistory", "diwan",
  "covenantLaws", "constitution", "appUpdateSignal", "appMaintenance", "proposals",
  "vacations", "leaveRequests", "leaveHistory", "excuses", "challengeSubmissions",
  "challengeLogs"
]);
const PUBLIC_USER_FIELDS = new Set([
  "id", "name", "username", "avatar", "points", "totalPoints", "highestPoints",
  "weeklyCards", "darkMode"
]);
const MAX_BODY_BYTES = 64 * 1024;
const SENSITIVE_FIELD_RE = /password|email|phone|token|secret/i;
const EXAM_SECRET_FIELD_RE = /(?:answer|correct|solution|explan)/i;

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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function normalizeBase(url) { return String(url || "").replace(/\/+$/, ""); }
function parseValue(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}
function redactTree(value, keyPattern, depth = 0) {
  if (depth > 24) return null;
  if (Array.isArray(value)) return value.map(item => redactTree(item, keyPattern, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key)) continue;
    out[key] = redactTree(child, keyPattern, depth + 1);
  }
  return out;
}
function cleanProjection(user, isSelf) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return user;
  const out = {};
  for (const [key, value] of Object.entries(user)) {
    if (SENSITIVE_FIELD_RE.test(key)) continue;
    // Attempts contain grading metadata and historical answer fields; the exam
    // feature gateway is the only supported source for owner/reviewer access.
    if (key === "examResult" || key === "publishedExamResults") continue;
    if (!isSelf && !PUBLIC_USER_FIELDS.has(key) && key !== "attendance") continue;
    if (!isSelf && key === "attendance" && value && typeof value === "object") {
      out.attendance = { streak: Number(value.streak) || 0 };
      continue;
    }
    out[key] = redactTree(value, SENSITIVE_FIELD_RE);
  }
  return out;
}

function studentCanReadSharedKey(key) { return STUDENT_SHARED_KEYS.has(key) || key === "users"; }

function projectLeaderUsers(row) {
  const users = parseValue(row?.data?.value);
  if (!Array.isArray(users)) return { ...row, data: redactTree(row.data, SENSITIVE_FIELD_RE) };
  const safe = users.map(user => cleanProjection(user, true));
  return { ...row, data: { ...redactTree(row.data, SENSITIVE_FIELD_RE), value: JSON.stringify(safe) } };
}

function projectStudentExamQuestions(row) {
  const questions = parseValue(row?.data?.value);
  if (!questions || typeof questions !== "object") return row;
  const safe = redactTree(questions, EXAM_SECRET_FIELD_RE);
  return { ...row, data: { ...redactTree(row.data, SENSITIVE_FIELD_RE), value: JSON.stringify(safe) } };
}

function projectSharedRow(row, actorId, isLeader) {
  if (!row || !row.data || typeof row.data !== "object") return null;
  if (!isLeader && !studentCanReadSharedKey(row.id)) return null;
  if (isLeader) return row.id === "users" ? projectLeaderUsers(row) : row;
  row = { ...row, data: redactTree(row.data, SENSITIVE_FIELD_RE) };
  if (row.id === "examQuestions") return projectStudentExamQuestions(row);
  if (row.id !== "users") {
    const filteredValue = projectPrivateArray(row.id, row.data.value, actorId);
    if (filteredValue === undefined) {
      const parsed = parseValue(row.data.value);
      if (!parsed || typeof parsed !== "object") return row;
      const safe = redactTree(parsed, SENSITIVE_FIELD_RE);
      return { ...row, data: { ...row.data, value: typeof row.data.value === "string" ? JSON.stringify(safe) : safe } };
    }
    const parsed = parseValue(filteredValue);
    const safeValue = parsed && typeof parsed === "object"
      ? JSON.stringify(redactTree(parsed, SENSITIVE_FIELD_RE))
      : filteredValue;
    return { ...row, data: { ...row.data, value: safeValue } };
  }
  const value = projectPrivateArray(row.id, row.data.value, actorId);
  if (value !== undefined) return { ...row, data: { ...row.data, value } };
  const original = parseValue(row.data.value);
  if (!Array.isArray(original)) return { ...row, data: { ...row.data, value: "[]" } };
  const filtered = original.map(user => cleanProjection(user, user?.id === actorId));
  return { ...row, data: { ...row.data, value: JSON.stringify(filtered) } };
}

function projectPrivateArray(key, rawValue, actorId) {
  const parsed = parseValue(rawValue);
  const ownerOnly = new Set(["deductions", "pointAdditions", "leaveRequests", "leaveHistory", "excuses", "challengeSubmissions", "challengeLogs"]);
  if (key === "notifications" && Array.isArray(parsed)) {
    return JSON.stringify(parsed
      .filter(item => item && (item.targetId === "all" || item.targetId === actorId))
      .map(item => ({ ...item, readBy: Array.isArray(item.readBy) && item.readBy.includes(actorId) ? [actorId] : [] })));
  }
  if (key === "notifications") return "[]";
  if (key === "weeklyChallenge" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const answeredBy = Array.isArray(parsed.answeredBy) ? parsed.answeredBy.filter(item => item?.userId === actorId) : [];
    return JSON.stringify({ ...parsed, answeredBy });
  }
  if (key === "weeklyChallenge") return "{}";
  if (ownerOnly.has(key) && Array.isArray(parsed)) {
    return JSON.stringify(parsed.filter(item => item && (item.userId === actorId || item.targetUserId === actorId)));
  }
  if (ownerOnly.has(key)) return "[]";
  if (key === "smartRecitation" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([owner]) => owner === actorId)));
  }
  if (key === "smartRecitation") return "{}";
  return undefined;
}

function projectChatRow(row, actorId, isLeader) {
  if (!row || !row.data || typeof row.data !== "object") return null;
  if (isLeader || row.data.userId === actorId) return row;
  if (row.data.type !== "text") return null;
  const data = { ...row.data };
  delete data.mediaUrl;
  delete data.mediaPath;
  return { ...row, data };
}

function getBearer(request) {
  const value = request.headers.get("authorization") || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(value);
  return match ? match[1] : "";
}

async function supabaseRequest(path, { method = "GET", key, bearer, body, prefer } = {}) {
  const base = normalizeBase(env("SUPABASE_URL"));
  const headers = { apikey: key, authorization: `Bearer ${bearer || key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  const response = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

async function authenticate(request) {
  const accessToken = getBearer(request);
  if (!accessToken) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const base = normalizeBase(env("SUPABASE_URL"));
  const publishable = env("SUPABASE_PUBLISHABLE_KEY");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !publishable || !service) throw Object.assign(new Error("server_not_configured"), { status: 503 });
  const authRes = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: publishable, authorization: `Bearer ${accessToken}` }
  });
  if (!authRes.ok) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const authUser = await authRes.json();
  if (!authUser?.id) throw Object.assign(new Error("unauthorized"), { status: 401 });
  const rows = await supabaseRequest(
    `/rest/v1/app_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=legacy_id,auth_user_id,username,display_name,needs_password_reset&limit=2`,
    { key: service }
  );
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0].legacy_id) {
    throw Object.assign(new Error("account_not_linked"), { status: 403 });
  }
  return { accessToken, authUser, mapping: rows[0], base, publishable, service };
}

async function selectRows(ctx, table, query) {
  if (!ALLOWED_TABLES.has(table)) throw Object.assign(new Error("invalid_table"), { status: 400 });
  const path = `/rest/v1/${table}?${query}`;
  return supabaseRequest(path, { key: ctx.service });
}

async function selectOne(ctx, table, id) {
  if (!ALLOWED_TABLES.has(table) || typeof id !== "string" || !id || id.length > 160) {
    throw Object.assign(new Error("invalid_document"), { status: 400 });
  }
  const rows = await selectRows(ctx, table, `id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function isLeader(ctx) {
  const rows = await selectRows(ctx, "shared", "id=eq.weekLeaderId&select=id,data&limit=1");
  const raw = rows?.[0]?.data?.value;
  const leaderId = parseValue(raw);
  return typeof leaderId === "string" && leaderId === ctx.mapping.legacy_id;
}

async function writeRow(ctx, table, id, data, mode = "upsert") {
  if (typeof id !== "string" || !id || id.length > 160) throw Object.assign(new Error("invalid_document"), { status: 400 });
  const current = await selectOne(ctx, table, id);
  const body = { id, data, version: (Number(current?.version) || 0) + 1, updated_at: new Date().toISOString() };
  if (table === "chat_messages") body.date = typeof data?.date === "string" ? data.date : new Date().toISOString();
  const prefer = mode === "insert" ? "return=minimal" : "resolution=merge-duplicates,return=minimal";
  const path = `/rest/v1/${table}?on_conflict=id`;
  await supabaseRequest(path, { method: "POST", key: ctx.service, body, prefer });
  return { ok: true };
}

async function sharedCas(ctx, id, expectedVersion, data) {
  if (typeof id !== "string" || !id || id.length > 160 || id === "weekLeaderId") {
    throw Object.assign(new Error("invalid_document"), { status: 400 });
  }
  const result = await supabaseRequest("/rest/v1/rpc/leader_shared_cas", {
    method: "POST", key: ctx.service,
    body: { p_auth_user_id: ctx.authUser.id, p_id: id, p_expected: Number(expectedVersion) || 0, p_data: data }
  });
  if (result !== true) throw Object.assign(new Error("write_conflict"), { status: 409 });
  return { ok: true };
}

function stripLegacyCredentials(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if (typeof data.value !== "string") return data;
  const users = parseValue(data.value);
  if (!Array.isArray(users)) return data;
  const safe = users.map(user => {
    if (!user || typeof user !== "object" || Array.isArray(user)) return user;
    const copy = { ...user };
    for (const key of ["password", "email", "phone", "phoneVerified"]) delete copy[key];
    return copy;
  });
  return { ...data, value: JSON.stringify(safe) };
}

async function patchRow(ctx, table, id, patch, expectedVersion) {
  const row = await selectOne(ctx, table, id);
  if (!row) throw Object.assign(new Error("not_found"), { status: 404 });
  if (expectedVersion !== undefined && Number(row.version) !== Number(expectedVersion)) {
    throw Object.assign(new Error("write_conflict"), { status: 409 });
  }
  const next = { ...(row.data || {}), ...patch };
  const result = await supabaseRequest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&version=eq.${Number(row.version) || 0}`, {
    method: "PATCH", key: ctx.service,
    body: { data: next, version: (Number(row.version) || 0) + 1, updated_at: new Date().toISOString(), ...(table === "chat_messages" && patch.date ? { date: patch.date } : {}) },
    prefer: "return=representation"
  });
  if (!Array.isArray(result) || result.length !== 1) throw Object.assign(new Error("write_conflict"), { status: 409 });
  return { ok: true };
}

async function deleteRow(ctx, table, id, expectedVersion) {
  if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
    throw Object.assign(new Error("invalid_version"), { status: 400 });
  }
  const result = await supabaseRequest(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&version=eq.${Number(expectedVersion)}`, {
    method: "DELETE", key: ctx.service, prefer: "return=representation"
  });
  if (!Array.isArray(result) || result.length !== 1) throw Object.assign(new Error("write_conflict"), { status: 409 });
  return { ok: true };
}

async function handleOperation(ctx, body) {
  const { op, table, id } = body;
  if (op === "reset_password") {
    const password = typeof body.newPassword === "string" ? body.newPassword : "";
    if (password.length < 12 || password.length > 128) throw Object.assign(new Error("password_must_be_12_to_128_chars"), { status: 400 });
    if (!ctx.mapping.needs_password_reset) throw Object.assign(new Error("password_reset_not_required"), { status: 409 });
    const authResponse = await fetch(`${ctx.base}/auth/v1/admin/users/${encodeURIComponent(ctx.authUser.id)}`, {
      method: "PUT",
      headers: { apikey: ctx.service, authorization: `Bearer ${ctx.service}`, "content-type": "application/json" },
      body: JSON.stringify({ password })
    });
    if (!authResponse.ok) throw Object.assign(new Error("password_reset_failed"), { status: 502 });
    await supabaseRequest(`/rest/v1/app_users?auth_user_id=eq.${encodeURIComponent(ctx.authUser.id)}`, {
      method: "PATCH", key: ctx.service,
      body: { needs_password_reset: false, updated_at: new Date().toISOString() },
      prefer: "return=minimal"
    });
    return { passwordReset: true };
  }
  if (op === "whoami") {
    return {
      user: {
        id: ctx.mapping.legacy_id,
        username: ctx.mapping.username,
        name: ctx.mapping.display_name || ctx.mapping.username,
        needsPasswordReset: !!ctx.mapping.needs_password_reset
      },
      isLeader: await isLeader(ctx)
    };
  }
  if (op === "user_pref_patch") {
    const patch = body.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)
        || Object.keys(patch).length !== 1 || typeof patch.notifPref !== "boolean") {
      throw Object.assign(new Error("invalid_profile_patch"), { status: 400 });
    }
    const usersRow = await selectOne(ctx, "shared", "users");
    if (!usersRow) throw Object.assign(new Error("not_found"), { status: 404 });
    const result = await supabaseRequest("/rest/v1/rpc/student_profile_pref_cas", {
      method: "POST", key: ctx.service,
      body: {
        p_auth_user_id: ctx.authUser.id,
        p_expected: Number(usersRow.version) || 0,
        p_patch: patch
      }
    });
    if (result !== true) throw Object.assign(new Error("write_conflict"), { status: 409 });
    return { ok: true, version: (Number(usersRow.version) || 0) + 1 };
  }
  if (op === "notifications_seen") {
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 300
        || body.ids.some(value => typeof value !== "string" || !value || value.length > 160)) {
      throw Object.assign(new Error("invalid_notification_ids"), { status: 400 });
    }
    const ids = [...new Set(body.ids)];
    const notificationsRow = await selectOne(ctx, "shared", "notifications");
    if (!notificationsRow) throw Object.assign(new Error("not_found"), { status: 404 });
    const result = await supabaseRequest("/rest/v1/rpc/student_notifications_seen_cas", {
      method: "POST", key: ctx.service,
      body: {
        p_auth_user_id: ctx.authUser.id,
        p_expected: Number(notificationsRow.version) || 0,
        p_ids: ids
      }
    });
    if (result !== true) throw Object.assign(new Error("write_conflict"), { status: 409 });
    return { ok: true, version: (Number(notificationsRow.version) || 0) + 1 };
  }
  if (op === "attendance_mark") {
    const usersRow = await selectOne(ctx, "shared", "users");
    if (!usersRow) throw Object.assign(new Error("not_found"), { status: 404 });
    const result = await supabaseRequest("/rest/v1/rpc/student_attendance_mark_cas", {
      method: "POST", key: ctx.service,
      body: { p_auth_user_id: ctx.authUser.id, p_expected: Number(usersRow.version) || 0 }
    });
    if (result?.conflict) throw Object.assign(new Error("write_conflict"), { status: 409 });
    if (result?.ok !== true && result?.reason !== "attendance_paused") {
      throw Object.assign(new Error("attendance_update_failed"), { status: 502 });
    }
    return result;
  }
  if (!ALLOWED_TABLES.has(table)) throw Object.assign(new Error("invalid_table"), { status: 400 });
  const leader = await isLeader(ctx);

  if (op === "get") {
    const row = await selectOne(ctx, table, id);
    if (table === "shared" && row) {
      const visible = projectSharedRow(row, ctx.mapping.legacy_id, leader);
      if (!visible) throw Object.assign(new Error("not_found"), { status: 404 });
      return { row: visible };
    }
    if (table === "chat_messages") {
      const visible = projectChatRow(row, ctx.mapping.legacy_id, leader);
      if (!visible) throw Object.assign(new Error("not_found"), { status: 404 });
      return { row: visible };
    }
    return { row };
  }

  if (op === "list") {
    const order = table === "chat_messages" ? "&order=date.asc" : "";
    const rows = await selectRows(ctx, table, `select=*&limit=1000${order}`);
    const visible = table === "shared"
      ? rows.map(row => projectSharedRow(row, ctx.mapping.legacy_id, leader)).filter(Boolean)
      : rows.map(row => projectChatRow(row, ctx.mapping.legacy_id, leader)).filter(Boolean);
    return { rows: visible };
  }

  if (op === "chat_send") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 4000) throw Object.assign(new Error("invalid_message"), { status: 400 });
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    await writeRow(ctx, "chat_messages", newId, {
      userId: ctx.mapping.legacy_id,
      authorName: ctx.mapping.display_name || ctx.mapping.username,
      text, type: "text", mediaUrl: null, mediaPath: null,
      date: now, seenBy: [ctx.mapping.legacy_id]
    }, "insert");
    return { id: newId };
  }

  if (op === "chat_edit") {
    const row = await selectOne(ctx, "chat_messages", id);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!row || row.data?.userId !== ctx.mapping.legacy_id || row.data?.type !== "text") {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    }
    if (!text || text.length > 4000) throw Object.assign(new Error("invalid_message"), { status: 400 });
    await patchRow(ctx, "chat_messages", id, { text, edited: true }, row.version);
    return { ok: true };
  }

  if (op === "chat_delete") {
    const row = await selectOne(ctx, "chat_messages", id);
    if (!row || row.data?.userId !== ctx.mapping.legacy_id) throw Object.assign(new Error("forbidden"), { status: 403 });
    await deleteRow(ctx, "chat_messages", id, row.version);
    return { ok: true };
  }

  if (op === "chat_seen") {
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].filter(x => typeof x === "string" && x.length <= 160).slice(0, 100) : [];
    await supabaseRequest("/rest/v1/rpc/chat_seen_server", {
      method: "POST", key: ctx.service,
      body: { p_auth_user_id: ctx.authUser.id, p_ids: ids }
    });
    return { ok: true };
  }

  if (!leader) throw Object.assign(new Error("leader_required"), { status: 403 });
  if (op === "set") {
    if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw Object.assign(new Error("invalid_data"), { status: 400 });
    if (table === "shared" && FEATURE_OWNED_SHARED_KEYS.has(id)) throw Object.assign(new Error("feature_gateway_required"), { status: 403 });
    if (table === "shared") return sharedCas(ctx, id, body.expectedVersion, id === "users" ? stripLegacyCredentials(body.data) : body.data);
    return writeRow(ctx, table, id, body.data);
  }
  if (op === "patch") {
    if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) throw Object.assign(new Error("invalid_patch"), { status: 400 });
    if (table === "shared" && FEATURE_OWNED_SHARED_KEYS.has(id)) throw Object.assign(new Error("feature_gateway_required"), { status: 403 });
    if (table === "shared" && id === "weekLeaderId") throw Object.assign(new Error("protected_document"), { status: 403 });
    if (table === "shared") {
      const current = await selectOne(ctx, "shared", id);
      if (!current) throw Object.assign(new Error("not_found"), { status: 404 });
      const patch = id === "users" ? stripLegacyCredentials(body.patch) : body.patch;
      const result = await supabaseRequest("/rest/v1/rpc/leader_shared_patch", {
        method: "POST", key: ctx.service,
        body: { p_auth_user_id: ctx.authUser.id, p_id: id, p_expected: Number(current.version) || 0, p_patch: patch }
      });
      if (result !== true) throw Object.assign(new Error("write_conflict"), { status: 409 });
      return result;
    }
    return patchRow(ctx, table, id, body.patch);
  }
  if (op === "delete") {
    if (table !== "chat_messages") throw Object.assign(new Error("unsupported_operation"), { status: 403 });
    const row = await selectOne(ctx, table, id);
    if (!row) throw Object.assign(new Error("not_found"), { status: 404 });
    return deleteRow(ctx, table, id, row.version);
  }
  throw Object.assign(new Error("unsupported_operation"), { status: 400 });
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_request" }, 400);
    const ctx = await authenticate(request);
    if (ctx.mapping.needs_password_reset && !["whoami", "reset_password"].includes(body.op)) {
      return json({ error: "password_reset_required" }, 403);
    }
    const result = await handleOperation(ctx, body);
    return json(result);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("app-data request failed", { status, code: error?.code || "internal" });
    return json({ error: status >= 500 ? "internal_error" : error.message }, status);
  }
}

export { cleanProjection, projectChatRow, studentCanReadSharedKey, projectSharedRow };
