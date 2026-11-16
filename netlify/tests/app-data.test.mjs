import test from "node:test";
import assert from "node:assert/strict";
import handler, { cleanProjection, projectChatRow, projectSharedRow, studentCanReadSharedKey } from "../functions/app-data.mjs";

test("student projection removes credentials and sensitive other-student fields", () => {
  const row = {
    id: "student-other",
    username: "learner",
    email: "should-not-leak@example.invalid",
    password: "never-return",
    points: 12,
    attendance: { streak: 4, dates: ["2026-01-01"] },
    completedTasks: [{ proofKey: "private-proof" }]
  };
  const result = cleanProjection(row, false);
  assert.equal(result.username, "learner");
  assert.equal(result.points, 12);
  assert.deepEqual(result.attendance, { streak: 4 });
  assert.equal("email" in result, false);
  assert.equal("password" in result, false);
  assert.equal("completedTasks" in result, false);
});

test("actor keeps their own profile fields except legacy credentials", () => {
  const result = cleanProjection({ id: "self", password: "old", email: "private", completedTasks: [{ id: "task", proof: { token: "hidden", note: "safe" } }] }, true);
  assert.deepEqual(result, { id: "self", completedTasks: [{ id: "task", proof: { note: "safe" } }] });
});

test("exam attempts are available only through the validated exam feature gateway", () => {
  const result = cleanProjection({ id: "self", examResult: { answers: [{ correctAnswer: "secret" }] }, publishedExamResults: { exam: { answers: [{ modelAnswer: "secret" }] } } }, true);
  assert.deepEqual(result, { id: "self" });
});

test("student reads only explicitly cohort-safe shared documents plus projected users", () => {
  assert.equal(studentCanReadSharedKey("users"), true);
  assert.equal(studentCanReadSharedKey("meeting"), true);
  assert.equal(studentCanReadSharedKey("notifications"), true);
  assert.equal(studentCanReadSharedKey("excuses"), true);
  assert.equal(studentCanReadSharedKey("leaderAiDashboard"), false);
  assert.equal(studentCanReadSharedKey("examArchive"), false);
  const row = { id: "users", data: { value: JSON.stringify([{ id: "other", email: "hidden", points: 5 }]) }, version: 1 };
  const projected = projectSharedRow(row, "self", false);
  const parsed = JSON.parse(projected.data.value);
  assert.equal(parsed[0].points, 5);
  assert.equal("email" in parsed[0], false);
  const excuses = { id: "excuses", data: { value: JSON.stringify([{ userId: "other", text: "private" }, { userId: "self", text: "own" }]) } };
  assert.deepEqual(JSON.parse(projectSharedRow(excuses, "self", false).data.value), [{ userId: "self", text: "own" }]);
  assert.equal(projectSharedRow({ id: "leaderAiDashboard", data: {} }, "self", false), null);
});

test("leader user-list projection removes credentials and contact/token fields but keeps moderation data", () => {
  const row = { id: "users", data: { value: JSON.stringify([{ id: "student", email: "private", password: "old", phone: "private", fcmToken: "private", points: 20, completedTasks: [{ id: "task-1" }] }]) } };
  const projected = JSON.parse(projectSharedRow(row, "leader", true).data.value);
  assert.equal(projected[0].points, 20);
  assert.deepEqual(projected[0].completedTasks, [{ id: "task-1" }]);
  for (const key of ["email", "password", "phone", "fcmToken"]) assert.equal(key in projected[0], false);
});

test("student projections recursively redact sensitive fields from public shared JSON", () => {
  const row = { id: "posts", data: { value: JSON.stringify([{ id: "p1", text: "public", author: { name: "Student", email: "private" }, media: { token: "secret", label: "proof" } }]) } };
  const projected = JSON.parse(projectSharedRow(row, "student", false).data.value);
  assert.deepEqual(projected, [{ id: "p1", text: "public", author: { name: "Student" }, media: { label: "proof" } }]);
});

test("student exam-question projection never includes answers, correctness keys, or solutions", () => {
  const row = { id: "examQuestions", data: { value: JSON.stringify([{ id: "q1", question: "Question", options: ["A", "B"], answer: "A", correctIndex: 0, explanation: "Answer is A", rubric: { solutionKey: "private", text: "safe" } }]) } };
  const projected = JSON.parse(projectSharedRow(row, "student", false).data.value);
  assert.deepEqual(projected, [{ id: "q1", question: "Question", options: ["A", "B"], rubric: { text: "safe" } }]);
});

test("notification and weekly challenge projections hide other users' private state", () => {
  const notifications = { id: "notifications", data: { value: JSON.stringify([{ targetId: "all", message: "public", readBy: ["other"] }, { targetId: "other", message: "private" }, { targetId: "self", message: "own", readBy: ["self", "other"] }]) } };
  assert.deepEqual(JSON.parse(projectSharedRow(notifications, "self", false).data.value).map(x => x.message), ["public", "own"]);
  assert.deepEqual(JSON.parse(projectSharedRow(notifications, "self", false).data.value).map(x => x.readBy), [[], ["self"]]);
  const challenge = { id: "weeklyChallenge", data: { value: JSON.stringify({ weekKey: "wk", answeredBy: [{ userId: "other", correct: true }, { userId: "self", correct: false }] }) } };
  assert.deepEqual(JSON.parse(projectSharedRow(challenge, "self", false).data.value).answeredBy, [{ userId: "self", correct: false }]);
});

test("chat text is cohort-visible without attachment URLs; media rows are owner/leader only", () => {
  const text = { id: "m1", data: { userId: "other", type: "text", text: "hi", mediaUrl: "private-url", mediaPath: "private-path" } };
  const visible = projectChatRow(text, "self", false);
  assert.equal(visible.data.text, "hi");
  assert.equal("mediaUrl" in visible.data, false);
  const media = { id: "m2", data: { userId: "other", type: "image", mediaUrl: "private-url" } };
  assert.equal(projectChatRow(media, "self", false), null);
  assert.equal(projectChatRow(media, "other", false), media);
  assert.equal(projectChatRow(media, "self", true), media);
});

async function withFakeSupabase(mapping, run, customFetch = () => undefined) {
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
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    const custom = await customFetch(String(url), options, calls);
    if (custom) return custom;
    if (String(url).endsWith("/auth/v1/user")) return Response.json({ id: "00000000-0000-4000-8000-000000000001" });
    if (String(url).includes("/rest/v1/app_users?") && options.method !== "PATCH") return Response.json([mapping]);
    if (String(url).includes("/auth/v1/admin/users/")) return Response.json({ id: "00000000-0000-4000-8000-000000000001" });
    if (String(url).includes("/rest/v1/app_users?") && options.method === "PATCH") return new Response(null, { status: 204 });
    if (String(url).includes("/rest/v1/shared?")) return Response.json([]);
    return Response.json([], { status: 200 });
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

async function invoke(body) {
  return handler(new Request("https://site.invalid/.netlify/functions/app-data", {
    method: "POST",
    headers: { authorization: "Bearer test-access-token", "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
}

test("temporary-password accounts are blocked from data until reset", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: true }, async () => {
    const response = await invoke({ op: "get", table: "shared", id: "meeting" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "password_reset_required");
  });
});

test("password reset calls Auth admin and only then clears the reset-required flag", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: true }, async calls => {
    const response = await invoke({ op: "reset_password", newPassword: "test-password-long-enough" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { passwordReset: true });
    assert.equal(calls.some(c => c.url.includes("/auth/v1/admin/users/") && c.method === "PUT"), true);
    assert.equal(calls.some(c => c.url.includes("/rest/v1/app_users?") && c.method === "PATCH"), true);
  });
});

test("student notification preference update uses the self-only CAS RPC without leader role", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async calls => {
    const response = await invoke({ op: "user_pref_patch", patch: { notifPref: false } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, version: 9 });
    const rpc = calls.find(call => call.url.endsWith("/rest/v1/rpc/student_profile_pref_cas"));
    assert.ok(rpc);
    assert.deepEqual(JSON.parse(rpc.body), {
      p_auth_user_id: "00000000-0000-4000-8000-000000000001",
      p_expected: 8,
      p_patch: { notifPref: false }
    });
    assert.equal(calls.some(call => call.url.includes("id=eq.weekLeaderId")), false);
  }, (url) => {
    if (url.includes("/rest/v1/shared?id=eq.users")) {
      return Response.json([{ id: "users", data: { value: "[]" }, version: 8 }]);
    }
    if (url.endsWith("/rest/v1/rpc/student_profile_pref_cas")) return Response.json(true);
    return undefined;
  });
});

test("student preference operation rejects point/password/unknown-field changes before reading state", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async calls => {
    const response = await invoke({ op: "user_pref_patch", patch: { notifPref: true, points: 999, password: "nope" } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_profile_patch" });
    assert.equal(calls.some(call => call.url.includes("/rest/v1/shared?")), false);
    assert.equal(calls.some(call => call.url.includes("student_profile_pref_cas")), false);
  });
});

test("student preference update reports a stale shared-state version conflict", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async () => {
    const response = await invoke({ op: "user_pref_patch", patch: { notifPref: true } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "write_conflict" });
  }, url => {
    if (url.includes("/rest/v1/shared?id=eq.users")) {
      return Response.json([{ id: "users", data: { value: "[]" }, version: 8 }]);
    }
    if (url.endsWith("/rest/v1/rpc/student_profile_pref_cas")) return Response.json(false);
    return undefined;
  });
});

test("student notification read update sends bounded IDs to the self-only CAS RPC", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async calls => {
    const response = await invoke({ op: "notifications_seen", ids: ["n-1", "n-2", "n-1"] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, version: 4 });
    const rpc = calls.find(call => call.url.endsWith("/rest/v1/rpc/student_notifications_seen_cas"));
    assert.ok(rpc);
    assert.deepEqual(JSON.parse(rpc.body), {
      p_auth_user_id: "00000000-0000-4000-8000-000000000001",
      p_expected: 3,
      p_ids: ["n-1", "n-2"]
    });
    assert.equal(calls.some(call => call.url.includes("id=eq.weekLeaderId")), false);
  }, url => {
    if (url.includes("/rest/v1/shared?id=eq.notifications")) {
      return Response.json([{ id: "notifications", data: { value: "[]" }, version: 3 }]);
    }
    if (url.endsWith("/rest/v1/rpc/student_notifications_seen_cas")) return Response.json(true);
    return undefined;
  });
});

test("notification read operation rejects invalid IDs before reading shared state", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async calls => {
    const response = await invoke({ op: "notifications_seen", ids: ["valid", { id: "not-a-string" }] });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_notification_ids" });
    assert.equal(calls.some(call => call.url.includes("/rest/v1/shared?")), false);
    assert.equal(calls.some(call => call.url.includes("student_notifications_seen_cas")), false);
  });
});

test("notification read operation returns a conflict if shared state changed after read", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async () => {
    const response = await invoke({ op: "notifications_seen", ids: ["n-1"] });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "write_conflict" });
  }, url => {
    if (url.includes("/rest/v1/shared?id=eq.notifications")) {
      return Response.json([{ id: "notifications", data: { value: "[]" }, version: 3 }]);
    }
    if (url.endsWith("/rest/v1/rpc/student_notifications_seen_cas")) return Response.json(false);
    return undefined;
  });
});

test("attendance mark RPC ignores client-supplied dates and point amounts", async () => {
  const attendance = { dates: ["2026-11-14"], streak: 4, lastDate: "2026-11-14" };
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async calls => {
    const response = await invoke({ op: "attendance_mark", date: "2099-01-01", points: 9999, patch: { points: 9999 } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, alreadyRecorded: false, attendance, points: 23, totalPoints: 53, version: 9 });
    const rpc = calls.find(call => call.url.endsWith("/rest/v1/rpc/student_attendance_mark_cas"));
    assert.ok(rpc);
    assert.deepEqual(JSON.parse(rpc.body), { p_auth_user_id: "00000000-0000-4000-8000-000000000001", p_expected: 8 });
  }, url => {
    if (url.includes("/rest/v1/shared?id=eq.users")) return Response.json([{ id: "users", data: { value: "[]" }, version: 8 }]);
    if (url.endsWith("/rest/v1/rpc/student_attendance_mark_cas")) return Response.json({ ok: true, alreadyRecorded: false, attendance, points: 23, totalPoints: 53, version: 9 });
    return undefined;
  });
});

test("attendance mark maps stale versions to conflict and leave pauses to a safe result", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async () => {
    const response = await invoke({ op: "attendance_mark" });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "write_conflict" });
  }, url => {
    if (url.includes("/rest/v1/shared?id=eq.users")) return Response.json([{ id: "users", data: { value: "[]" }, version: 8 }]);
    if (url.endsWith("/rest/v1/rpc/student_attendance_mark_cas")) return Response.json({ ok: false, conflict: true });
    return undefined;
  });

  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async () => {
    const response = await invoke({ op: "attendance_mark" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, reason: "attendance_paused" });
  }, url => {
    if (url.includes("/rest/v1/shared?id=eq.users")) return Response.json([{ id: "users", data: { value: "[]" }, version: 8 }]);
    if (url.endsWith("/rest/v1/rpc/student_attendance_mark_cas")) return Response.json({ ok: false, reason: "attendance_paused" });
    return undefined;
  });
});

test("chat deletion uses the exact version whose ownership was checked", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async calls => {
    const response = await invoke({ op: "chat_delete", table: "chat_messages", id: "message-1" });
    assert.equal(response.status, 409);
    const deletion = calls.find(c => c.method === "DELETE");
    assert.match(deletion.url, /id=eq\.message-1&version=eq\.7/);
  }, (url, options) => {
    if (url.includes("/rest/v1/shared?")) return Response.json([{ id: "weekLeaderId", data: { value: "someone-else" }, version: 1 }]);
    if (url.includes("/rest/v1/chat_messages?") && options.method !== "DELETE") return Response.json([{ id: "message-1", data: { userId: "student-1", type: "text" }, version: 7 }]);
    if (url.includes("/rest/v1/chat_messages?") && options.method === "DELETE") return Response.json([]);
    return undefined;
  });
});

test("chat edit conflicts if ownership-checked message version changed", async () => {
  let reads = 0;
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "learner", display_name: "Learner", needs_password_reset: false }, async calls => {
    const response = await invoke({ op: "chat_edit", table: "chat_messages", id: "message-1", text: "updated" });
    assert.equal(response.status, 409);
    assert.equal(calls.some(c => c.method === "PATCH"), false);
  }, (url, options) => {
    if (url.includes("/rest/v1/shared?")) return Response.json([{ id: "weekLeaderId", data: { value: "someone-else" }, version: 1 }]);
    if (url.includes("/rest/v1/chat_messages?") && options.method !== "PATCH") {
      reads += 1;
      const version = reads === 1 ? 7 : 8;
      return Response.json([{ id: "message-1", data: { userId: "student-1", type: "text", text: "original" }, version }]);
    }
    return undefined;
  });
});


test("legacy leave and excuse documents are read-only even to the current leader through generic mutations", async () => {
  await withFakeSupabase({ legacy_id: "student-1", auth_user_id: "00000000-0000-4000-8000-000000000001", username: "leader", display_name: "Leader", needs_password_reset: false }, async calls => {
    for (const id of ["leaveRequests", "excuses"]) {
      for (const op of ["set", "patch"]) {
        const payload = op === "set"
          ? { op, table: "shared", id, expectedVersion: 1, data: { value: "[]" } }
          : { op, table: "shared", id, patch: { value: "[]" } };
        const response = await invoke(payload);
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: "feature_gateway_required" });
      }
    }
    assert.equal(calls.some(call => call.url.includes("leader_shared_cas") || call.url.includes("leader_shared_patch")), false);
  }, url => {
    if (url.includes("/rest/v1/shared?id=eq.weekLeaderId")) return Response.json([{ id: "weekLeaderId", data: { value: "student-1" }, version: 1 }]);
    return undefined;
  });
});
