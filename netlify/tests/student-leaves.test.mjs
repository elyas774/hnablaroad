import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import handler, { BUCKET, calendarDate, excuseRpcArgs, parseAttachment, parseOperation } from "../functions/student-leaves.mjs";

const AUTH_ID = "00000000-0000-4000-8000-000000000001";
const SERVICE = "student-leaves-test-service-secret";
const MAPPING = { legacy_id: "student-7", auth_user_id: AUTH_ID, username: "learner", display_name: "Learner", needs_password_reset: false };
const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const JPEG = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 0]).toString("base64")}`;
const UUID = "00000000-0000-4000-8000-000000000099";
const validSubmit = () => ({ op: "submit", start: "2026-11-20", end: "2026-11-21", type: "مرضية", mode: "light", reason: "موعد طبي", protectStreak: true });

async function withMockedSupabase(run, { mapping = MAPPING, rpcResult = { ok: true }, responder = () => undefined } = {}) {
  const oldFetch = globalThis.fetch;
  const oldEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  Object.assign(process.env, { SUPABASE_URL: "https://supabase.example.invalid", SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: SERVICE });
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    const call = { url, method: options.method || "GET", headers: options.headers || {}, body: options.body };
    calls.push(call);
    const custom = await responder(url, options, calls);
    if (custom) return custom;
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: AUTH_ID });
    if (url.includes("/rest/v1/app_users?")) return Response.json([mapping]);
    if (url.endsWith("/rest/v1/rpc/student_leaves_action")) return Response.json(rpcResult);
    if (url.endsWith("/rest/v1/rpc/student_excuses_action")) return Response.json(rpcResult);
    if (url.includes("/storage/v1/object/sign/")) return Response.json({ signedURL: `${new URL(url).pathname.replace("/storage/v1/", "")}?token=signed-test` });
    if (url.includes(`/storage/v1/object/${BUCKET}/`)) return Response.json({ Key: "stored" });
    return new Response(null, { status: 204 });
  };
  try { await run(calls); }
  finally {
    globalThis.fetch = oldFetch;
    for (const name of ENV_NAMES) oldEnv[name] === undefined ? delete process.env[name] : process.env[name] = oldEnv[name];
  }
}
function request(body, { authorization = "Bearer verified-test-token", method = "POST", contentType = "application/json" } = {}) {
  return new Request("https://site.invalid/.netlify/functions/student-leaves", {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(contentType ? { "content-type": contentType } : {}) },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });
}
async function invoke(body, options = {}) { return handler(request(body, options)); }
function rpcCall(calls) { return calls.find(call => call.url.endsWith("/rest/v1/rpc/student_leaves_action")); }
function excuseRpcCall(calls) { return calls.find(call => call.url.endsWith("/rest/v1/rpc/student_excuses_action")); }
function assertService(call) {
  assert.ok(call);
  const headers = new Headers(call.headers);
  assert.equal(headers.get("apikey"), SERVICE);
  assert.equal(headers.get("authorization"), `Bearer ${SERVICE}`);
}
function listItem(path = null) {
  return { id: UUID, requestId: UUID, userId: "student-7", authorName: "Learner", start: "2026-11-20", end: "2026-11-21", status: "pending", attachment_path: path };
}

test("only POST is accepted and the function does not add CORS headers", async () => {
  const response = await handler(request(null, { method: "GET" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
});

test("bounded operation parser rejects arbitrary writes, identity/score fields, and unsupported operations", () => {
  for (const invalid of [
    { op: "write", table: "shared", data: {} },
    { ...validSubmit(), points: 10 },
    { ...validSubmit(), ownerId: "victim" },
    { ...validSubmit(), rules: { attendance: true } },
    { op: "approve", requestId: UUID, approvedBy: "not-leader" },
    { op: "cancel", requestId: "not-a-uuid" },
    { ...validSubmit(), mode: "emergency" },
    { ...validSubmit(), type: "invented" },
    { ...validSubmit(), reason: " " }
  ]) assert.throws(() => parseOperation(invalid), /invalid_request/);
});

test("date-only and current datetime-local fields normalize to calendar dates with strict validation", () => {
  assert.equal(calendarDate("2024-02-29"), "2024-02-29");
  assert.equal(calendarDate("2026-11-20T23:59"), "2026-11-20");
  assert.equal(parseOperation({ ...validSubmit(), start: "2026-11-20T08:15", end: "2026-11-20T08:30" }).start, "2026-11-20");
  for (const value of ["2025-02-29", "2026-13-01", "2026-11-20T24:00", "2026-11-20Z", "2026-11-20T12:60"]) assert.throws(() => calendarDate(value), /invalid_request/);
  assert.throws(() => parseOperation({ ...validSubmit(), start: "2026-11-22", end: "2026-11-20" }), /invalid_request/);
});

test("attachment parser enforces exact safe MIME, byte limit, base64 and file signatures", () => {
  assert.equal(parseAttachment(JPEG).mime, "image/jpeg");
  assert.throws(() => parseAttachment("data:image/gif;base64,R0lGODlh"), /invalid_attachment/);
  assert.throws(() => parseAttachment("data:image/svg+xml;base64,PHN2Zz4="), /invalid_attachment/);
  assert.throws(() => parseAttachment("data:image/jpeg;base64,AAAA"), /invalid_attachment/);
  assert.throws(() => parseAttachment("data:application/pdf;base64,PHN2Zz4="), /invalid_attachment/);
  assert.throws(() => parseAttachment(`data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString("base64")}`), /attachment_too_large/);
});

test("missing bearer is rejected before Supabase service calls", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(validSubmit(), { authorization: "" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(calls.length, 0);
  });
});

test("password-reset-required accounts cannot read or mutate leave data", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "mine" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "password_reset_required" });
    assert.equal(calls.some(call => call.url.endsWith("/rest/v1/rpc/student_leaves_action")), false);
  }, { mapping: { ...MAPPING, needs_password_reset: true } });
});

test("student submission uses Auth ownership, a server UUID, private storage and only server-derived rules", async () => {
  const record = { ...listItem(`${AUTH_ID}/${UUID}.jpg`), rules: { attendance: true, penalties: true, streak: true }, status: "pending" };
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...validSubmit(), attachmentData: JPEG });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.request.status, "pending");
    assert.equal(body.request.attachmentUrl.includes("token=signed-test"), true);
    assert.equal("attachment_path" in body.request, false);
    assert.equal("_privateAttachmentPath" in body.request, false);
    assert.equal(JSON.stringify(body).includes(SERVICE), false);
    const upload = calls.find(call => call.url.includes(`/storage/v1/object/${BUCKET}/`));
    assert.ok(upload);
    assertService(upload);
    assert.equal(new Headers(upload.headers).get("content-type"), "image/jpeg");
    assert.match(new URL(upload.url).pathname, new RegExp(`/${AUTH_ID}/[0-9a-f-]+\\.jpg$`));
    const rpc = rpcCall(calls);
    assertService(rpc);
    const args = JSON.parse(rpc.body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "submit");
    assert.equal(args.p_start_date, "2026-11-20");
    assert.equal(args.p_end_date, "2026-11-21");
    assert.equal(args.p_type, "مرضية");
    assert.equal(args.p_protect_streak, true);
    assert.equal(args.p_attachment_mime, "image/jpeg");
    assert.match(args.p_attachment_path, new RegExp(`^${AUTH_ID}/[0-9a-f-]+\\.jpg$`));
    for (const untrusted of ["p_owner_id", "p_points", "p_rules", "p_approved_by"]) assert.equal(untrusted in args, false);
  }, { rpcResult: { ok: true, item: record } });
});

test("uploads are cleaned up after an explicit RPC conflict, including duplicate pending requests", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...validSubmit(), attachmentData: JPEG });
    assert.equal(response.status, 409);
    const deletion = calls.find(call => call.method === "DELETE" && call.url.includes(`/storage/v1/object/${BUCKET}/`));
    assert.ok(deletion);
    assertService(deletion);
  }, { rpcResult: { ok: false, conflict: true } });
});

test("ambiguous RPC transport failure does not delete an attachment that may already be committed", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...validSubmit(), attachmentData: JPEG });
    assert.equal(response.status, 503);
    assert.equal(calls.some(call => call.method === "DELETE" && call.url.includes(`/storage/v1/object/${BUCKET}/`)), false);
  }, { responder: url => url.endsWith("/rest/v1/rpc/student_leaves_action") ? new Response("internal detail", { status: 500 }) : undefined });
});

test("owner list signs only RPC-authorized private objects and strips raw paths", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "mine" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].userId, "student-7");
    assert.equal(body.items[0].attachmentUrl.includes("token=signed-test"), true);
    assert.equal("attachment_path" in body.items[0], false);
    assert.equal("_privateAttachmentPath" in body.items[0], false);
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "mine");
    const signed = calls.find(call => call.url.includes("/storage/v1/object/sign/"));
    assertService(signed);
    assert.deepEqual(JSON.parse(signed.body), { expiresIn: 60 });
  }, { rpcResult: { ok: true, items: [listItem(`${AUTH_ID}/${UUID}.jpg`)] } });
});

test("leader queue uses a separate server-authorized operation and returns no storage paths", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "review_queue" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items[0].userId, "student-7");
    assert.equal(body.items[0].attachmentUrl.startsWith("https://supabase.example.invalid/"), true);
    assert.equal("attachment_path" in body.items[0], false);
    assert.equal(JSON.parse(rpcCall(calls).body).p_op, "review_queue");
  }, { rpcResult: { ok: true, items: [listItem("00000000-0000-4000-8000-000000000002/other.pdf")] } });
});

test("decision and cancellation operations pass only a requested transition and Auth actor", async () => {
  for (const op of ["approve", "reject", "cancel"]) {
    await withMockedSupabase(async calls => {
      const response = await invoke({ op, requestId: UUID });
      assert.equal(response.status, 200);
      const args = JSON.parse(rpcCall(calls).body);
      assert.equal(args.p_auth_user_id, AUTH_ID);
      assert.equal(args.p_op, op);
      assert.equal(args.p_request_id, UUID);
      assert.equal("p_status" in args, false);
      assert.equal("p_owner_id" in args, false);
    }, { rpcResult: { ok: true, item: { ...listItem(), status: op === "approve" ? "approved" : op === "reject" ? "rejected" : "cancelled" } } });
  }
});

test("denied attachment lookup does not create a signed URL", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "attachment_url", requestId: UUID });
    assert.equal(response.status, 404);
    assert.equal(calls.some(call => call.url.includes("/storage/v1/object/sign/")), false);
  }, { rpcResult: { ok: false } });
});

test("RPC authorization results reject nonleader decisions and stale requests generically", async () => {
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "approve", requestId: UUID });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
  }, { rpcResult: { ok: false, forbidden: true } });
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "cancel", requestId: UUID });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "conflict" });
  }, { rpcResult: { ok: false, conflict: true } });
});

test("generic backend errors reveal neither database messages nor storage secrets", async () => {
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "mine" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }, { responder: url => url.endsWith("/rest/v1/rpc/student_leaves_action") ? new Response("private SQL detail", { status: 500 }) : undefined });
});

test("migration protects rows and storage, checks current leader, dates, owner access, overlap and row locks", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/008_student_leaves.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/i);
  assert.match(sql, /revoke all on table public\.student_leave_requests from public, anon, authenticated, service_role/i);
  assert.match(sql, /revoke all on function public\.student_leaves_action[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.student_leaves_action[\s\S]*?to service_role/i);
  assert.match(sql, /needs_password_reset=false/i);
  assert.match(sql, /where s\.id='weekLeaderId' for share/i);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /for update/i);
  assert.match(sql, /'Asia\/Riyadh'/);
  assert.match(sql, /student_leave_no_exact_pending_duplicate/);
  assert.match(sql, /p_end_date<v_today/i);
  assert.match(sql, /v_request\.owner_legacy_id<>v_actor and not v_is_leader/i);
  assert.match(sql, /public\s*=\s*false/i);
  assert.match(sql, /file_size_limit\s*,\s*allowed_mime_types[\s\S]*?2097152/i);
  assert.match(sql, /create policy student_leave_attachments_deny_select[\s\S]*?to anon, authenticated/i);
});


test("excuse parser accepts only bounded details, known categories, and explicit review decisions", () => {
  assert.deepEqual(parseOperation({ op: "excuse_submit", type: "غياب", text: "ظرف طارئ" }), { op: "excuse_submit", type: "غياب", text: "ظرف طارئ", attachmentData: undefined });
  assert.deepEqual(parseOperation({ op: "excuse_review", requestId: UUID, decision: "approved" }), { op: "excuse_review", requestId: UUID, decision: "approved" });
  for (const invalid of [
    { op: "excuse_submit", type: "invented", text: "details" },
    { op: "excuse_submit", type: "غياب", text: " " },
    { op: "excuse_submit", type: "غياب", text: "details", userId: "victim" },
    { op: "excuse_review", requestId: UUID, decision: "pending" },
    { op: "excuse_delete_owner", userId: "student-7", points: 500 }
  ]) assert.throws(() => parseOperation(invalid), /invalid_request/);
});

test("excuse submission uses Auth ownership, a server UUID, private storage, and the excuse RPC", async () => {
  const excuse = { id: UUID, userId: "student-7", authorName: "Learner", type: "غياب", text: "ظرف طارئ", status: "pending", attachment_path: `${AUTH_ID}/${UUID}.jpg` };
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "excuse_submit", type: "غياب", text: "ظرف طارئ", attachmentData: JPEG });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.excuse.status, "pending");
    assert.match(body.excuse.attachmentUrl, /token=signed-test/);
    assert.equal("attachment_path" in body.excuse, false);
    const upload = calls.find(call => call.url.includes(`/storage/v1/object/${BUCKET}/`));
    assertService(upload);
    assert.equal(new Headers(upload.headers).get("content-type"), "image/jpeg");
    const rpc = excuseRpcCall(calls);
    assertService(rpc);
    const args = JSON.parse(rpc.body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "submit");
    assert.equal(args.p_type, "غياب");
    assert.equal(args.p_text, "ظرف طارئ");
    assert.match(args.p_request_id, /^[0-9a-f-]{36}$/i);
    assert.match(args.p_attachment_path, new RegExp(`^${AUTH_ID}/[0-9a-f-]+\\.jpg$`));
    assert.equal(calls.some(call => call.url.endsWith("/rest/v1/rpc/student_leaves_action")), false);
    assert.equal(JSON.stringify(body).includes(SERVICE), false);
  }, { rpcResult: { ok: true, item: excuse } });
});

test("excuse review queue signs only private RPC-authorized objects and review sends no client identity", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "excuse_review_queue" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items[0].attachmentUrl.includes("token=signed-test"), true);
    assert.equal("attachment_path" in body.items[0], false);
    const args = JSON.parse(excuseRpcCall(calls).body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "review_queue");
    assertService(excuseRpcCall(calls));
  }, { rpcResult: { ok: true, items: [{ id: UUID, userId: "student-7", attachment_path: `${AUTH_ID}/${UUID}.jpg` }] } });

  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "excuse_review", requestId: UUID, decision: "rejected" });
    assert.equal(response.status, 200);
    const args = JSON.parse(excuseRpcCall(calls).body);
    assert.equal(args.p_op, "review");
    assert.equal(args.p_request_id, UUID);
    assert.equal(args.p_decision, "rejected");
    assert.equal("p_owner_id" in args, false);
  }, { rpcResult: { ok: true, item: { id: UUID, status: "rejected" } } });
});

test("account excuse cleanup passes only the target legacy ID to the server-authorized RPC", async () => {
  const args = excuseRpcArgs({ authUser: { id: AUTH_ID } }, parseOperation({ op: "excuse_delete_owner", userId: "student-8" }));
  assert.equal(args.p_auth_user_id, AUTH_ID);
  assert.equal(args.p_op, "delete_owner");
  assert.equal(args.p_target_user_id, "student-8");
  assert.equal("p_points" in args, false);
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "excuse_delete_owner", userId: "student-8" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, deletedCount: 2, legacyDeletedCount: 1 });
    assertService(excuseRpcCall(calls));
  }, { rpcResult: { ok: true, deletedCount: 2, legacyDeletedCount: 1 } });
});

test("excuse migration keeps rows private and the SECURITY DEFINER RPC service-role-only", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/012_student_excuses.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table public\.student_excuse_requests enable row level security/i);
  assert.match(sql, /revoke all on table public\.student_excuse_requests from public, anon, authenticated, service_role/i);
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/i);
  assert.match(sql, /needs_password_reset=false/i);
  assert.match(sql, /where s\.id='weekLeaderId' for share/i);
  assert.match(sql, /p_op not in \('mine','review_queue','submit','review','attachment_url','delete_owner'\)/i);
  assert.match(sql, /p_attachment_path !~.*p_auth_user_id::text.*p_request_id::text/i);
  assert.match(sql, /revoke all on function public\.student_excuses_action[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.student_excuses_action[\s\S]*?to service_role/i);
  assert.match(sql, /where e\.value->>'userId' is distinct from p_target_user_id/i);
});
