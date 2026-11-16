import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import handler, { parseOperation, MAX_BODY_BYTES, MAX_AYAT_TEXT, MAX_GAME_ANSWER } from "../functions/student-challenges.mjs";

const AUTH_ID = "00000000-0000-4000-8000-000000000001";
const SERVICE = "student-challenges-test-service-secret";
const MAPPING = { legacy_id: "student-7", auth_user_id: AUTH_ID, username: "learner", display_name: "Learner", needs_password_reset: false };
const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const UUID_2 = "00000000-0000-4000-8000-000000000002";

async function withMockedSupabase(run, { mapping = MAPPING, rpcResult = { ok: true, data: { ok: true } }, responder = () => undefined } = {}) {
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
    if (url.endsWith("/rest/v1/rpc/student_challenges_action")) return Response.json(rpcResult);
    return new Response(null, { status: 204 });
  };
  try { await run(calls); }
  finally {
    globalThis.fetch = oldFetch;
    for (const name of ENV_NAMES) oldEnv[name] === undefined ? delete process.env[name] : process.env[name] = oldEnv[name];
  }
}
function request(body, { authorization = "Bearer verified-token", method = "POST", contentType = "application/json" } = {}) {
  return new Request("https://app.invalid/.netlify/functions/student-challenges", {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(contentType ? { "content-type": contentType } : {}) },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });
}
async function invoke(body, options = {}) { return handler(request(body, options)); }
function rpcCall(calls) { return calls.find(call => call.url.endsWith("/rest/v1/rpc/student_challenges_action")); }
function assertService(call) {
  const headers = new Headers(call.headers);
  assert.equal(headers.get("apikey"), SERVICE);
  assert.equal(headers.get("authorization"), `Bearer ${SERVICE}`);
}

const validOps = [
  { op: "state" }, { op: "logs" }, { op: "weekly_answer", choiceIndex: 0 },
  { op: "ayat_submit", text: "آية كريمة" },
  { op: "leader_submissions" }, { op: "ayat_award_winner" },
  { op: "guess_start", gameId: UUID_2 }, { op: "guess_answer", gameId: UUID_2, answer: "المدينة" },
  { op: "wheel_spin", gameId: UUID_2 }
];

test("parser accepts only the finite challenge operation schemas", () => {
  for (const input of validOps) assert.equal(parseOperation(input).op, input.op);
  for (const input of [
    { op: "write", table: "shared", value: "x" },
    { op: "weekly_answer", choiceIndex: 0, correct: true },
    { op: "weekly_answer", choiceIndex: 9 },
    { op: "weekly_answer", choiceIndex: "0" },
    { op: "ayat_submit", text: "آية", ownerId: "victim" },
    { op: "ayat_submit", submissionId: UUID_2, text: "آية" },
    { op: "guess_answer", gameId: UUID_2, answer: "x", points: 1000 },
    { op: "wheel_spin", gameId: "../bad" },
    { op: "logs", cursor: "arbitrary" }
  ]) assert.throws(() => parseOperation(input), /invalid_request/);
});

test("text fields and request payloads are bounded and control characters are rejected", () => {
  assert.equal(MAX_AYAT_TEXT, 500);
  assert.equal(MAX_GAME_ANSWER, 120);
  assert.ok(MAX_BODY_BYTES < 20_000);
  assert.throws(() => parseOperation({ op: "ayat_submit", text: "x".repeat(501) }), /payload_too_large/);
  assert.throws(() => parseOperation({ op: "ayat_submit", text: "\u0001" }), /invalid_request/);
  assert.throws(() => parseOperation({ op: "guess_answer", gameId: UUID_2, answer: "x".repeat(121) }), /payload_too_large/);
});

test("rejects non-POST and wrong content type without CORS", async () => {
  const method = await handler(request(null, { method: "GET" }));
  assert.equal(method.status, 405);
  assert.equal(method.headers.has("access-control-allow-origin"), false);
  const type = await handler(request({ op: "state" }, { contentType: "text/plain" }));
  assert.equal(type.status, 400);
  assert.equal(type.headers.has("access-control-allow-origin"), false);
});

test("rejects unauthenticated requests before data access", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "state" }, { authorization: "" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(calls.length, 0);
  });
});

test("password-reset-required users are rejected before challenge RPC access", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "state" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "password_reset_required" });
    assert.equal(calls.some(call => call.url.endsWith("/rest/v1/rpc/student_challenges_action")), false);
  }, { mapping: { ...MAPPING, needs_password_reset: true } });
});

test("weekly answer passes only the choice and Auth-derived actor to service-role RPC", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "weekly_answer", choiceIndex: 0 });
    assert.equal(response.status, 200);
    const call = rpcCall(calls);
    assert.ok(call);
    assertService(call);
    const args = JSON.parse(call.body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "weekly_answer");
    assert.equal(args.p_choice_index, 0);
    assert.equal(args.p_answer, null);
    assert.equal(args.p_text, null);
    assert.equal(Object.hasOwn(args, "p_points"), false);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("weekly response never exposes answer-key fields and only returns sanitized server result", async () => {
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "state" });
    const text = JSON.stringify(await response.json());
    for (const key of ["correct_index", "correctIndex", "answerKey", "accepted_answers"]) assert.equal(text.includes(key), false);
  }, { rpcResult: { ok: true, data: { weekly: { question: "سؤال", options: ["أ", "ب", "ج", "د"], answered: false }, challengeTickets: 1, logs: [] } } });
});

test("Ayat submission sends only bounded text and lets SQL generate the record identity", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "ayat_submit", text: "آية محفوظة" });
    assert.equal(response.status, 200);
    const call = rpcCall(calls);
    assertService(call);
    const args = JSON.parse(call.body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_submission_id, null);
    assert.equal(args.p_text, "آية محفوظة");
    assert.equal(args.p_choice_index, null);
    assert.equal(Object.hasOwn(args, "p_owner_id"), false);
  });
});

test("current leader operations are forwarded without trusting client leader flags", async () => {
  await withMockedSupabase(async calls => {
    const forbidden = await invoke({ op: "ayat_award_winner", isLeader: true });
    assert.equal(forbidden.status, 400);
    assert.equal(calls.length, 0);
    const response = await invoke({ op: "leader_submissions" });
    assert.equal(response.status, 200);
    const call = rpcCall(calls);
    assert.equal(JSON.parse(call.body).p_auth_user_id, AUTH_ID);
    assert.equal(JSON.parse(call.body).p_op, "leader_submissions");
  }, { rpcResult: { ok: true, data: { submissions: [] } } });
});

test("game answers and wheel outcomes carry no client-computed reward amount", async () => {
  await withMockedSupabase(async calls => {
    const answerResponse = await invoke({ op: "guess_answer", gameId: UUID_2, answer: "المدينة" });
    assert.equal(answerResponse.status, 200);
    const answer = JSON.parse(rpcCall(calls).body);
    assert.equal(answer.p_game_id, UUID_2);
    assert.equal(answer.p_answer, "المدينة");
    assert.equal(Object.hasOwn(answer, "p_points"), false);
    const wheelResponse = await invoke({ op: "wheel_spin", gameId: "00000000-0000-4000-8000-000000000003" });
    assert.equal(wheelResponse.status, 200);
    const wheelCall = calls.find(call => call.url.endsWith("/rest/v1/rpc/student_challenges_action") && JSON.parse(call.body).p_op === "wheel_spin");
    const wheel = JSON.parse(wheelCall.body);
    assert.equal(wheel.p_op, "wheel_spin");
    assert.equal(wheel.p_answer, null);
  });
});

test("generic Supabase failures do not disclose database details", async () => {
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "state" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }, { responder: url => url.endsWith("/rest/v1/rpc/student_challenges_action") ? new Response("secret SQL and answer key", { status: 500 }) : undefined });
});

test("migration defines the exact seeded quiz bank and uses locked authoritative scoring", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/009_student_challenges.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/^\(\d,'(?:aqeedah|fiqh|hadith|tafsir|seerah|usul)',\d,/gm) || []).length, 30);
  assert.match(sql, /correct_index smallint not null check \(correct_index between 0 and 3\)/i);
  assert.match(sql, /v_week_index := mod\(v_week_hash,30\)/i);
  assert.match(sql, /p_choice_index=v_question\.correct_index/i);
  assert.match(sql, /primary key \(week_key, owner_legacy_id\)/i);
  assert.match(sql, /on conflict\(week_key,owner_legacy_id\) do nothing/i);
});

test("migration enforces private rows, verified mapping, current leader, and atomic point updates", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/009_student_challenges.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/i);
  assert.match(sql, /needs_password_reset=false/i);
  assert.match(sql, /where s\.id='weekLeaderId' for share/i);
  assert.match(sql, /p_op in \('leader_submissions','ayat_award_winner'\) and not v_is_leader/i);
  assert.match(sql, /where s\.id='users' for update/i);
  assert.match(sql, /where id='users' and version=v_users_version/i);
  assert.match(sql, /revoke all on table public\.student_challenge_questions[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(sql, /revoke all on function public\.student_challenges_action[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.student_challenges_action[\s\S]*?to service_role/i);
  assert.match(sql, /create table if not exists public\.student_challenge_winner_awards[\s\S]*?date_key date primary key/i);
  assert.match(sql, /create table if not exists public\.student_challenge_ticket_awards[\s\S]*?primary key \(owner_auth_user_id, date_key\)/i);
  assert.match(sql, /gen_random_uuid\(\)/i);
  assert.match(sql, /on conflict\(owner_auth_user_id,date_key\) do nothing/i);
  assert.match(sql, /ticketAwarded/i);
  assert.match(sql, /now\(\) at time zone 'Asia\/Riyadh'/i);
  assert.match(sql, /select g\.\* into v_game[\s\S]*?for update/i);
  assert.match(sql, /create table if not exists public\.student_challenge_submissions[\s\S]*?submission_text text not null check \(length\(submission_text\) between 1 and 500\)/i);
});
