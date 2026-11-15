import test from "node:test";
import assert from "node:assert/strict";
import handler, { parseOperation, parseProofData } from "./student-tasks.mjs";

const AUTH_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_AUTH_ID = "00000000-0000-4000-8000-000000000002";
const SERVICE = "test-service-role-secret";
const MAPPING = {
  legacy_id: "student-7",
  auth_user_id: AUTH_ID,
  username: "learner",
  display_name: "Learner",
  needs_password_reset: false
};
const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const JPEG_DATA = "data:image/jpeg;base64,/9j/2Q==";

async function withMockedSupabase(run, { mapping = MAPPING, rpc = {}, responder = () => undefined } = {}) {
  const oldFetch = globalThis.fetch;
  const oldEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    SUPABASE_URL: "https://supabase.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE
  });
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    const call = { url, method: options.method || "GET", headers: options.headers || {}, body: options.body };
    calls.push(call);
    const custom = await responder(url, options, calls);
    if (custom) return custom;
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: AUTH_ID });
    if (url.includes("/rest/v1/app_users?")) return Response.json([mapping]);
    if (url.endsWith("/rest/v1/rpc/student_tasks_action")) return Response.json(rpc.result ?? { ok: true });
    if (url.includes("/storage/v1/object/sign/")) {
      const parsed = new URL(url);
      return Response.json({ signedURL: `${parsed.pathname.replace("/storage/v1/", "")}?token=signed-test` });
    }
    if (url.includes("/storage/v1/object/task-proofs/")) return Response.json({ Key: "stored" });
    return new Response(null, { status: 204 });
  };
  try { await run(calls); }
  finally {
    globalThis.fetch = oldFetch;
    for (const name of ENV_NAMES) {
      if (oldEnv[name] === undefined) delete process.env[name];
      else process.env[name] = oldEnv[name];
    }
  }
}

function request(body, { authorization = "Bearer verified-test-token", method = "POST", contentType = "application/json" } = {}) {
  return new Request("https://site.invalid/.netlify/functions/student-tasks", {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(contentType ? { "content-type": contentType } : {}) },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });
}

async function invoke(body, options = {}) { return handler(request(body, options)); }
function findCall(calls, suffix) { return calls.find(call => call.url.endsWith(suffix)); }
function assertService(call) {
  const headers = new Headers(call.headers);
  assert.equal(headers.get("apikey"), SERVICE);
  assert.equal(headers.get("authorization"), `Bearer ${SERVICE}`);
}

const submitPayload = () => ({ op: "submit", taskId: "side-1", cycleKey: "daily-2026-11-14", proofType: "image", proofData: JPEG_DATA });

test("only POST is accepted and no CORS policy is introduced", async () => {
  const response = await handler(request(null, { method: "GET" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
});

test("operation parser rejects arbitrary writes, extra fields, and malformed cycle keys", () => {
  assert.throws(() => parseOperation({ op: "set", table: "shared", data: { value: "x" } }), /invalid_request/);
  assert.throws(() => parseOperation({ ...submitPayload(), points: 999 }), /invalid_request/);
  assert.throws(() => parseOperation({ ...submitPayload(), cycleKey: "daily-not-a-date" }), /invalid_request/);
  assert.throws(() => parseOperation({ op: "review", studentId: "other", taskId: "t", cycleKey: "weekly-x", approved: true, points: 100 }), /invalid_request/);
});

test("proof parsing requires allowed MIME, strict base64, size and matching file signature", () => {
  assert.equal(parseProofData(JPEG_DATA).mime, "image/jpeg");
  assert.throws(() => parseProofData("data:image/jpeg;base64,AAAA"), /invalid_proof/);
  assert.throws(() => parseProofData("data:image/svg+xml;base64,PHN2Zz4="), /invalid_proof/);
  assert.throws(() => parseProofData("data:image/jpeg;base64,/9j/2Q"), /invalid_proof/);
  assert.throws(() => parseProofData(`data:image/jpeg;base64,${Buffer.alloc(3_670_017, 1).toString("base64")}`), /proof_too_large/);
});

test("missing bearer token is rejected before storage or RPC", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(submitPayload(), { authorization: "" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(calls.length, 0);
  });
});

test("password-reset-required identity cannot submit a task", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(submitPayload());
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "password_reset_required" });
    assert.equal(calls.some(c => c.url.endsWith("/rest/v1/rpc/student_tasks_action")), false);
    assert.equal(calls.some(c => c.url.includes("/storage/v1/object/task-proofs/")), false);
  }, { mapping: { ...MAPPING, needs_password_reset: true } });
});

test("student proof submission derives ownership from Auth, stores privately, and receives server-computed points", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(submitPayload());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(Object.keys(data).sort(), ["date", "ok", "points", "proofType", "proofUrl", "status", "submissionId", "title"].sort());
    assert.equal(data.points, 5);
    assert.equal(data.status, "pending");
    assert.equal(data.proofType, "image");
    const upload = calls.find(c => c.url.includes("/storage/v1/object/task-proofs/"));
    assert.ok(upload);
    assertService(upload);
    assert.equal(upload.method, "POST");
    assert.equal(new Headers(upload.headers).get("content-type"), "image/jpeg");
    assert.match(new URL(upload.url).pathname, new RegExp(`/${AUTH_ID}/[0-9a-f-]+\\.jpg$`));
    const rpc = findCall(calls, "/rest/v1/rpc/student_tasks_action");
    assert.ok(rpc);
    assertService(rpc);
    const args = JSON.parse(rpc.body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "submit");
    assert.equal(args.p_task_id, "side-1");
    assert.equal(args.p_cycle_key, "daily-2026-11-14");
    assert.equal(args.p_proof_mime, "image/jpeg");
    assert.equal(args.p_proof_path.startsWith(`${AUTH_ID}/`), true);
    assert.equal("p_target_user_id" in args, true);
    assert.equal(JSON.stringify(data).includes(SERVICE), false);
  }, { rpc: { result: { ok: true, status: "pending", points: 5, title: "حفظ آية", date: "2026-11-14T10:00:00.000Z" } } });
});

test("submit operation removes a newly uploaded duplicate without awarding twice", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(submitPayload());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, alreadyCompleted: true });
    const deletion = calls.find(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/task-proofs/"));
    assert.ok(deletion);
    assertService(deletion);
  }, { rpc: { result: { ok: true, duplicate: true } } });
});

test("signed-URL failure after commit never deletes the persisted task proof", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(submitPayload());
    assert.equal(response.status, 503);
    assert.ok(calls.some(c => c.url.endsWith("/rest/v1/rpc/student_tasks_action")));
    assert.equal(calls.some(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/task-proofs/")), false);
  }, {
    rpc: { result: { ok: true, status: "pending", points: 5, title: "Task", date: "2026-11-14T10:00:00.000Z" } },
    responder: url => url.includes("/storage/v1/object/sign/") ? new Response(null, { status: 500 }) : undefined
  });
});

test("ambiguous task RPC failure preserves the uploaded proof in case the transaction committed", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(submitPayload());
    assert.equal(response.status, 503);
    assert.ok(calls.some(c => c.url.endsWith("/rest/v1/rpc/student_tasks_action")));
    assert.equal(calls.some(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/task-proofs/")), false);
  }, { responder: url => url.endsWith("/rest/v1/rpc/student_tasks_action") ? new Response("upstream timeout", { status: 500 }) : undefined });
});

test("client-supplied ownership and points never enter the accepted submission contract", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...submitPayload(), studentId: "victim", userId: "victim", points: 99999, ownerId: "victim" });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

test("student may list only self-scoped results, and private storage paths are replaced with short-lived signed URLs", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "mine" });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].studentId, "student-7");
    assert.equal(data.items[0].proofUrl.includes("token=signed-test"), true);
    assert.equal("proof_path" in data.items[0], false);
    const rpc = findCall(calls, "/rest/v1/rpc/student_tasks_action");
    assert.equal(JSON.parse(rpc.body).p_auth_user_id, AUTH_ID);
    assert.equal(JSON.parse(rpc.body).p_target_user_id, null);
    const signed = calls.find(c => c.url.includes("/storage/v1/object/sign/task-proofs/"));
    assert.ok(signed);
    assertService(signed);
    assert.deepEqual(JSON.parse(signed.body), { expiresIn: 60 });
  }, { rpc: { result: { ok: true, items: [{ studentId: "student-7", title: "حفظ آية", proof_path: `${AUTH_ID}/private.jpg`, status: "approved" }] } } });
});

test("leader review queue response never includes raw private object paths", async () => {
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "review_queue" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.items[0].studentId, "student-other");
    assert.equal(body.items[0].proofUrl.startsWith("https://supabase.example.invalid/"), true);
    assert.equal("proof_path" in body.items[0], false);
  }, { rpc: { result: { ok: true, items: [{ studentId: "student-other", studentName: "Other", title: "Task", proof_path: `${OTHER_AUTH_ID}/private.png`, status: "pending" }] } } });
});

test("review writes carry Auth-derived actor and only boolean approval; rejection deletes its private proof", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "review", studentId: "student-other", taskId: "side-1", cycleKey: "weekly-2026-11-14T10:30:00.000Z", approved: false });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "rejected", points: 5, title: "حفظ آية", approved: false });
    const rpc = findCall(calls, "/rest/v1/rpc/student_tasks_action");
    const args = JSON.parse(rpc.body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_target_user_id, "student-other");
    assert.equal(args.p_approved, false);
    assert.equal("points" in args, false);
    const deletion = calls.find(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/task-proofs/"));
    assert.ok(deletion);
    assert.equal(new URL(deletion.url).pathname.endsWith("/private.jpg"), true);
    assertService(deletion);
  }, { rpc: { result: { ok: true, status: "rejected", points: 5, title: "حفظ آية", approved: false, delete_path: `${OTHER_AUTH_ID}/private.jpg` } } });
});

test("review approval leaves proof intact and does not award client-selected points", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "review", studentId: "student-other", taskId: "side-1", cycleKey: "daily-2026-11-14", approved: true });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "approved");
    assert.equal(calls.some(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/task-proofs/")), false);
    assert.equal(JSON.parse(findCall(calls, "/rest/v1/rpc/student_tasks_action").body).p_approved, true);
  }, { rpc: { result: { ok: true, status: "approved", points: 5, title: "Task", approved: true, delete_path: null } } });
});

test("non-leader review is denied by the server-side RPC result and not by caller role flags", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "review", studentId: "student-other", taskId: "side-1", cycleKey: "daily-2026-11-14", approved: true, isLeader: true });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "review", studentId: "student-other", taskId: "side-1", cycleKey: "daily-2026-11-14", approved: true });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
    const args = JSON.parse(findCall(calls, "/rest/v1/rpc/student_tasks_action").body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
  }, { rpc: { result: { ok: false, forbidden: true } } });
});

test("private proof URL lookup does not sign a denied object", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "proof_url", submissionId: "00000000-0000-4000-8000-000000000099" });
    assert.equal(response.status, 404);
    assert.equal(calls.some(c => c.url.includes("/storage/v1/object/sign/")), false);
  }, { rpc: { result: { ok: false } } });
});

test("undo uses server-computed points and performs proof deletion only after atomic RPC success", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "undo", taskId: "side-1", cycleKey: "daily-2026-11-14" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "undone", points: 5, title: "Task" });
    const args = JSON.parse(findCall(calls, "/rest/v1/rpc/student_tasks_action").body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_target_user_id, null);
    assert.equal(args.p_approved, null);
    assert.ok(calls.some(c => c.method === "DELETE" && c.url.endsWith("/private.jpg")));
  }, { rpc: { result: { ok: true, status: "undone", points: 5, title: "Task", delete_path: `${AUTH_ID}/private.jpg` } } });
});

test("cycle conflicts and stale review results are returned generically", async () => {
  await withMockedSupabase(async calls => {
    const submit = await invoke(submitPayload());
    assert.equal(submit.status, 409);
    assert.deepEqual(await submit.json(), { error: "conflict" });
    assert.ok(calls.some(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/task-proofs/")));
  }, { rpc: { result: { ok: false, conflict: true } } });
  await withMockedSupabase(async () => {
    const undo = await invoke({ op: "undo", taskId: "side-1", cycleKey: "daily-2026-11-14" });
    assert.equal(undo.status, 409);
    assert.deepEqual(await undo.json(), { error: "conflict" });
  }, { rpc: { result: { ok: false, conflict: true } } });
});

test("migration statically declares RLS, definer isolation, service-only RPC, private bucket and row-lock CAS", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../../supabase/migrations/006_student_tasks.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/i);
  assert.match(sql, /revoke all on function public\.student_tasks_action\([\s\S]+?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.student_tasks_action[\s\S]+?to service_role/i);
  assert.match(sql, /public = false/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /for share/i);
  assert.match(sql, /status in \('pending', 'approved'\)/i);
});

test("browser and server daily task keys both use the Riyadh calendar date", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  const sql = await readFile(new URL("../../supabase/migrations/006_student_tasks.sql", import.meta.url), "utf8");
  assert.match(html, /function getRiyadhCalendarDateKey\(date = new Date\(\)\)/);
  assert.match(html, /timeZone:'Asia\/Riyadh'/);
  assert.match(html, /return 'daily-' \+ getRiyadhCalendarDateKey\(now\)/);
  assert.match(sql, /v_expected_cycle := 'daily-' \|\| to_char\(v_local::date, 'YYYY-MM-DD'\)/i);
});
