import { callRpc, json, readJsonRequest, resolveActor } from "./_lib/supabase-core.mjs";

const MAX_BODY_BYTES = 16_384;
const MAX_AYAT_TEXT = 500;
const MAX_GAME_ANSWER = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u0008\u000e-\u001f\u007f]/;

function fail(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}
function exactKeys(body, allowed, required = []) {
  if (Object.keys(body).some(key => !allowed.has(key)) || required.some(key => !(key in body))) {
    throw fail(400, "invalid_request");
  }
}
function boundedText(value, max, { required = false } = {}) {
  if (typeof value !== "string" || value.length > max || CONTROL_RE.test(value) || (required && !value.trim())) {
    throw fail(value?.length > max ? 413 : 400, value?.length > max ? "payload_too_large" : "invalid_request");
  }
  return value.trim();
}
function uuid(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw fail(400, "invalid_request");
  return value.toLowerCase();
}

/** Strict operation schemas deliberately have no arbitrary data, owner, points, or answer-key fields. */
function parseOperation(body) {
  if (typeof body.op !== "string") throw fail(400, "invalid_request");
  switch (body.op) {
    case "state":
    case "logs":
    case "leader_submissions":
    case "ayat_award_winner":
      exactKeys(body, new Set(["op"]), ["op"]);
      return { op: body.op };
    case "weekly_answer":
      exactKeys(body, new Set(["op", "choiceIndex"]), ["op", "choiceIndex"]);
      if (!Number.isInteger(body.choiceIndex) || body.choiceIndex < 0 || body.choiceIndex > 3) throw fail(400, "invalid_request");
      return { op: body.op, choiceIndex: body.choiceIndex };
    case "ayat_submit":
      exactKeys(body, new Set(["op", "text"]), ["op", "text"]);
      return { op: body.op, text: boundedText(body.text, MAX_AYAT_TEXT, { required: true }) };
    case "guess_start":
    case "wheel_spin":
      exactKeys(body, new Set(["op", "gameId"]), ["op", "gameId"]);
      return { op: body.op, gameId: uuid(body.gameId) };
    case "guess_answer":
      exactKeys(body, new Set(["op", "gameId", "answer"]), ["op", "gameId", "answer"]);
      return { op: body.op, gameId: uuid(body.gameId), answer: boundedText(body.answer, MAX_GAME_ANSWER, { required: true }) };
    default:
      throw fail(400, "invalid_request");
  }
}

function rpcArgs(actor, operation) {
  return {
    p_auth_user_id: actor.authUser.id,
    p_op: operation.op,
    p_choice_index: operation.choiceIndex ?? null,
    p_text: operation.text ?? null,
    p_submission_id: null,
    p_game_id: operation.gameId ?? null,
    p_answer: operation.answer ?? null
  };
}

function safeError(error) {
  const status = Number(error?.status) || 500;
  if (status === 401) return json({ error: "unauthorized" }, 401);
  if (status === 403) return json({ error: error?.code === "password_reset_required" ? "password_reset_required" : "forbidden" }, 403);
  if (status === 400 || status === 413) return json({ error: status === 413 ? "payload_too_large" : "invalid_request" }, status);
  if (status === 404) return json({ error: "not_found" }, 404);
  if (status === 409) return json({ error: "conflict" }, 409);
  console.error("student-challenges request failed", { code: error?.code || "internal_error" });
  return json({ error: "service_unavailable" }, status >= 500 ? 503 : 500);
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw fail(400, "invalid_request");
    const operation = parseOperation(await readJsonRequest(request, MAX_BODY_BYTES));
    const actor = await resolveActor(request);
    if (actor.mapping.needs_password_reset !== false) throw fail(403, "password_reset_required");
    const result = await callRpc("student_challenges_action", rpcArgs(actor, operation));
    if (result?.ok !== true) throw fail(result?.forbidden ? 403 : result?.conflict ? 409 : result?.notFound ? 404 : 503, "operation_failed");
    return json(result.data && typeof result.data === "object" ? result.data : { ok: true });
  } catch (error) {
    return safeError(error);
  }
}

export { parseOperation, MAX_BODY_BYTES, MAX_AYAT_TEXT, MAX_GAME_ANSWER };
