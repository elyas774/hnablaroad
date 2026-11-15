import { callRpc, json, readJsonRequest, resolveActor } from "./_lib/supabase-core.mjs";

const MAX_BODY_BYTES = 20_000;
const MAX_POST_CHARS = 2_000;
const MAX_COMMENT_CHARS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMOJIS = new Set(["🤲", "✨", "👍", "🤍"]);
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function fail(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function requireKeys(body, allowed, required = []) {
  if (Object.keys(body).some(key => !allowed.has(key)) || required.some(key => !(key in body))) {
    throw fail(400, "invalid_request");
  }
}

function uuid(value, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !UUID_RE.test(value)) throw fail(400, "invalid_request");
  return value.toLowerCase();
}

function content(value, max) {
  if (typeof value !== "string") throw fail(400, "invalid_request");
  const text = value.trim();
  if (!text || text.length > max || CONTROL_RE.test(text)) throw fail(400, "invalid_request");
  return text;
}

export function parseOperation(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.op !== "string") {
    throw fail(400, "invalid_request");
  }
  switch (body.op) {
    case "feed":
      requireKeys(body, new Set(["op"]), ["op"]);
      return { op: "feed" };
    case "create_post":
      requireKeys(body, new Set(["op", "requestId", "text"]), ["op", "requestId", "text"]);
      return { op: body.op, requestId: uuid(body.requestId), text: content(body.text, MAX_POST_CHARS), postId: crypto.randomUUID() };
    case "edit_post":
    case "delete_post":
      requireKeys(body, new Set(["op", "postId", "expectedVersion", "requestId", ...(body.op === "edit_post" ? ["text"] : [])]),
        body.op === "edit_post" ? ["op", "postId", "expectedVersion", "requestId", "text"] : ["op", "postId", "expectedVersion", "requestId"]);
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw fail(400, "invalid_request");
      return { op: body.op, postId: uuid(body.postId), expectedVersion: body.expectedVersion, requestId: uuid(body.requestId), text: body.op === "edit_post" ? content(body.text, MAX_POST_CHARS) : undefined };
    case "create_comment":
      requireKeys(body, new Set(["op", "postId", "requestId", "text"]), ["op", "postId", "requestId", "text"]);
      return { op: body.op, postId: uuid(body.postId), requestId: uuid(body.requestId), commentId: crypto.randomUUID(), text: content(body.text, MAX_COMMENT_CHARS) };
    case "edit_comment":
    case "delete_comment":
      requireKeys(body, new Set(["op", "commentId", "expectedVersion", "requestId", ...(body.op === "edit_comment" ? ["text"] : [])]),
        body.op === "edit_comment" ? ["op", "commentId", "expectedVersion", "requestId", "text"] : ["op", "commentId", "expectedVersion", "requestId"]);
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw fail(400, "invalid_request");
      return { op: body.op, commentId: uuid(body.commentId), expectedVersion: body.expectedVersion, requestId: uuid(body.requestId), text: body.op === "edit_comment" ? content(body.text, MAX_COMMENT_CHARS) : undefined };
    case "toggle_reaction":
      requireKeys(body, new Set(["op", "postId", "requestId", "emoji"]), ["op", "postId", "requestId", "emoji"]);
      if (typeof body.emoji !== "string" || !EMOJIS.has(body.emoji)) throw fail(400, "invalid_request");
      return { op: body.op, postId: uuid(body.postId), requestId: uuid(body.requestId), emoji: body.emoji };
    default:
      throw fail(400, "invalid_request");
  }
}

function rpcArguments(actor, operation) {
  return {
    p_auth_user_id: actor.authUser.id,
    p_op: operation.op,
    p_post_id: operation.postId ?? null,
    p_comment_id: operation.commentId ?? null,
    p_request_id: operation.requestId ?? null,
    p_text: operation.text ?? null,
    p_emoji: operation.emoji ?? null,
    p_expected_version: operation.expectedVersion ?? null
  };
}

function rpcFailure(result) {
  if (result?.forbidden) throw fail(403, "forbidden");
  if (result?.conflict) throw fail(409, "conflict");
  if (result?.not_found) throw fail(404, "not_found");
  if (result?.invalid) throw fail(400, "invalid_request");
  throw fail(503, "service_unavailable");
}

function safeError(error) {
  const status = Number(error?.status) || 500;
  if (status === 401) return json({ error: "unauthorized" }, 401);
  if (status === 403) return json({ error: error?.code === "password_reset_required" ? "password_reset_required" : "forbidden" }, 403);
  if (status === 400 || status === 413) return json({ error: status === 413 ? "payload_too_large" : "invalid_request" }, status);
  if (status === 404) return json({ error: "not_found" }, 404);
  if (status === 409) return json({ error: "conflict" }, 409);
  console.error("student-social request failed", { code: error?.code || "internal_error" });
  return json({ error: "service_unavailable" }, 503);
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw fail(400, "invalid_request");
    }
    const body = await readJsonRequest(request, MAX_BODY_BYTES);
    const operation = parseOperation(body);
    const actor = await resolveActor(request);
    if (actor.mapping.needs_password_reset !== false) throw fail(403, "password_reset_required");
    const result = await callRpc("student_social_action", rpcArguments(actor, operation));
    if (operation.op === "feed") {
      if (result?.ok !== true || !Array.isArray(result.posts)) throw fail(503, "service_unavailable");
      return json({ posts: result.posts });
    }
    if (result?.ok !== true) rpcFailure(result);
    return json({ ok: true, ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== "ok")) });
  } catch (error) {
    return safeError(error);
  }
}
