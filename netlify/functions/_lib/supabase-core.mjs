/* Shared server-only Supabase helpers for Netlify Functions.
 * Service-role credentials are read only on the server and are never returned.
 */

const DEFAULT_JSON_LIMIT = 64 * 1024;
const MAX_STORAGE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MAPPING_FIELDS = "legacy_id,auth_user_id,username,display_name,needs_password_reset";

function problem(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

/** Read environment values from the Netlify Functions runtime, with Node env for local tests. */
export function env(name) {
  try {
    const value = globalThis.Netlify?.env?.get?.(name);
    if (typeof value === "string" && value.length) return value;
  } catch (_) { /* Netlify.env is not available outside the Functions runtime. */ }
  return globalThis.process?.env?.[name] || "";
}

/** JSON responses intentionally disable caching and never add permissive CORS headers. */
export function json(body, status = 200, headers = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store, max-age=0");
  responseHeaders.set("pragma", "no-cache");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

/** Read and parse a bounded JSON object from a native Netlify Request. */
export async function readJsonRequest(request, maxBytes = DEFAULT_JSON_LIMIT) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
  const header = request.headers.get("content-length");
  if (header !== null) {
    if (!/^\d+$/.test(header.trim())) throw problem(400, "invalid_request");
    if (Number(header) > maxBytes) throw problem(413, "payload_too_large");
  }

  const reader = request.body?.getReader();
  if (!reader) throw problem(400, "invalid_request");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw problem(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  let parsed;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (_) {
    throw problem(400, "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw problem(400, "invalid_request");
  return parsed;
}

function configuration() {
  const raw = String(env("SUPABASE_URL") || "").replace(/\/+$/, "");
  const publishable = env("SUPABASE_PUBLISHABLE_KEY");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  let base;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.toString().replace(/\/+$/, "");
  } catch (_) {
    throw problem(503, "server_not_configured");
  }
  if (!publishable || !service) throw problem(503, "server_not_configured");
  return { base, publishable, service };
}

function timedFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function serviceHeaders(service, extra = {}) {
  return { apikey: service, authorization: `Bearer ${service}`, ...extra };
}

async function serviceRequest(path, { method = "GET", body, headers = {} } = {}) {
  const { base, service } = configuration();
  let response;
  try {
    response = await timedFetch(new URL(path, `${base}/`), {
      method,
      headers: serviceHeaders(service, headers),
      ...(body === undefined ? {} : { body })
    });
  } catch (_) {
    throw problem(503, "supabase_unavailable");
  }
  if (!response.ok) throw problem(503, "supabase_unavailable");
  return response;
}

async function responseData(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch (_) { throw problem(503, "supabase_unavailable"); }
}

function encodedSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function storageLocation(bucket, objectPath) {
  if (typeof bucket !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(bucket)) {
    throw problem(400, "invalid_storage_path");
  }
  if (typeof objectPath !== "string" || !objectPath || objectPath.length > 1024 || objectPath.includes("\\") || /[\u0000-\u001f\u007f]/.test(objectPath)) {
    throw problem(400, "invalid_storage_path");
  }
  const segments = objectPath.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.length > 255)) {
    throw problem(400, "invalid_storage_path");
  }
  return `storage/v1/object/${encodedSegment(bucket)}/${segments.map(encodedSegment).join("/")}`;
}

function requestBearer(request) {
  const header = request?.headers?.get?.("authorization") || "";
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match && match[1].length <= 8192 ? match[1] : "";
}

/** Validate the caller's access token and resolve exactly one linked, password-ready app user. */
export async function resolveActor(request) {
  const accessToken = requestBearer(request);
  if (!accessToken) throw problem(401, "unauthorized");
  const { base, publishable, service } = configuration();
  let authResponse;
  try {
    authResponse = await timedFetch(new URL("auth/v1/user", `${base}/`), {
      headers: { apikey: publishable, authorization: `Bearer ${accessToken}` }
    });
  } catch (_) {
    throw problem(503, "supabase_unavailable");
  }
  if (!authResponse.ok) throw problem(401, "unauthorized");
  const authUser = await responseData(authResponse);
  const authId = authUser?.id;
  if (typeof authId !== "string" || !authId || authId.length > 256) throw problem(401, "unauthorized");

  const query = new URLSearchParams({
    auth_user_id: `eq.${authId}`,
    select: MAPPING_FIELDS,
    limit: "2"
  });
  const rowsResponse = await serviceRequest(`rest/v1/app_users?${query}`);
  const rows = await responseData(rowsResponse);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.auth_user_id !== authId ||
      typeof rows[0]?.legacy_id !== "string" || !rows[0].legacy_id) {
    throw problem(403, "account_not_linked");
  }
  const mapping = rows[0];
  if (mapping.needs_password_reset) throw problem(403, "password_reset_required");
  return {
    authUser: { id: authId },
    mapping: {
      legacy_id: mapping.legacy_id,
      auth_user_id: authId,
      username: typeof mapping.username === "string" ? mapping.username : "",
      display_name: typeof mapping.display_name === "string" ? mapping.display_name : "",
      needs_password_reset: false
    },
    actorId: mapping.legacy_id
  };
}

/** Read one row from the shared table using only the server-side service role. */
export async function readShared(id) {
  if (typeof id !== "string" || !id || id.length > 160 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw problem(400, "invalid_document");
  }
  const query = new URLSearchParams({ id: `eq.${id}`, select: "*", limit: "1" });
  const response = await serviceRequest(`rest/v1/shared?${query}`);
  const rows = await responseData(response);
  if (!Array.isArray(rows)) throw problem(503, "supabase_unavailable");
  return rows[0] || null;
}

/** Call a named PostgREST RPC using only the server-side service role. */
export async function callRpc(name, args = {}) {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(name)) throw problem(400, "invalid_rpc");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw problem(400, "invalid_rpc_arguments");
  const response = await serviceRequest(`rest/v1/rpc/${encodedSegment(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args)
  });
  return responseData(response);
}

/** Upload bytes to a private Storage bucket. Supports Buffer/Uint8Array, ArrayBuffer, and Blob. */
export async function uploadPrivateObject(bucket, objectPath, file, { contentType = "application/octet-stream", upsert = false } = {}) {
  const path = storageLocation(bucket, objectPath);
  if (typeof contentType !== "string" || contentType.length > 200 || /[\r\n]/.test(contentType)) throw problem(400, "invalid_content_type");
  let bytes;
  if (file instanceof Uint8Array) bytes = file;
  else if (file instanceof ArrayBuffer) bytes = new Uint8Array(file);
  else if (typeof Blob !== "undefined" && file instanceof Blob) bytes = new Uint8Array(await file.arrayBuffer());
  else throw problem(400, "invalid_upload");
  if (!bytes.byteLength || bytes.byteLength > MAX_STORAGE_BYTES) throw problem(bytes.byteLength > MAX_STORAGE_BYTES ? 413 : 400, bytes.byteLength > MAX_STORAGE_BYTES ? "payload_too_large" : "invalid_upload");
  const response = await serviceRequest(path, {
    method: "POST",
    headers: { "content-type": contentType, "x-upsert": upsert ? "true" : "false" },
    body: bytes
  });
  return responseData(response);
}

/** Delete an object from a private Storage bucket. */
export async function deletePrivateObject(bucket, objectPath) {
  const response = await serviceRequest(storageLocation(bucket, objectPath), { method: "DELETE" });
  await response.text();
  return { ok: true };
}

/** Create a short-lived signed URL for a private object; never make the bucket public. */
export async function createPrivateSignedUrl(bucket, objectPath, expiresIn = 60) {
  const location = storageLocation(bucket, objectPath);
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600) throw problem(400, "invalid_expiry");
  const signPath = location.replace("storage/v1/object/", "storage/v1/object/sign/");
  const response = await serviceRequest(signPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expiresIn })
  });
  const data = await responseData(response);
  const signedPath = data?.signedURL || data?.signedUrl;
  if (typeof signedPath !== "string" || !signedPath) throw problem(503, "supabase_unavailable");
  const { base } = configuration();
  let signedUrl;
  try {
    signedUrl = new URL(signedPath, `${base}/storage/v1/`);
    if (signedUrl.origin !== new URL(base).origin || !["https:", "http:"].includes(signedUrl.protocol)) throw new Error();
  } catch (_) {
    throw problem(503, "supabase_unavailable");
  }
  return signedUrl.toString();
}
