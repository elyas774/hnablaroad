const test = require("node:test");
const assert = require("node:assert/strict");
const { HanabilaAuthClient } = require("./supabase-auth-client.js");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

const session = {
  access_token: "access-test",
  refresh_token: "refresh-test",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "auth-id" }
};

test("sign-in stores the Auth session in sessionStorage, not legacy local storage", async () => {
  const store = new MemoryStorage();
  let requested;
  const client = new HanabilaAuthClient({
    storage: store,
    fetcher: async (url, options) => {
      requested = { url, options };
      return response({ session, user: { id: "legacy-id", username: "learner", needsPasswordReset: true } });
    }
  });
  const result = await client.signIn("learner", "temporary-password");
  assert.equal(requested.url, "/.netlify/functions/auth");
  assert.equal(JSON.parse(store.getItem("hanabila.supabase.session.v1")).refresh_token, "refresh-test");
  assert.equal(result.needsPasswordReset, true);
});

test("gateway requests use the current Supabase bearer token", async () => {
  const client = new HanabilaAuthClient({
    storage: new MemoryStorage(),
    fetcher: async (url, options) => {
      assert.equal(url, "/.netlify/functions/app-data");
      assert.equal(options.headers.authorization, "Bearer access-test");
      return response({ user: { id: "legacy-id" } });
    }
  });
  client.session = session;
  assert.deepEqual(await client.api({ op: "whoami" }), { user: { id: "legacy-id" } });
});

test("temporary password reset sends the new password only to the authenticated server endpoint", async () => {
  let request;
  const client = new HanabilaAuthClient({
    storage: new MemoryStorage(),
    fetcher: async (url, options) => { request = { url, options }; return response({ passwordReset: true }); }
  });
  client.session = session;
  assert.deepEqual(await client.resetTemporaryPassword("new-password-123"), { passwordReset: true });
  assert.equal(request.url, "/.netlify/functions/app-data");
  assert.deepEqual(JSON.parse(request.options.body), { op: "reset_password", newPassword: "new-password-123" });
  assert.equal(request.options.headers.authorization, "Bearer access-test");
  assert.throws(() => client.resetTemporaryPassword("short"), { code: "password_must_be_12_to_128_chars" });
});

test("general password change sends both passwords only to the authenticated Auth endpoint", async () => {
  let request;
  const client = new HanabilaAuthClient({
    storage: new MemoryStorage(),
    fetcher: async (url, options) => { request = { url, options }; return response({ ok: true }); }
  });
  client.session = session;
  assert.deepEqual(await client.changePassword("old-password", "new-password-long"), { ok: true });
  assert.equal(request.url, "/.netlify/functions/auth");
  assert.equal(request.options.headers.authorization, "Bearer access-test");
  assert.deepEqual(JSON.parse(request.options.body), {
    action: "change_password", currentPassword: "old-password", newPassword: "new-password-long"
  });
  assert.throws(() => client.changePassword("same-password-long", "same-password-long"), { code: "invalid_password_change" });
});

test("feature requests are restricted to named server gateways and carry the bearer token", async () => {
  let request;
  const client = new HanabilaAuthClient({
    storage: new MemoryStorage(),
    fetcher: async (url, options) => { request = { url, options }; return response({ ok: true }); }
  });
  client.session = session;
  await client.feature("student-tasks", { op: "mine" });
  assert.equal(request.url, "/.netlify/functions/student-tasks");
  assert.equal(request.options.headers.authorization, "Bearer access-test");
  assert.deepEqual(JSON.parse(request.options.body), { op: "mine" });
  assert.throws(() => client.feature("arbitrary-endpoint", {}), { code: "unsupported_feature" });
});

test("student self-service helpers send only the scoped gateway payloads", async () => {
  const requests = [];
  const client = new HanabilaAuthClient({
    storage: new MemoryStorage(),
    fetcher: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return response({ ok: true });
    }
  });
  client.session = session;
  await client.setNotificationPreference(false);
  await client.markNotificationsRead(["n-1", "n-2", "n-1"]);
  await client.markAttendance();
  assert.deepEqual(requests, [
    { op: "user_pref_patch", patch: { notifPref: false } },
    { op: "notifications_seen", ids: ["n-1", "n-2"] },
    { op: "attendance_mark" }
  ]);
});

test("student self-service helpers reject invalid inputs before sending a request", () => {
  let requests = 0;
  const client = new HanabilaAuthClient({
    storage: new MemoryStorage(),
    fetcher: async () => { requests += 1; return response({ ok: true }); }
  });
  client.session = session;
  assert.throws(() => client.setNotificationPreference("false"), { code: "invalid_profile_patch" });
  assert.throws(() => client.markNotificationsRead([]), { code: "invalid_notification_ids" });
  assert.throws(() => client.markNotificationsRead(["n-1", 3]), { code: "invalid_notification_ids" });
  assert.equal(requests, 0);
});

test("expired sessions refresh before the data gateway is called", async () => {
  const store = new MemoryStorage();
  store.setItem("hanabila.supabase.session.v1", JSON.stringify({ ...session, expires_at: 1 }));
  const calls = [];
  const client = new HanabilaAuthClient({
    storage: store,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      if (url === "/.netlify/functions/auth") {
        return response({ session: { ...session, access_token: "fresh-access", expires_at: Math.floor(Date.now() / 1000) + 3600 }, user: { id: "legacy-id" } });
      }
      return response({ ok: true });
    }
  });
  await client.api({ op: "whoami" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/.netlify/functions/auth");
  assert.equal(calls[1].options.headers.authorization, "Bearer fresh-access");
});

test("sign-out clears both the Supabase session and legacy localStorage bypasses", async () => {
  const oldWindow = global.window;
  const legacy = new MemoryStorage();
  legacy.setItem("session", "old-session");
  legacy.setItem("rememberedLogin", "old-remembered-login");
  global.window = { localStorage: legacy };
  try {
    const store = new MemoryStorage();
    const client = new HanabilaAuthClient({ storage: store, fetcher: async () => response({ ok: true }) });
    client.session = session;
    store.setItem("hanabila.supabase.session.v1", JSON.stringify(session));
    await client.signOut();
    assert.equal(store.getItem("hanabila.supabase.session.v1"), null);
    assert.equal(legacy.getItem("session"), null);
    assert.equal(legacy.getItem("rememberedLogin"), null);
  } finally {
    if (oldWindow === undefined) delete global.window;
    else global.window = oldWindow;
  }
});
