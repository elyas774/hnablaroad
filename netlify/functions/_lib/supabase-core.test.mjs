import test from "node:test";
import assert from "node:assert/strict";
import {
  callRpc,
  createPrivateSignedUrl,
  deletePrivateObject,
  env,
  json,
  readJsonRequest,
  readShared,
  resolveActor,
  uploadPrivateObject
} from "./supabase-core.mjs";

const AUTH_ID = "00000000-0000-4000-8000-000000000001";
const SERVICE = "test-service-role-secret";
const MAPPING = {
  legacy_id: "legacy-student-7",
  auth_user_id: AUTH_ID,
  username: "learner",
  display_name: "Learner",
  needs_password_reset: false
};
const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

async function withMockedSupabase(run, responder = () => undefined) {
  const priorFetch = globalThis.fetch;
  const priorEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
  Object.assign(process.env, {
    SUPABASE_URL: "https://supabase.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE
  });
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, method: options.method || "GET", headers: options.headers || {}, body: options.body });
    const custom = await responder(url, options, calls);
    if (custom) return custom;
    if (url.endsWith("/auth/v1/user")) return Response.json({ id: AUTH_ID });
    if (url.includes("/rest/v1/app_users?")) return Response.json([MAPPING]);
    return Response.json({ ok: true });
  };
  try { await run(calls); }
  finally {
    globalThis.fetch = priorFetch;
    for (const name of ENV_NAMES) {
      if (priorEnv[name] === undefined) delete process.env[name];
      else process.env[name] = priorEnv[name];
    }
  }
}

function actorRequest(authorization = "Bearer test-access-token") {
  return new Request("https://site.invalid/function", { headers: authorization ? { authorization } : {} });
}

function serviceAuth(call) {
  const headers = new Headers(call.headers);
  assert.equal(headers.get("apikey"), SERVICE);
  assert.equal(headers.get("authorization"), `Bearer ${SERVICE}`);
}

test("env prefers Netlify.env.get and falls back to local process.env", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "Netlify");
  process.env.SUPABASE_CORE_TEST_ENV = "from-process";
  Object.defineProperty(globalThis, "Netlify", { configurable: true, value: { env: { get: name => name === "SUPABASE_CORE_TEST_ENV" ? "from-netlify" : "" } } });
  try {
    assert.equal(env("SUPABASE_CORE_TEST_ENV"), "from-netlify");
    Object.defineProperty(globalThis, "Netlify", { configurable: true, value: { env: { get: () => { throw new Error("outside runtime"); } } } });
    assert.equal(env("SUPABASE_CORE_TEST_ENV"), "from-process");
  } finally {
    delete process.env.SUPABASE_CORE_TEST_ENV;
    if (original) Object.defineProperty(globalThis, "Netlify", original);
    else delete globalThis.Netlify;
  }
});

test("json helper sets safe JSON/cache headers and does not add CORS", async () => {
  const response = json({ ok: true }, 201);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.deepEqual(await response.json(), { ok: true });
});

test("bounded JSON request parser parses object payloads", async () => {
  const request = new Request("https://site.invalid/function", { method: "POST", body: JSON.stringify({ op: "read", n: 2 }) });
  assert.deepEqual(await readJsonRequest(request, 100), { op: "read", n: 2 });
});

test("bounded JSON request parser rejects declared and streamed oversized bodies", async () => {
  const declared = new Request("https://site.invalid/function", { method: "POST", headers: { "content-length": "1000" }, body: "{}" });
  await assert.rejects(readJsonRequest(declared, 10), error => error.status === 413 && error.code === "payload_too_large");
  const streamed = new Request("https://site.invalid/function", { method: "POST", body: JSON.stringify({ payload: "too big" }) });
  await assert.rejects(readJsonRequest(streamed, 5), error => error.status === 413 && error.code === "payload_too_large");
});

test("bounded JSON request parser rejects malformed, non-object, and invalid-length requests", async () => {
  const malformed = new Request("https://site.invalid/function", { method: "POST", body: "{" });
  await assert.rejects(readJsonRequest(malformed), error => error.status === 400 && error.code === "invalid_request");
  const array = new Request("https://site.invalid/function", { method: "POST", body: "[]" });
  await assert.rejects(readJsonRequest(array), error => error.status === 400 && error.code === "invalid_request");
  const invalidLength = new Request("https://site.invalid/function", { method: "POST", headers: { "content-length": "-2" }, body: "{}" });
  await assert.rejects(readJsonRequest(invalidLength), error => error.status === 400 && error.code === "invalid_request");
});

test("actor resolution verifies bearer token, maps one linked user, and returns no credentials", async () => {
  await withMockedSupabase(async calls => {
    const actor = await resolveActor(actorRequest());
    assert.equal(actor.actorId, MAPPING.legacy_id);
    assert.deepEqual(actor.mapping, MAPPING);
    assert.deepEqual(actor.authUser, { id: AUTH_ID });
    assert.equal(JSON.stringify(actor).includes(SERVICE), false);
    assert.equal(JSON.stringify(actor).includes("test-access-token"), false);
    const auth = calls.find(call => call.url.endsWith("/auth/v1/user"));
    assert.ok(auth);
    assert.equal(new Headers(auth.headers).get("authorization"), "Bearer test-access-token");
    const mapping = calls.find(call => call.url.includes("/rest/v1/app_users?"));
    assert.ok(mapping);
    serviceAuth(mapping);
    assert.match(mapping.url, /limit=2/);
  });
});

test("actor resolution rejects absent or invalid bearer tokens before database access", async () => {
  await withMockedSupabase(async calls => {
    await assert.rejects(resolveActor(actorRequest("")), error => error.status === 401 && error.code === "unauthorized");
    await assert.rejects(resolveActor(actorRequest("Basic wrong")), error => error.status === 401 && error.code === "unauthorized");
    assert.equal(calls.length, 0);
  });
});

test("actor resolution requires exactly one valid app_users mapping", async () => {
  for (const rows of [[], [MAPPING, MAPPING], [{ ...MAPPING, legacy_id: "" }], [{ ...MAPPING, auth_user_id: "someone-else" }]]) {
    await withMockedSupabase(async () => {
      await assert.rejects(resolveActor(actorRequest()), error => error.status === 403 && error.code === "account_not_linked");
    }, url => url.includes("/rest/v1/app_users?") ? Response.json(rows) : undefined);
  }
});

test("actor resolution rejects accounts requiring password reset", async () => {
  await withMockedSupabase(async () => {
    await assert.rejects(resolveActor(actorRequest()), error => error.status === 403 && error.code === "password_reset_required");
  }, url => url.includes("/rest/v1/app_users?") ? Response.json([{ ...MAPPING, needs_password_reset: true }]) : undefined);
});

test("readShared encodes the filter and uses only server-side service credentials", async () => {
  await withMockedSupabase(async calls => {
    const row = await readShared("a & b/#!");
    assert.deepEqual(row, { ok: true });
    const call = calls[0];
    serviceAuth(call);
    const url = new URL(call.url);
    assert.equal(url.pathname, "/rest/v1/shared");
    assert.equal(url.searchParams.get("id"), "eq.a & b/#!");
    assert.equal(url.searchParams.get("select"), "*");
    assert.equal(url.searchParams.get("limit"), "1");
  }, url => url.includes("/rest/v1/shared?") ? Response.json([{ ok: true }]) : undefined);
});

test("callRpc posts JSON through PostgREST with the service role and validates RPC names", async () => {
  await withMockedSupabase(async calls => {
    const result = await callRpc("student_profile_pref_cas", { p_patch: { notifPref: false } });
    assert.deepEqual(result, { ok: true });
    const call = calls[0];
    serviceAuth(call);
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).pathname, "/rest/v1/rpc/student_profile_pref_cas");
    assert.deepEqual(JSON.parse(call.body), { p_patch: { notifPref: false } });
    await assert.rejects(callRpc("bad/name", {}), error => error.status === 400 && error.code === "invalid_rpc");
  }, url => url.endsWith("/rest/v1/rpc/student_profile_pref_cas") ? Response.json({ ok: true }) : undefined);
});

test("private Storage upload uses encoded object paths and service role without returning it", async () => {
  await withMockedSupabase(async calls => {
    const result = await uploadPrivateObject("private-files", "user one/proof'!.png", new Uint8Array([1, 2, 3]), { contentType: "image/png" });
    assert.deepEqual(result, { Key: "proof" });
    const call = calls[0];
    serviceAuth(call);
    assert.equal(call.method, "POST");
    assert.equal(new URL(call.url).pathname, "/storage/v1/object/private-files/user%20one/proof%27%21.png");
    assert.equal(new Headers(call.headers).get("content-type"), "image/png");
    assert.equal(new Headers(call.headers).get("x-upsert"), "false");
    assert.equal(JSON.stringify(result).includes(SERVICE), false);
  }, url => url.includes("/storage/v1/object/private-files/") ? Response.json({ Key: "proof" }) : undefined);
});

test("private Storage helpers reject unsafe paths and oversized/unsupported uploads", async () => {
  await withMockedSupabase(async calls => {
    await assert.rejects(deletePrivateObject("private", "../escape"), error => error.code === "invalid_storage_path");
    await assert.rejects(uploadPrivateObject("private", "ok/file", "not bytes"), error => error.code === "invalid_upload");
    await assert.rejects(uploadPrivateObject("private", "ok/file", new Uint8Array(10 * 1024 * 1024 + 1)), error => error.status === 413);
    assert.equal(calls.length, 0);
  });
});

test("private Storage delete and signed URL helpers stay on the configured project origin", async () => {
  await withMockedSupabase(async calls => {
    assert.deepEqual(await deletePrivateObject("private", "folder/object.jpg"), { ok: true });
    const signed = await createPrivateSignedUrl("private", "folder/object.jpg", 300);
    assert.equal(signed, "https://supabase.example.invalid/storage/v1/object/sign/private/folder/object.jpg?token=mock");
    assert.equal(calls[0].method, "DELETE");
    serviceAuth(calls[0]);
    assert.equal(calls[1].method, "POST");
    serviceAuth(calls[1]);
    assert.deepEqual(JSON.parse(calls[1].body), { expiresIn: 300 });
    assert.equal(new URL(calls[1].url).pathname, "/storage/v1/object/sign/private/folder/object.jpg");
    await assert.rejects(createPrivateSignedUrl("private", "folder/object.jpg", 0), error => error.code === "invalid_expiry");
  }, url => url.endsWith("/object/sign/private/folder/object.jpg")
    ? Response.json({ signedURL: "/storage/v1/object/sign/private/folder/object.jpg?token=mock" })
    : new Response(null, { status: 204 }));
});

test("unexpected signed Storage URLs are rejected", async () => {
  await withMockedSupabase(async () => {
    await assert.rejects(createPrivateSignedUrl("private", "file.jpg"), error => error.status === 503 && error.code === "supabase_unavailable");
  }, url => url.includes("/object/sign/") ? Response.json({ signedURL: "https://attacker.invalid/file" }) : undefined);
});
