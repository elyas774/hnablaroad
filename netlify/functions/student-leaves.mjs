import {
  callRpc,
  createPrivateSignedUrl,
  deletePrivateObject,
  json,
  readJsonRequest,
  resolveActor,
  uploadPrivateObject
} from "./_lib/supabase-core.mjs";

const BUCKET = "leave-attachments";
const MAX_BODY_BYTES = 3_150_000;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TYPES = new Set(["عادية", "طارئة", "مرضية", "دراسة", "ظرف خاص"]);
const EXCUSE_TYPES = new Set(["تأخر", "غياب", "أخرى"]);
const MODES = new Set(["full", "light", "meetings", "custom"]);
const MIME_EXTENSIONS = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["application/pdf", "pdf"]]);

function fail(status, code) { const error = new Error(code); error.status = status; error.code = code; return error; }
function keys(body, allowed, required = []) {
  if (Object.keys(body).some(key => !allowed.has(key)) || required.some(key => !(key in body))) throw fail(400, "invalid_request");
}
function text(value, max, required = false) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) throw fail(400, "invalid_request");
  return value.trim();
}
function requestId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw fail(400, "invalid_request");
  return value.toLowerCase();
}
function calendarDate(value) {
  if (typeof value !== "string" || value.length > 32) throw fail(400, "invalid_request");
  // Current HTML fields are datetime-local; the domain stores only their calendar date.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/.exec(value);
  if (!match) throw fail(400, "invalid_request");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw fail(400, "invalid_request");
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] || 0) > 59)) throw fail(400, "invalid_request");
  return `${match[1]}-${match[2]}-${match[3]}`;
}
function parseOperation(body) {
  if (typeof body.op !== "string") throw fail(400, "invalid_request");
  switch (body.op) {
    case "mine": case "review_queue":
      keys(body, new Set(["op"]), ["op"]);
      return { op: body.op };
    case "submit": {
      keys(body, new Set(["op", "start", "end", "type", "mode", "reason", "protectStreak", "attachmentData"]), ["op", "start", "end", "type", "mode", "reason", "protectStreak"]);
      if (!SAFE_TYPES.has(body.type) || !MODES.has(body.mode) || typeof body.protectStreak !== "boolean") throw fail(400, "invalid_request");
      const start = calendarDate(body.start), end = calendarDate(body.end);
      if (end < start) throw fail(400, "invalid_request");
      return { op: body.op, start, end, type: body.type, mode: body.mode, reason: text(body.reason, 1000, true), protectStreak: body.protectStreak, attachmentData: body.attachmentData };
    }
    case "cancel":
      keys(body, new Set(["op", "requestId"]), ["op", "requestId"]);
      return { op: body.op, requestId: requestId(body.requestId) };
    case "approve": case "reject":
      keys(body, new Set(["op", "requestId"]), ["op", "requestId"]);
      return { op: body.op, requestId: requestId(body.requestId) };
    case "attachment_url":
      keys(body, new Set(["op", "requestId"]), ["op", "requestId"]);
      return { op: body.op, requestId: requestId(body.requestId) };
    case "excuse_mine": case "excuse_review_queue":
      keys(body, new Set(["op"]), ["op"]);
      return { op: body.op };
    case "excuse_submit":
      keys(body, new Set(["op", "type", "text", "attachmentData"]), ["op", "type", "text"]);
      if (!EXCUSE_TYPES.has(body.type)) throw fail(400, "invalid_request");
      return { op: body.op, type: body.type, text: text(body.text, 1000, true), attachmentData: body.attachmentData };
    case "excuse_review":
      keys(body, new Set(["op", "requestId", "decision"]), ["op", "requestId", "decision"]);
      if (!UUID_RE.test(body.requestId) || !["approved", "rejected"].includes(body.decision)) throw fail(400, "invalid_request");
      return { op: body.op, requestId: requestId(body.requestId), decision: body.decision };
    case "excuse_attachment_url":
      keys(body, new Set(["op", "requestId"]), ["op", "requestId"]);
      return { op: body.op, requestId: requestId(body.requestId) };
    case "excuse_delete_owner":
      keys(body, new Set(["op", "userId"]), ["op", "userId"]);
      return { op: body.op, targetUserId: text(body.userId, 160, true) };
    default: throw fail(400, "invalid_request");
  }
}
function parseAttachment(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > 2_900_000) throw fail(413, "attachment_too_large");
  const match = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw fail(400, "invalid_attachment");
  const mime = match[1], encoded = match[2], bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.toString("base64") !== encoded) throw fail(bytes.byteLength > MAX_ATTACHMENT_BYTES ? 413 : 400, bytes.byteLength > MAX_ATTACHMENT_BYTES ? "attachment_too_large" : "invalid_attachment");
  const signature = mime === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === "image/png" ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === "image/webp" ? bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
    : bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  if (!signature) throw fail(400, "invalid_attachment");
  return { mime, bytes, extension: MIME_EXTENSIONS.get(mime) };
}
function rpcArgs(actor, operation, details = {}) {
  return {
    p_auth_user_id: actor.authUser.id,
    p_op: operation.op,
    p_request_id: operation.requestId ?? details.requestId ?? null,
    p_start_date: operation.start ?? null,
    p_end_date: operation.end ?? null,
    p_type: operation.type ?? null,
    p_mode: operation.mode ?? null,
    p_reason: operation.reason ?? null,
    p_protect_streak: operation.protectStreak ?? null,
    p_attachment_path: details.path ?? null,
    p_attachment_mime: details.mime ?? null
  };
}
async function runRpc(actor, operation, details) { return callRpc("student_leaves_action", rpcArgs(actor, operation, details)); }
function excuseRpcArgs(actor, operation, details = {}) {
  return {
    p_auth_user_id: actor.authUser.id,
    p_op: operation.op.replace(/^excuse_/, ""),
    p_request_id: operation.requestId ?? details.requestId ?? null,
    p_target_user_id: operation.targetUserId ?? null,
    p_type: operation.type ?? null,
    p_text: operation.text ?? null,
    p_decision: operation.decision ?? null,
    p_attachment_path: details.path ?? null,
    p_attachment_mime: details.mime ?? null
  };
}
async function runExcuseRpc(actor, operation, details) {
  return callRpc("student_excuses_action", excuseRpcArgs(actor, operation, details));
}
function mapItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw fail(503, "service_unavailable");
  const out = { ...item };
  if (typeof out.attachment_path === "string") out._privateAttachmentPath = out.attachment_path;
  delete out.attachment_path;
  return out;
}
async function signItemAttachments(items) {
  if (!Array.isArray(items) || items.length > 300) throw fail(503, "service_unavailable");
  return Promise.all(items.map(async item => {
    const out = mapItem(item);
    if (out._privateAttachmentPath) {
      out.attachmentUrl = await createPrivateSignedUrl(BUCKET, out._privateAttachmentPath, 60);
      delete out._privateAttachmentPath;
    }
    return out;
  }));
}
function safeError(error) {
  const status = Number(error?.status) || 500;
  if (status === 401) return json({ error: "unauthorized" }, 401);
  if (status === 403) return json({ error: error?.code === "password_reset_required" ? "password_reset_required" : "forbidden" }, 403);
  if (status === 400 || status === 413) return json({ error: status === 413 ? "payload_too_large" : "invalid_request" }, status);
  if (status === 404) return json({ error: "not_found" }, 404);
  if (status === 409) return json({ error: "conflict" }, 409);
  console.error("student-leaves request failed", { code: error?.code || "internal_error" });
  return json({ error: "service_unavailable" }, status >= 500 ? 503 : 500);
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let pendingPath = null;
  let safeToDeletePending = false;
  let committed = false;
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw fail(400, "invalid_request");
    const body = await readJsonRequest(request, MAX_BODY_BYTES);
    const operation = parseOperation(body);
    const actor = await resolveActor(request);
    if (actor.mapping.needs_password_reset !== false) throw fail(403, "password_reset_required");

    if (operation.op === "excuse_submit") {
      const id = crypto.randomUUID();
      let attachment = null;
      if (operation.attachmentData !== undefined) {
        attachment = parseAttachment(operation.attachmentData);
        pendingPath = `${actor.authUser.id}/${id}.${attachment.extension}`;
        safeToDeletePending = true;
        await uploadPrivateObject(BUCKET, pendingPath, attachment.bytes, { contentType: attachment.mime, upsert: false });
        safeToDeletePending = false;
      }
      const result = await runExcuseRpc(actor, operation, { requestId: id, path: pendingPath, mime: attachment?.mime ?? null });
      if (result?.ok !== true) {
        safeToDeletePending = true;
        throw fail(result?.conflict ? 409 : result?.forbidden ? 403 : 400, "operation_failed");
      }
      committed = true;
      const item = mapItem(result.item);
      if (item._privateAttachmentPath) {
        item.attachmentUrl = await createPrivateSignedUrl(BUCKET, item._privateAttachmentPath, 60);
        delete item._privateAttachmentPath;
      }
      pendingPath = null;
      return json({ ok: true, excuse: item });
    }

    if (operation.op.startsWith("excuse_")) {
      const result = await runExcuseRpc(actor, operation);
      if (result?.ok !== true) throw fail(result?.conflict ? 409 : result?.forbidden ? 403 : 404, "operation_failed");
      if (operation.op === "excuse_mine" || operation.op === "excuse_review_queue") {
        return json({ items: await signItemAttachments(result.items) });
      }
      if (operation.op === "excuse_attachment_url") {
        if (typeof result.attachment_path !== "string") throw fail(404, "not_found");
        return json({ attachmentUrl: await createPrivateSignedUrl(BUCKET, result.attachment_path, 60) });
      }
      if (operation.op === "excuse_delete_owner") return json({ ok: true, deletedCount: result.deletedCount, legacyDeletedCount: result.legacyDeletedCount });
      const item = mapItem(result.item);
      if (item._privateAttachmentPath) {
        item.attachmentUrl = await createPrivateSignedUrl(BUCKET, item._privateAttachmentPath, 60);
        delete item._privateAttachmentPath;
      }
      return json({ ok: true, excuse: item });
    }

    if (operation.op === "submit") {
      const id = crypto.randomUUID();
      let attachment = null;
      if (operation.attachmentData !== undefined) {
        attachment = parseAttachment(operation.attachmentData);
        pendingPath = `${actor.authUser.id}/${id}.${attachment.extension}`;
        safeToDeletePending = true;
        await uploadPrivateObject(BUCKET, pendingPath, attachment.bytes, { contentType: attachment.mime, upsert: false });
        safeToDeletePending = false;
      }
      const result = await runRpc(actor, operation, { requestId: id, path: pendingPath, mime: attachment?.mime ?? null });
      if (result?.ok !== true) {
        safeToDeletePending = true;
        throw fail(result?.conflict ? 409 : result?.forbidden ? 403 : 400, "operation_failed");
      }
      committed = true;
      const item = mapItem(result.item);
      if (item._privateAttachmentPath) {
        item.attachmentUrl = await createPrivateSignedUrl(BUCKET, item._privateAttachmentPath, 60);
        delete item._privateAttachmentPath;
      }
      pendingPath = null;
      return json({ ok: true, request: item });
    }

    const result = await runRpc(actor, operation);
    if (result?.ok !== true) throw fail(result?.conflict ? 409 : result?.forbidden ? 403 : 404, "operation_failed");
    if (operation.op === "mine" || operation.op === "review_queue") return json({ items: await signItemAttachments(result.items) });
    if (operation.op === "attachment_url") {
      if (typeof result.attachment_path !== "string") throw fail(404, "not_found");
      return json({ attachmentUrl: await createPrivateSignedUrl(BUCKET, result.attachment_path, 60) });
    }
    const item = mapItem(result.item);
    if (item._privateAttachmentPath) {
      item.attachmentUrl = await createPrivateSignedUrl(BUCKET, item._privateAttachmentPath, 60);
      delete item._privateAttachmentPath;
    }
    return json({ ok: true, request: item });
  } catch (error) {
    if (pendingPath && safeToDeletePending && !committed) await deletePrivateObject(BUCKET, pendingPath).catch(() => {});
    return safeError(error);
  }
}

export { parseOperation, parseAttachment, calendarDate, BUCKET, excuseRpcArgs };
