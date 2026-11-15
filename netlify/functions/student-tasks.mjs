import {
  callRpc,
  createPrivateSignedUrl,
  deletePrivateObject,
  json,
  readJsonRequest,
  resolveActor,
  uploadPrivateObject
} from "./_lib/supabase-core.mjs";

const BUCKET = "task-proofs";
const MAX_BODY_BYTES = 4_950_000;
const MAX_IMAGE_BYTES = Math.floor(3.5 * 1024 * 1024);
const MAX_VIDEO_BYTES = 3 * 1024 * 1024;
const MAX_SIGNED_URL_SECONDS = 60;
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["image/gif", "gif"],
  ["video/mp4", "mp4"], ["video/webm", "webm"], ["video/quicktime", "mov"]
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

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

function parseProofData(value) {
  if (typeof value !== "string" || value.length > 4_800_000) throw fail(413, "proof_too_large");
  const match = /^data:(image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm|quicktime));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw fail(400, "invalid_proof");
  const mime = match[1].toLowerCase();
  const encoded = match[2];
  if (encoded.length % 4 !== 0) throw fail(400, "invalid_proof");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.toString("base64") !== encoded) throw fail(400, "invalid_proof");
  const max = mime.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (bytes.byteLength > max) throw fail(413, "proof_too_large");
  if (!matchesSignature(mime, bytes)) throw fail(400, "invalid_proof");
  return { mime, bytes, extension: MIME_EXTENSIONS.get(mime) };
}

function matchesSignature(mime, bytes) {
  const b = bytes;
  if (mime === "image/jpeg") return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/png") return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/gif") return b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"));
  if (mime === "image/webp") return b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "video/webm") return b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "video/mp4" || mime === "video/quicktime") return b.length >= 12 && b.subarray(4, 8).toString("ascii") === "ftyp";
  return false;
}

function parseOperation(body) {
  if (typeof body.op !== "string") throw fail(400, "invalid_request");
  switch (body.op) {
    case "submit":
      requireKeys(body, new Set(["op", "taskId", "cycleKey", "proofType", "proofData"]), ["op", "taskId", "cycleKey", "proofType", "proofData"]);
      if (typeof body.taskId !== "string" || !SAFE_ID_RE.test(body.taskId) ||
          typeof body.cycleKey !== "string" || body.cycleKey.length > 80 ||
          !/^(daily-\d{4}-\d{2}-\d{2}|weekly-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|meeting-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.test(body.cycleKey) ||
          !["image", "video"].includes(body.proofType)) throw fail(400, "invalid_request");
      return { op: body.op, taskId: body.taskId, cycleKey: body.cycleKey, proofType: body.proofType };
    case "undo":
      requireKeys(body, new Set(["op", "taskId", "cycleKey"]), ["op", "taskId", "cycleKey"]);
      if (typeof body.taskId !== "string" || !SAFE_ID_RE.test(body.taskId) || typeof body.cycleKey !== "string" || body.cycleKey.length > 80) throw fail(400, "invalid_request");
      return { op: body.op, taskId: body.taskId, cycleKey: body.cycleKey };
    case "review":
      requireKeys(body, new Set(["op", "studentId", "taskId", "cycleKey", "approved"]), ["op", "studentId", "taskId", "cycleKey", "approved"]);
      if (typeof body.studentId !== "string" || body.studentId.length < 1 || body.studentId.length > 160 ||
          typeof body.taskId !== "string" || !SAFE_ID_RE.test(body.taskId) || typeof body.cycleKey !== "string" || body.cycleKey.length > 80 ||
          typeof body.approved !== "boolean") throw fail(400, "invalid_request");
      return { op: body.op, studentId: body.studentId, taskId: body.taskId, cycleKey: body.cycleKey, approved: body.approved };
    case "mine":
      requireKeys(body, new Set(["op"]), ["op"]);
      return { op: body.op };
    case "review_queue":
      requireKeys(body, new Set(["op"]), ["op"]);
      return { op: body.op };
    case "proof_url":
      requireKeys(body, new Set(["op", "submissionId"]), ["op", "submissionId"]);
      if (typeof body.submissionId !== "string" || !UUID_RE.test(body.submissionId)) throw fail(400, "invalid_request");
      return { op: body.op, submissionId: body.submissionId };
    default:
      throw fail(400, "invalid_request");
  }
}

async function signRows(rows) {
  if (!Array.isArray(rows)) throw fail(503, "service_unavailable");
  return Promise.all(rows.map(async row => {
    const item = { ...row };
    const path = typeof item.proof_path === "string" ? item.proof_path : null;
    delete item.proof_path;
    if (path) item.proofUrl = await createPrivateSignedUrl(BUCKET, path, MAX_SIGNED_URL_SECONDS);
    return item;
  }));
}

async function execute(actor, operation, details = {}) {
  const result = await callRpc("student_tasks_action", {
    p_auth_user_id: actor.authUser.id,
    p_op: operation.op,
    p_task_id: operation.taskId ?? null,
    p_cycle_key: operation.cycleKey ?? null,
    p_proof_path: details.proofPath ?? null,
    p_proof_mime: details.proofMime ?? null,
    p_approved: operation.approved ?? null,
    p_target_user_id: operation.studentId ?? null,
    p_submission_id: details.submissionId ?? operation.submissionId ?? null
  });
  return result;
}

function safeError(error) {
  const status = Number(error?.status) || 500;
  if (status === 401) return json({ error: "unauthorized" }, 401);
  if (status === 403) return json({ error: error?.code === "password_reset_required" ? "password_reset_required" : "forbidden" }, 403);
  if (status === 400 || status === 413) return json({ error: status === 413 ? "payload_too_large" : "invalid_request" }, status);
  if (status === 404) return json({ error: "not_found" }, 404);
  if (status === 409) return json({ error: "conflict" }, 409);
  console.error("student-tasks request failed", { code: error?.code || "internal_error" });
  return json({ error: "service_unavailable" }, status >= 500 ? 503 : 500);
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let uploadedPath = null;
  let preserveUploadedPathOnError = false;
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw fail(400, "invalid_request");
    const body = await readJsonRequest(request, MAX_BODY_BYTES);
    const operation = parseOperation(body);
    const actor = await resolveActor(request);
    if (actor.mapping.needs_password_reset !== false) throw fail(403, "password_reset_required");

    if (operation.op === "submit") {
      const proof = parseProofData(body.proofData);
      if ((operation.proofType === "image") !== proof.mime.startsWith("image/")) throw fail(400, "invalid_proof");
      const submissionId = crypto.randomUUID();
      uploadedPath = `${actor.authUser.id}/${submissionId}.${proof.extension}`;
      await uploadPrivateObject(BUCKET, uploadedPath, proof.bytes, { contentType: proof.mime, upsert: false });
      let result;
      try {
        result = await execute(actor, operation, { proofPath: uploadedPath, proofMime: proof.mime, submissionId });
      } catch (error) {
        // A timeout or 5xx can happen after PostgreSQL committed but before the response arrived.
        // Retain the object in that ambiguous case so a durable submission never loses its proof.
        const status = Number(error?.status) || 0;
        if (!status || status >= 500) preserveUploadedPathOnError = true;
        throw error;
      }
      if (result?.duplicate === true) {
        await deletePrivateObject(BUCKET, uploadedPath).catch(() => {});
        uploadedPath = null;
        return json({ ok: true, alreadyCompleted: true });
      }
      if (result?.ok !== true) throw fail(409, "conflict");
      const savedPath = uploadedPath;
      uploadedPath = null;
      const proofUrl = await createPrivateSignedUrl(BUCKET, savedPath, MAX_SIGNED_URL_SECONDS);
      return json({ ok: true, submissionId, status: result.status, points: result.points, title: result.title, proofType: operation.proofType, date: result.date, proofUrl });
    }

    if (operation.op === "mine" || operation.op === "review_queue") {
      const result = await execute(actor, operation);
      if (result?.ok !== true || !Array.isArray(result.items)) throw fail(503, "service_unavailable");
      return json({ items: await signRows(result.items) });
    }

    if (operation.op === "proof_url") {
      const result = await execute(actor, operation);
      if (result?.ok !== true || typeof result.proof_path !== "string") throw fail(404, "not_found");
      const proofUrl = await createPrivateSignedUrl(BUCKET, result.proof_path, MAX_SIGNED_URL_SECONDS);
      return json({ proofUrl, proofType: result.proof_type, status: result.status });
    }

    const result = await execute(actor, operation);
    if (result?.ok !== true) throw fail(result?.forbidden ? 403 : result?.conflict ? 409 : 404, "operation_failed");
    if (typeof result.delete_path === "string") {
      await deletePrivateObject(BUCKET, result.delete_path).catch(() => {});
    }
    return json({ ok: true, status: result.status, points: result.points, title: result.title, approved: result.approved });
  } catch (error) {
    if (uploadedPath && !preserveUploadedPathOnError) await deletePrivateObject(BUCKET, uploadedPath).catch(() => {});
    return safeError(error);
  }
}

export { parseOperation, parseProofData };
