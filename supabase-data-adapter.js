/*
 * Compatibility bridge for Hanabla Road's remaining Firestore-shaped reads.
 * All requests go through authenticated Netlify Functions; Supabase service-role
 * credentials and direct REST access never enter the browser. Shared writes are
 * leader-only and version-checked by app-data. Student-specific changes must use
 * their dedicated feature gateways, not this compatibility surface.
 */
(() => {
  "use strict";
  const auth = () => window.hanabilaSupabaseAuth;
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const randomId = () => globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  class DocSnapshot {
    constructor(id, row) { this.id = id; this._row = row || null; this.exists = !!row; this.version = Number(row?.version) || 0; }
    data() { return this._row ? clone(this._row.data || {}) : undefined; }
  }

  class QuerySnapshot {
    constructor(rows, changes = []) {
      this.docs = rows.map(row => new DocSnapshot(row.id, row));
      this.empty = this.docs.length === 0;
      this.size = this.docs.length;
      this._changes = changes;
    }
    forEach(callback) { this.docs.forEach(callback); }
    docChanges() { return this._changes; }
  }

  class DocumentRef {
    constructor(db, table, id) { this.db = db; this.table = table; this.id = id; }
    async get() {
      const result = await auth().api({ op: "get", table: this.table, id: this.id });
      return new DocSnapshot(this.id, result.row || null);
    }
    async set(data, options = {}) {
      if (this.table !== "shared") throw Object.assign(new Error("unsupported_write"), { code: "unsupported_write" });
      let expectedVersion = options.expectedVersion;
      if (!Number.isSafeInteger(Number(expectedVersion))) expectedVersion = (await this.get()).version;
      return auth().api({ op: "set", table: "shared", id: this.id, data: clone(data), expectedVersion: Number(expectedVersion) || 0 });
    }
    async update(patch) {
      if (this.table === "chat_messages") {
        if (typeof patch?.text !== "string") throw Object.assign(new Error("unsupported_chat_patch"), { code: "unsupported_chat_patch" });
        return auth().api({ op: "chat_edit", table: "chat_messages", id: this.id, text: patch.text });
      }
      return auth().api({ op: "patch", table: this.table, id: this.id, patch: clone(patch) });
    }
    async delete() {
      if (this.table !== "chat_messages") throw Object.assign(new Error("unsupported_delete"), { code: "unsupported_delete" });
      return auth().api({ op: "chat_delete", table: "chat_messages", id: this.id });
    }
    onSnapshot(onNext, onError) { return this.db._listenDocument(this, onNext, onError); }
    collection(name) { return new CollectionRef(this.db, `${this.table}/${this.id}/${name}`); }
  }

  class CollectionRef {
    constructor(db, table) { this.db = db; this.table = table; this.filters = []; this.sort = null; this.limit = null; }
    doc(id) { return new DocumentRef(this.db, this.table, id || randomId()); }
    where(field, operator, value) { const query = this._copy(); query.filters.push([field, operator, value]); return query; }
    orderBy(field, direction = "asc") { const query = this._copy(); query.sort = [field, direction]; return query; }
    limitToLast(count) { const query = this._copy(); query.limit = Math.max(1, Math.min(1000, Number(count) || 1)); return query; }
    limit(count) { const query = this._copy(); query.limit = Math.max(1, Math.min(1000, Number(count) || 1)); return query; }
    _copy() { const query = new CollectionRef(this.db, this.table); query.filters = [...this.filters]; query.sort = this.sort && [...this.sort]; query.limit = this.limit; return query; }
    async _rows() {
      if (!new Set(["shared", "chat_messages"]).has(this.table)) throw Object.assign(new Error("invalid_table"), { code: "invalid_table" });
      const result = await auth().api({ op: "list", table: this.table });
      let rows = Array.isArray(result.rows) ? result.rows.slice() : [];
      for (const [field, op, expected] of this.filters) {
        rows = rows.filter(row => {
          const actual = row.data?.[field];
          if (op === "==" || op === "===") return actual === expected;
          if (op === "!=") return actual !== expected;
          if (op === "in") return Array.isArray(expected) && expected.includes(actual);
          return false;
        });
      }
      if (this.sort) {
        const [field, direction] = this.sort;
        rows.sort((a, b) => {
          const av = a.data?.[field]; const bv = b.data?.[field];
          const compared = String(av ?? "").localeCompare(String(bv ?? ""));
          return direction === "desc" ? -compared : compared;
        });
      }
      if (this.limit !== null) rows = rows.slice(-this.limit);
      return rows;
    }
    async get() { const rows = await this._rows(); return new QuerySnapshot(rows, rows.map(row => ({ type: "added", doc: new DocSnapshot(row.id, row) }))); }
    async add(data) {
      if (this.table !== "chat_messages") throw Object.assign(new Error("unsupported_write"), { code: "unsupported_write" });
      const text = typeof data?.text === "string" ? data.text : "";
      const result = await auth().api({ op: "chat_send", text });
      return { id: result.id, get: () => this.doc(result.id).get() };
    }
    onSnapshot(onNext, onError) { return this.db._listenCollection(this, onNext, onError); }
  }

  class SupabaseFirestoreAdapter {
    constructor() { this._listeners = new Set(); }
    collection(name) { return new CollectionRef(this, name); }
    settings() { return this; }
    async runTransaction(callback) {
      const reads = new Map();
      const writes = [];
      const tx = {
        get: async ref => {
          const snapshot = await ref.get();
          reads.set(`${ref.table}/${ref.id}`, snapshot.version);
          return snapshot;
        },
        set: (ref, data) => writes.push({ ref, data })
      };
      const value = await callback(tx);
      if (writes.length > 1) throw Object.assign(new Error("multi_document_transaction_unsupported"), { code: "multi_document_transaction_unsupported" });
      for (const write of writes) {
        const key = `${write.ref.table}/${write.ref.id}`;
        await write.ref.set(write.data, { expectedVersion: reads.get(key) ?? 0 });
      }
      return value;
    }
    batch() {
      const operations = [];
      return {
        set: (ref, data) => operations.push(() => ref.set(data)),
        update: (ref, data) => operations.push(() => ref.update(data)),
        delete: ref => operations.push(() => ref.delete()),
        commit: async () => {
          if (operations.length !== 1) throw Object.assign(new Error("multi_operation_batch_unsupported"), { code: "multi_operation_batch_unsupported" });
          return operations[0]();
        }
      };
    }
    _listenDocument(ref, onNext, onError) {
      let last = Symbol("initial");
      const poll = async () => {
        if (!auth()?.session?.access_token) return;
        try {
          const snapshot = await ref.get();
          const signature = JSON.stringify(snapshot.data() ?? null);
          if (signature === last) return;
          last = signature;
          onNext(snapshot);
        } catch (error) { if (typeof onError === "function") onError(error); }
      };
      void poll();
      const timer = setInterval(poll, 12000);
      this._listeners.add(timer);
      return () => { clearInterval(timer); this._listeners.delete(timer); };
    }
    _listenCollection(query, onNext, onError) {
      let previous = new Map();
      const poll = async () => {
        if (!auth()?.session?.access_token) return;
        try {
          const rows = await query._rows();
          const current = new Map(rows.map(row => [row.id, row]));
          const changes = [];
          for (const [id, row] of current) {
            const old = previous.get(id);
            if (!old) changes.push({ type: "added", doc: new DocSnapshot(id, row) });
            else if (JSON.stringify(old) !== JSON.stringify(row)) changes.push({ type: "modified", doc: new DocSnapshot(id, row) });
          }
          for (const [id, row] of previous) if (!current.has(id)) changes.push({ type: "removed", doc: new DocSnapshot(id, row) });
          if (changes.length) onNext(new QuerySnapshot(rows, changes));
          previous = current;
        } catch (error) { if (typeof onError === "function") onError(error); }
      };
      void poll();
      const timer = setInterval(poll, 12000);
      this._listeners.add(timer);
      return () => { clearInterval(timer); this._listeners.delete(timer); };
    }
    stopAll() { for (const timer of this._listeners) clearInterval(timer); this._listeners.clear(); }
  }

  const db = new SupabaseFirestoreAdapter();
  window.hanabilaSupabaseDb = db;
  window.hanabilaSupabaseStorage = {
    ref(path = "") {
      const fullPath = String(path);
      return {
        child(childPath) { return window.hanabilaSupabaseStorage.ref(`${fullPath}/${childPath}`); },
        async delete() { return undefined; },
        async put() { throw Object.assign(new Error("private_upload_requires_feature_gateway"), { code: "private_upload_requires_feature_gateway" }); },
        async getDownloadURL() { throw Object.assign(new Error("private_download_requires_feature_gateway"), { code: "private_download_requires_feature_gateway" }); }
      };
    }
  };
  window.storage = {
    async get(key, shared) {
      if (!shared) throw new Error("legacy_local_session_disabled");
      const snapshot = await db.collection("shared").doc(key).get();
      if (!snapshot.exists) throw new Error("not found");
      return { key, value: snapshot.data()?.value, shared: true, version: snapshot.version };
    },
    async set(key, value, shared) {
      if (!shared) throw new Error("legacy_local_session_disabled");
      const ref = db.collection("shared").doc(key);
      const snapshot = await ref.get();
      await ref.set({ value }, { expectedVersion: snapshot.version });
      return { key, value, shared: true };
    },
    async delete(key, shared) {
      if (!shared) throw new Error("legacy_local_session_disabled");
      throw Object.assign(new Error("shared_delete_requires_feature_gateway"), { code: "shared_delete_requires_feature_gateway" });
    },
    async list(prefix, shared) {
      if (!shared) throw new Error("legacy_local_session_disabled");
      const snapshot = await db.collection("shared").get();
      let keys = snapshot.docs.map(doc => doc.id);
      if (prefix) keys = keys.filter(key => key.startsWith(prefix));
      return { keys, shared: true };
    }
  };
  window.hanabilaSupabaseStorageApi = window.storage;
  if (typeof module !== "undefined" && module.exports) module.exports = { SupabaseFirestoreAdapter };
})();
