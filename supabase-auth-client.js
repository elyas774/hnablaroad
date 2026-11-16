/*
 * Browser client for the Netlify auth/data and validated feature gateways.
 * Tokens stay in sessionStorage, never in legacy remembered-login localStorage.
 * The service-role key is never present in this module.
 */
(() => {
  "use strict";
  const SESSION_KEY = "hanabila.supabase.session.v1";
  const AUTH_URL = "/.netlify/functions/auth";
  const DATA_URL = "/.netlify/functions/app-data";

  function browserSessionStorage() {
    try { return window.sessionStorage; }
    catch (_) { return { getItem() { return null; }, setItem() {}, removeItem() {} }; }
  }

  class HanabilaAuthClient {
    constructor({ fetcher, storage } = {}) {
      this.fetcher = fetcher;
      if (!this.fetcher && typeof window !== "undefined") this.fetcher = window.fetch.bind(window);
      this.storage = storage || (typeof window !== "undefined" ? browserSessionStorage() : null);
      this.session = null;
      this.user = null;
    }

    _clearLegacyBypasses() {
      if (typeof window === "undefined") return;
      try { window.localStorage.removeItem("session"); } catch (_) { /* Ignore. */ }
      try { window.localStorage.removeItem("rememberedLogin"); } catch (_) { /* Ignore. */ }
    }

    _readSession() {
      if (!this.storage) return null;
      try {
        const raw = this.storage.getItem(SESSION_KEY);
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && typeof saved.access_token === "string" && typeof saved.refresh_token === "string") return saved;
      } catch (_) { /* Ignore corrupt or unavailable browser storage. */ }
      return null;
    }

    _writeSession(session) {
      this.session = session || null;
      if (!this.storage) return;
      try {
        if (session) this.storage.setItem(SESSION_KEY, JSON.stringify(session));
        else this.storage.removeItem(SESSION_KEY);
      } catch (_) { /* Session remains in memory for this tab. */ }
    }

    async _post(url, payload, token) {
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await this.fetcher(url, { method: "POST", headers, body: JSON.stringify(payload) });
      let result = {};
      try { result = await response.json(); } catch (_) { /* Normalize non-JSON errors below. */ }
      if (!response.ok) {
        const error = new Error(result.error || "request_failed");
        error.code = result.error || "request_failed";
        error.status = response.status;
        throw error;
      }
      return result;
    }

    async signIn(username, password) {
      this._clearLegacyBypasses();
      this._writeSession(null);
      const result = await this._post(AUTH_URL, { action: "login", username, password });
      this._writeSession(result.session);
      this.user = result.user || null;
      return { user: this.user, needsPasswordReset: !!this.user?.needsPasswordReset };
    }

    async signUp({ name, username, email, phone, password }) {
      const result = await this._post(AUTH_URL, { action: "register", name, username, email, phone, password });
      return result;
    }

    async refresh() {
      const saved = this.session || this._readSession();
      if (!saved?.refresh_token) throw Object.assign(new Error("session_expired"), { code: "session_expired" });
      const result = await this._post(AUTH_URL, { action: "refresh", refreshToken: saved.refresh_token });
      this._writeSession(result.session);
      this.user = result.user || this.user;
      return result.session;
    }

    async restore() {
      this._clearLegacyBypasses();
      const saved = this._readSession();
      if (!saved) return null;
      this._writeSession(saved);
      const expiresAt = Number(saved.expires_at) || 0;
      if (!expiresAt || expiresAt <= Math.floor(Date.now() / 1000) + 60) await this.refresh();
      const result = await this.api({ op: "whoami" });
      this.user = result.user || null;
      return { user: this.user, needsPasswordReset: !!this.user?.needsPasswordReset };
    }

    async api(payload) {
      return this._authenticatedPost(DATA_URL, payload);
    }

    async _authenticatedPost(url, payload) {
      if (!this.session?.access_token) {
        const saved = this._readSession();
        if (!saved) throw Object.assign(new Error("session_expired"), { code: "session_expired" });
        this._writeSession(saved);
      }
      let expiresAt = Number(this.session.expires_at) || 0;
      if (!expiresAt || expiresAt <= Math.floor(Date.now() / 1000) + 60) await this.refresh();
      try {
        return await this._post(url, payload, this.session.access_token);
      } catch (error) {
        if (error.status !== 401) throw error;
        await this.refresh();
        return this._post(url, payload, this.session.access_token);
      }
    }

    feature(name, payload) {
      const allowed = new Set(["student-tasks", "student-exams", "student-leaves", "student-challenges", "student-social"]);
      if (!allowed.has(name)) throw Object.assign(new Error("unsupported_feature"), { code: "unsupported_feature" });
      return this._authenticatedPost(`/.netlify/functions/${name}`, payload);
    }

    resetTemporaryPassword(newPassword) {
      if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 128) {
        throw Object.assign(new Error("password_must_be_12_to_128_chars"), { code: "password_must_be_12_to_128_chars" });
      }
      return this.api({ op: "reset_password", newPassword });
    }

    changePassword(currentPassword, newPassword) {
      if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 256
          || typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 128
          || newPassword === currentPassword) {
        throw Object.assign(new Error("invalid_password_change"), { code: "invalid_password_change" });
      }
      return this._authenticatedPost(AUTH_URL, { action: "change_password", currentPassword, newPassword });
    }

    setNotificationPreference(enabled) {
      if (typeof enabled !== "boolean") {
        throw Object.assign(new Error("invalid_profile_patch"), { code: "invalid_profile_patch" });
      }
      return this.api({ op: "user_pref_patch", patch: { notifPref: enabled } });
    }

    markAttendance() {
      return this.api({ op: "attendance_mark" });
    }

    markNotificationsRead(ids) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 300
          || ids.some(id => typeof id !== "string" || !id || id.length > 160)) {
        throw Object.assign(new Error("invalid_notification_ids"), { code: "invalid_notification_ids" });
      }
      return this.api({ op: "notifications_seen", ids: [...new Set(ids)] });
    }

    async signOut() {
      const token = this.session?.access_token || this._readSession()?.access_token;
      try { await this._post(AUTH_URL, { action: "logout", accessToken: token || "" }); }
      finally {
        this._writeSession(null);
        this.user = null;
        this._clearLegacyBypasses();
      }
    }
  }

  if (typeof window !== "undefined") window.hanabilaSupabaseAuth = new HanabilaAuthClient();
  if (typeof module !== "undefined" && module.exports) module.exports = { HanabilaAuthClient };
})();
