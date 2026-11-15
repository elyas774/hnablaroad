import test from "node:test";
import assert from "node:assert/strict";
import handler, { parseOperation } from "./student-social.mjs";

const AUTH_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_AUTH_ID = "00000000-0000-4000-8000-000000000002";
const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const POST_ID = "20000000-0000-4000-8000-000000000001";
const COMMENT_ID = "30000000-0000-4000-8000-000000000001";
const SERVICE = "social-test-service-secret";
const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const MAPPING = {
  legacy_id: "student-7",
  auth_user_id: AUTH_ID,
  username: "learner",
  display_name: "Learner",
  needs_password_reset: false
};

async function withMockedSupabase(run, { mapping = MAPPING, rpc = {}, authId = AUTH_ID, responder = () => undefined } = {}) {
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
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: authId });
    if (url.includes("/rest/v1/app_users?")) return Response.json([mapping]);
    if (url.endsWith("/rest/v1/rpc/student_social_action")) return Response.json(rpc.result ?? { ok: true, status: "created" });
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
  return new Request("https://site.invalid/.netlify/functions/student-social", {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(contentType ? { "content-type": contentType } : {}) },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });
}
async function invoke(body, options = {}) { return handler(request(body, options)); }
function rpcCall(calls) { return calls.find(call => call.url.endsWith("/rest/v1/rpc/student_social_action")); }
function assertService(call) {
  const headers = new Headers(call.headers);
  assert.equal(headers.get("apikey"), SERVICE);
  assert.equal(headers.get("authorization"), `Bearer ${SERVICE}`);
}

const createPost = (overrides = {}) => ({ op: "create_post", requestId: REQUEST_ID, text: "A useful reminder", ...overrides });

test("only POST is accepted and response adds no permissive CORS headers", async () => {
  const response = await handler(request(null, { method: "GET" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
});

test("operation parser rejects generic writes, identity fields, extra keys, malformed IDs and unsupported emojis", () => {
  assert.throws(() => parseOperation({ op: "set", table: "shared", data: { value: "x" } }), /invalid_request/);
  assert.throws(() => parseOperation(createPost({ ownerId: "victim" })), /invalid_request/);
  assert.throws(() => parseOperation(createPost({ authorName: "spoofed" })), /invalid_request/);
  assert.throws(() => parseOperation({ op: "toggle_reaction", postId: POST_ID, requestId: REQUEST_ID, emoji: "🔥" }), /invalid_request/);
  assert.throws(() => parseOperation({ op: "delete_post", postId: "bad-id", expectedVersion: 1, requestId: REQUEST_ID }), /invalid_request/);
});

test("post and comment content are trimmed and bounded; CAS version and idempotency key are required", () => {
  const parsed = parseOperation(createPost({ text: "  hello  " }));
  assert.equal(parsed.text, "hello");
  assert.match(parsed.postId, /^[0-9a-f-]{36}$/i);
  assert.throws(() => parseOperation(createPost({ text: " " })), /invalid_request/);
  assert.throws(() => parseOperation(createPost({ text: "x".repeat(2001) })), /invalid_request/);
  assert.throws(() => parseOperation({ op: "create_comment", postId: POST_ID, requestId: REQUEST_ID, text: "x".repeat(501) }), /invalid_request/);
  assert.throws(() => parseOperation({ op: "edit_post", postId: POST_ID, expectedVersion: 0, requestId: REQUEST_ID, text: "edit" }), /invalid_request/);
  assert.throws(() => parseOperation({ op: "create_post", text: "no request key" }), /invalid_request/);
});

test("missing bearer is rejected before service queries or RPC", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "feed" }, { authorization: "" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(calls.length, 0);
  });
});

test("password-reset-required mapped account cannot use social operations", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "feed" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "password_reset_required" });
    assert.equal(rpcCall(calls), undefined);
  }, { mapping: { ...MAPPING, needs_password_reset: true } });
});

test("create derives owner only from validated Auth and sends a narrowly scoped service RPC", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(createPost());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.status, "created");
    const call = rpcCall(calls);
    assert.ok(call);
    assertService(call);
    const args = JSON.parse(call.body);
    assert.deepEqual(args, {
      p_auth_user_id: AUTH_ID,
      p_op: "create_post",
      p_post_id: args.p_post_id,
      p_comment_id: null,
      p_request_id: REQUEST_ID,
      p_text: "A useful reminder",
      p_emoji: null,
      p_expected_version: null
    });
    assert.match(args.p_post_id, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(data).includes(SERVICE), false);
  });
});

test("caller-supplied user identity, author, owner, score, or post type is rejected before Auth", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(createPost({ userId: "victim" }));
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
  await withMockedSupabase(async calls => {
    const response = await invoke(createPost({ points: 999, type: "auto" }));
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

test("feed returns the bounded server-computed representation without browser table reads", async () => {
  const posts = [{ id: POST_ID, userId: "student-7", authorName: "Learner", text: "hello", reactions: [], comments: [] }];
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "feed" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { posts });
    assert.equal(calls.filter(c => c.url.includes("/rest/v1/shared?")).length, 0);
    const call = rpcCall(calls);
    assertService(call);
    const args = JSON.parse(call.body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "feed");
  }, { rpc: { result: { ok: true, posts } } });
});

test("edit and delete requests use version CAS and never accept another student's identity", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "edit_post", postId: POST_ID, expectedVersion: 3, requestId: REQUEST_ID, text: "Corrected" });
    assert.equal(response.status, 200);
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_post_id, POST_ID);
    assert.equal(args.p_expected_version, 3);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal("target_user_id" in args, false);
  }, { rpc: { result: { ok: true, status: "updated", postId: POST_ID, version: 4 } } });
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "delete_post", postId: POST_ID, expectedVersion: 1, requestId: REQUEST_ID, studentId: "victim" });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });
});

test("comments and four permitted reactions derive identity and use idempotency keys", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "create_comment", postId: POST_ID, requestId: REQUEST_ID, text: "  جزاك الله خيرًا  " });
    assert.equal(response.status, 200);
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_post_id, POST_ID);
    assert.equal(args.p_text, "جزاك الله خيرًا");
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.match(args.p_comment_id, /^[0-9a-f-]{36}$/i);
  }, { rpc: { result: { ok: true, status: "created", commentId: COMMENT_ID, version: 1 } } });
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "toggle_reaction", postId: POST_ID, requestId: REQUEST_ID, emoji: "🤲" });
    assert.equal(response.status, 200);
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_emoji, "🤲");
    assert.equal(args.p_request_id, REQUEST_ID);
  }, { rpc: { result: { ok: true, status: "set", emoji: "🤲" } } });
});

test("server RPC conflict, forbidden ownership, missing object, and invalid input map to generic HTTP errors", async () => {
  for (const [rpc, status, error] of [
    [{ ok: false, conflict: true }, 409, "conflict"],
    [{ ok: false, forbidden: true }, 403, "forbidden"],
    [{ ok: false, not_found: true }, 404, "not_found"],
    [{ ok: false, invalid: true }, 400, "invalid_request"]
  ]) {
    await withMockedSupabase(async () => {
      const response = await invoke({ op: "delete_post", postId: POST_ID, expectedVersion: 2, requestId: REQUEST_ID });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    }, { rpc: { result: rpc } });
  }
});

test("method, content type, and RPC failures remain generic; no CORS is added", async () => {
  await withMockedSupabase(async () => {
    const response = await handler(request({ op: "feed" }, { contentType: "text/plain" }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
    assert.equal(response.headers.has("access-control-allow-origin"), false);
  });
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "feed" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }, { responder: url => url.endsWith("/rest/v1/rpc/student_social_action") ? new Response("secret database failure", { status: 500 }) : undefined });
});

test("migration is additive, service-role-only, fixed-search-path, row-locked, idempotent and contains no public bucket", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../../supabase/migrations/010_student_social.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.student_social_posts/i);
  assert.match(sql, /create table if not exists public\.student_social_comments/i);
  assert.match(sql, /create table if not exists public\.student_social_reactions/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/i);
  assert.match(sql, /revoke all on function public\.student_social_action\([\s\S]+?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.student_social_action[\s\S]+?to service_role/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /for share/i);
  assert.match(sql, /select\s*\(s\.data->>'value'\)::jsonb\s+into v_users/i);
  assert.match(sql, /on conflict\(owner_auth_user_id,request_id\) do nothing/i);
  assert.match(sql, /weekLeaderId[\s\S]+?v_is_leader/i);
  assert.doesNotMatch(sql, /create bucket|public\s*=\s*true/i);
});
