const test = require("node:test");
const assert = require("node:assert/strict");

function loadAdapter() {
  const path = require.resolve("./supabase-data-adapter.js");
  delete require.cache[path];
  return require(path);
}

test("shared transaction reads the current version and sends it with a CAS write", async () => {
  const oldWindow = global.window;
  const calls = [];
  global.window = {
    hanabilaSupabaseAuth: {
      session: { access_token: "token" },
      async api(payload) {
        calls.push(payload);
        if (payload.op === "get") return { row: { id: payload.id, version: 7, data: { value: "[]" } } };
        return { ok: true };
      }
    }
  };
  try {
    const { SupabaseFirestoreAdapter } = loadAdapter();
    const db = new SupabaseFirestoreAdapter();
    const ref = db.collection("shared").doc("users");
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      assert.equal(snapshot.exists, true);
      assert.equal(snapshot.version, 7);
      tx.set(ref, { value: "[]" });
    });
    assert.deepEqual(calls, [
      { op: "get", table: "shared", id: "users" },
      { op: "set", table: "shared", id: "users", data: { value: "[]" }, expectedVersion: 7 }
    ]);
  } finally {
    if (oldWindow === undefined) delete global.window;
    else global.window = oldWindow;
  }
});

test("chat collection add sends only text to the server-owned identity operation", async () => {
  const oldWindow = global.window;
  const calls = [];
  global.window = {
    hanabilaSupabaseAuth: {
      session: { access_token: "token" },
      async api(payload) { calls.push(payload); return { id: "server-message-id" }; }
    }
  };
  try {
    const { SupabaseFirestoreAdapter } = loadAdapter();
    const db = new SupabaseFirestoreAdapter();
    const result = await db.collection("chat_messages").add({ text: "Hello", userId: "spoofed", authorName: "spoofed", seenBy: [] });
    assert.equal(result.id, "server-message-id");
    assert.deepEqual(calls, [{ op: "chat_send", text: "Hello" }]);
  } finally {
    if (oldWindow === undefined) delete global.window;
    else global.window = oldWindow;
  }
});

test("compatibility storage refuses legacy local session reads and writes", async () => {
  const oldWindow = global.window;
  global.window = {
    hanabilaSupabaseAuth: {
      session: { access_token: "token" },
      async api() { return { row: null }; }
    }
  };
  try {
    const { SupabaseFirestoreAdapter } = loadAdapter();
    assert.ok(SupabaseFirestoreAdapter);
    await assert.rejects(() => global.window.storage.get("session", false), { message: "legacy_local_session_disabled" });
    await assert.rejects(() => global.window.storage.set("rememberedLogin", "unsafe", false), { message: "legacy_local_session_disabled" });
  } finally {
    if (oldWindow === undefined) delete global.window;
    else global.window = oldWindow;
  }
});
