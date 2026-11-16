import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import handler, { parseAttachment, parseOperation } from "../functions/student-exams.mjs";

const AUTH_ID = "00000000-0000-4000-8000-000000000001";
const SERVICE = "student-exams-test-service-secret";
const MAPPING = { legacy_id: "student-7", auth_user_id: AUTH_ID, username: "learner", display_name: "Learner", needs_password_reset: false };
const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const QUESTION_BANK = [{ id: "q1", question: "ما الجواب؟", answer: "الجواب الصحيح" }];
const PUBLISHED = [{ id: "exam-1", title: "اختبار", published: true, questions: [{ id: "p1", q: "اختر", type: "multiple", options: ["صح", "خطأ"], answer: "صح", explanation: "سر" }, { id: "p2", q: "اشرح", type: "essay", options: [], modelAnswer: "جواب نموذجي", explanation: "خاص" }] }];

async function withMockedSupabase(run, { mapping = MAPPING, rpcResult = { ok: true }, shared = {}, responder = () => undefined } = {}) {
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
    if (url.endsWith("/rest/v1/rpc/student_exams_action")) return Response.json(rpcResult);
    if (url.includes("/rest/v1/shared?")) {
      const key = new URL(url).searchParams.get("id")?.replace("eq.", "");
      return Response.json(Object.hasOwn(shared, key) ? [shared[key]] : []);
    }
    if (url.includes("/storage/v1/object/sign/")) return Response.json({ signedURL: `${new URL(url).pathname.replace("/storage/v1/", "")}?token=signed` });
    if (url.includes("/storage/v1/object/exam-attachments/")) return Response.json({ Key: "stored" });
    return new Response(null, { status: 204 });
  };
  try { await run(calls); }
  finally {
    globalThis.fetch = oldFetch;
    for (const name of ENV_NAMES) oldEnv[name] === undefined ? delete process.env[name] : process.env[name] = oldEnv[name];
  }
}
function request(body, { authorization = "Bearer verified-token", method = "POST", contentType = "application/json" } = {}) {
  return new Request("https://app.invalid/.netlify/functions/student-exams", {
    method, headers: { ...(authorization ? { authorization } : {}), ...(contentType ? { "content-type": contentType } : {}) },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {})
  });
}
async function invoke(body, opts = {}) { return handler(request(body, opts)); }
function rpcCall(calls) { return calls.find(c => c.url.endsWith("/rest/v1/rpc/student_exams_action")); }
function assertService(call) { const headers = new Headers(call.headers); assert.equal(headers.get("apikey"), SERVICE); assert.equal(headers.get("authorization"), `Bearer ${SERVICE}`); }

const submit = () => ({ op: "submit", kind: "question_bank", examId: "current", answers: [{ qid: "q1", given: "الجواب الصحيح" }] });

test("rejects non-POST requests without adding CORS headers", async () => {
  const response = await handler(request(null, { method: "GET" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.deepEqual(await response.json(), { error: "method_not_allowed" });
});

test("strict parser rejects arbitrary writes, client scores, keys, ownership and duplicate answers", () => {
  for (const invalid of [
    { op: "write", table: "shared", data: {} },
    { ...submit(), points: 999 },
    { ...submit(), answers: [{ qid: "q1", given: "x", isCorrect: true }] },
    { ...submit(), answers: [{ qid: "q1", given: "x" }, { qid: "q1", given: "y" }] },
    { op: "grade", kind: "published", examId: "exam-1", studentId: "victim", qid: "p1", points: 11 },
    { op: "review_queue" }
  ]) assert.throws(() => parseOperation(invalid), /invalid_request/);
});

test("published exam schema accepts bounded question/explanation fields but no arbitrary nested properties", () => {
  const exam = { id: "exam-2", title: "نحو", difficulty: "medium", questions: [
    { id: "a", q: "اختر", type: "multiple", options: ["أ", "ب"], answer: "أ", explanation: "سبب" },
    { id: "b", q: "اشرح", type: "essay", options: [], modelAnswer: "نموذج", explanation: "تفصيل" }
  ] };
  assert.equal(parseOperation({ op: "publish", exam }).exam.questions.length, 2);
  assert.throws(() => parseOperation({ op: "publish", exam: { ...exam, admin: true } }), /invalid_request/);
  assert.throws(() => parseOperation({ op: "publish", exam: { ...exam, questions: [{ ...exam.questions[0], private: "x" }, exam.questions[1]] } }), /invalid_request/);
});

test("attachment parsing enforces exact MIME, size and file signature", () => {
  assert.equal(parseAttachment("data:application/pdf;base64,JVBERi0xLjQ=").mime, "application/pdf");
  assert.throws(() => parseAttachment("data:image/jpeg;base64,AAAA"), /invalid_attachment/);
  assert.throws(() => parseAttachment("data:image/svg+xml;base64,PHN2Zz4="), /invalid_attachment/);
  assert.throws(() => parseAttachment(`data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}`), /attachment_too_large/);
});

test("missing Auth bearer is rejected before data, storage, or RPC access", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke(submit(), { authorization: "" });
    assert.equal(response.status, 401);
    assert.equal(calls.length, 0);
  });
});

test("password-reset-required mapped identities cannot access exams", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "mine" });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "password_reset_required" });
    assert.equal(calls.some(c => c.url.endsWith("/rest/v1/rpc/student_exams_action")), false);
  }, { mapping: { ...MAPPING, needs_password_reset: true } });
});

test("listing strips all correct answers, model answers, explanations, and archival keys", async () => {
  const shared = {
    examQuestions: { id: "examQuestions", data: { value: JSON.stringify(QUESTION_BANK) } },
    aiExams: { id: "aiExams", data: { value: JSON.stringify(PUBLISHED) } },
    examArchive: { id: "examArchive", data: { value: JSON.stringify([{ id: "old", question: "قديم", answer: "قديمًا" }]) } }
  };
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "list" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.questionBank, [{ id: "q1", question: "ما الجواب؟" }]);
    const serialized = JSON.stringify(body);
    for (const secret of ["الجواب الصحيح", "جواب نموذجي", "سر", "خاص", "قديمًا"]) assert.equal(serialized.includes(secret), false);
    assert.equal(calls.filter(c => c.url.includes("/rest/v1/shared?")).length, 3);
  }, { shared });
});

test("submission transmits only answer strings and Auth-derived owner; score and keys never come from client", async () => {
  const rpcResult = { ok: true, attemptId: "00000000-0000-4000-8000-000000000099", result: { answers: [{ qid: "q1", isCorrect: true, awardedPoints: 0 }], score: 1, total: 1, points: 0 } };
  await withMockedSupabase(async calls => {
    const response = await invoke(submit());
    assert.equal(response.status, 200);
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_op, "submit");
    assert.deepEqual(args.p_answers, [{ qid: "q1", given: "الجواب الصحيح" }]);
    assert.equal(args.p_points, null);
    assert.equal(args.p_target_user_id, null);
    assertService(rpcCall(calls));
    const body = await response.json();
    assert.equal(body.result.score, 1);
    assert.equal(JSON.stringify(body).includes("correctAnswer"), false);
    assert.equal(JSON.stringify(body).includes("الجواب الصحيح"), false);
  }, { rpcResult });
});

test("leader grade operation passes only discrete points to the atomic server RPC", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "grade", kind: "published", examId: "exam-1", studentId: "student-other", qid: "p2", points: 8 });
    assert.equal(response.status, 200);
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.equal(args.p_target_user_id, "student-other");
    assert.equal(args.p_points, 8);
    assert.equal(args.p_answers, null);
  });
});

test("leader authority is enforced by RPC and caller-supplied leader flags are rejected", async () => {
  await withMockedSupabase(async calls => {
    const bad = await invoke({ op: "question_add", question: "سؤال", answer: "جواب", isLeader: true });
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 0);
    const denied = await invoke({ op: "question_add", question: "سؤال", answer: "جواب" });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "forbidden" });
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_auth_user_id, AUTH_ID);
    assert.match(args.p_qid, /^[0-9a-f-]{36}$/i);
  }, { rpcResult: { ok: false, forbidden: true } });
});

test("question-management IDs are server-generated and no answer-bearing list is returned", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "question_add", question: "سؤال", answer: "سر" });
    assert.equal(response.status, 200);
    const args = JSON.parse(rpcCall(calls).body);
    assert.match(args.p_qid, /^[0-9a-f-]{36}$/i);
    assert.equal(args.p_question, "سؤال");
    assert.equal(args.p_answer, "سر");
    assert.equal(JSON.stringify(await response.json()).includes("سر"), false);
  });
});

test("private attachment is owner-scoped, path-bound to Auth UUID, and never returns raw path", async () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 0]).toString("base64")}`;
  const rpcResult = { ok: true, attemptId: "00000000-0000-4000-8000-000000000099", result: { score: 0, points: 0 } };
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...submit(), attachmentData: jpeg });
    assert.equal(response.status, 200);
    const uploaded = calls.find(c => c.url.includes("/storage/v1/object/exam-attachments/"));
    assert.ok(uploaded);
    assertService(uploaded);
    assert.match(new URL(uploaded.url).pathname, new RegExp(`/${AUTH_ID}/[0-9a-f-]+\\.jpg$`));
    const args = JSON.parse(rpcCall(calls).body);
    assert.equal(args.p_attachment_mime, "image/jpeg");
    assert.match(args.p_attachment_path, new RegExp(`^${AUTH_ID}/`));
    const body = await response.json();
    assert.ok(body.attachmentUrl.includes("token=signed"));
    assert.equal(Object.hasOwn(body, "attachment_path"), false);
  }, { rpcResult });
});

test("duplicate attempt cleans up newly uploaded private attachment and never double-submits", async () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 0]).toString("base64")}`;
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...submit(), attachmentData: jpeg });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, alreadySubmitted: true });
    assert.ok(calls.some(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/exam-attachments/")));
  }, { rpcResult: { ok: true, duplicate: true } });
});

test("ambiguous exam RPC failure preserves the uploaded attachment in case the attempt committed", async () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 0]).toString("base64")}`;
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...submit(), attachmentData: jpeg });
    assert.equal(response.status, 503);
    assert.ok(calls.some(c => c.url.endsWith("/rest/v1/rpc/student_exams_action")));
    assert.equal(calls.some(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/exam-attachments/")), false);
  }, { responder: url => url.endsWith("/rest/v1/rpc/student_exams_action") ? new Response("upstream timeout", { status: 500 }) : undefined });
});

test("definitive exam conflict cleans up the unreferenced uploaded attachment", async () => {
  const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 0]).toString("base64")}`;
  await withMockedSupabase(async calls => {
    const response = await invoke({ ...submit(), attachmentData: jpeg });
    assert.equal(response.status, 409);
    assert.ok(calls.some(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/exam-attachments/")));
  }, { rpcResult: { ok: false, conflict: true } });
});

test("student-side attachment lookup is denied before signing by the owner/leader RPC", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "attachment_url", attemptId: "00000000-0000-4000-8000-000000000099" });
    assert.equal(response.status, 404);
    assert.equal(calls.some(c => c.url.includes("/storage/v1/object/sign/")), false);
  }, { rpcResult: { ok: false } });
});

test("redo deletes its former private attachment only after atomic state transition", async () => {
  await withMockedSupabase(async calls => {
    const response = await invoke({ op: "redo", kind: "published", examId: "exam-1" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: "redone" });
    const deletion = calls.find(c => c.method === "DELETE" && c.url.includes("/storage/v1/object/exam-attachments/"));
    assert.ok(deletion);
    assertService(deletion);
  }, { rpcResult: { ok: true, result: { status: "redone", delete_path: `${AUTH_ID}/00000000-0000-4000-8000-000000000099.jpg` } } });
});

test("generic backend errors do not disclose SQL, answer keys, or secret material", async () => {
  await withMockedSupabase(async () => {
    const response = await invoke({ op: "mine" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
  }, { responder: url => url.endsWith("/rest/v1/rpc/student_exams_action") ? new Response("database secret detail", { status: 500 }) : undefined });
});

test("migration restricts attempts, RPC, storage and leadership to a fixed-search-path definer", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/007_student_exams.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/i);
  assert.match(sql, /revoke all on table public\.student_exam_attempts from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant execute on function public\.student_exams_action[\s\S]*?to service_role/i);
  assert.match(sql, /revoke all on function public\.student_exams_action[\s\S]*?from public, anon, authenticated/i);
  assert.match(sql, /for share/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /where status = 'submitted'/i);
  assert.match(sql, /public\s*=\s*false/i);
  assert.match(sql, /file_size_limit\s*,\s*allowed_mime_types[\s\S]*?2097152/i);
});

test("migration lets any authenticated leader review/grade and keeps question-bank attempts reachable after edits", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/007_student_exams.sql", import.meta.url), "utf8");
  const review = sql.slice(sql.indexOf("if p_op='review_queue'"), sql.indexOf("if p_op='question_add'"));
  const grade = sql.slice(sql.indexOf("if p_op='grade'"));
  assert.match(review, /v_exam_id\s*:=\s*'question_bank'/i);
  assert.doesNotMatch(review, /owner_legacy_id\s*=\s*v_actor/i);
  assert.doesNotMatch(grade, /owner_legacy_id\s*=\s*v_actor/i);
  assert.match(sql, /v_exam_id\s*:=\s*'question_bank'/i);
  assert.doesNotMatch(sql, /v_current_signature/);
});
