import {
  callRpc,
  createPrivateSignedUrl,
  deletePrivateObject,
  json,
  readJsonRequest,
  readShared,
  resolveActor,
  uploadPrivateObject
} from "./_lib/supabase-core.mjs";

const BUCKET = "exam-attachments";
const MAX_BODY_BYTES = 3_250_000;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MIME_EXTENSIONS = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["application/pdf", "pdf"]]);

function fail(status, code) { const error = new Error(code); error.status = status; error.code = code; return error; }
function keys(body, allowed, required = []) {
  if (Object.keys(body).some(key => !allowed.has(key)) || required.some(key => !(key in body))) throw fail(400, "invalid_request");
}
function text(value, max, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000e-\u001f\u007f]/.test(value)) throw fail(400, "invalid_request");
  return value.trim();
}
function id(value) { if (typeof value !== "string" || !SAFE_ID_RE.test(value)) throw fail(400, "invalid_request"); return value; }
function parseOperation(body) {
  if (typeof body.op !== "string") throw fail(400, "invalid_request");
  switch (body.op) {
    case "list": case "mine":
      keys(body, new Set(["op"]), ["op"]); return { op: body.op };
    case "review_queue":
      keys(body, new Set(["op", "kind", "examId"]), ["op", "kind", "examId"]);
      if (!["question_bank", "published"].includes(body.kind)) throw fail(400, "invalid_request");
      return { op: body.op, kind: body.kind, examId: body.kind === "question_bank" ? "current" : id(body.examId) };
    case "submit": {
      keys(body, new Set(["op", "kind", "examId", "answers", "attachmentData"]), ["op", "kind", "examId", "answers"]);
      if (!["question_bank", "published"].includes(body.kind) || !Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > (body.kind === "question_bank" ? 500 : 20)) throw fail(400, "invalid_request");
      const answers = body.answers.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(k => !["qid", "given"].includes(k)) || !("qid" in item) || !("given" in item)) throw fail(400, "invalid_request");
        return { qid: id(item.qid), given: text(item.given, MAX_TEXT, true) };
      });
      if (new Set(answers.map(a => a.qid)).size !== answers.length) throw fail(400, "invalid_request");
      return { op: body.op, kind: body.kind, examId: body.kind === "question_bank" ? "current" : id(body.examId), answers, attachmentData: body.attachmentData };
    }
    case "redo":
      keys(body, new Set(["op", "kind", "examId"]), ["op", "kind", "examId"]);
      if (!["question_bank", "published"].includes(body.kind)) throw fail(400, "invalid_request");
      return { op: body.op, kind: body.kind, examId: body.kind === "question_bank" ? "current" : id(body.examId) };
    case "grade":
      keys(body, new Set(["op", "kind", "examId", "studentId", "qid", "points"]), ["op", "kind", "examId", "studentId", "qid", "points"]);
      if (!["question_bank", "published"].includes(body.kind) || !Number.isInteger(body.points) || body.points < 0 || body.points > 10 || body.points % 2 !== 0) throw fail(400, "invalid_request");
      return { op: body.op, kind: body.kind, examId: body.kind === "question_bank" ? "current" : id(body.examId), studentId: text(body.studentId, 160, true), qid: id(body.qid), points: body.points };
    case "question_add":
      keys(body, new Set(["op", "question", "answer"]), ["op", "question", "answer"]);
      return { op: body.op, qid: crypto.randomUUID(), question: text(body.question, 1000, true), answer: text(body.answer, 2000, true) };
    case "question_delete":
      keys(body, new Set(["op", "qid"]), ["op", "qid"]); return { op: body.op, qid: id(body.qid) };
    case "publish": {
      keys(body, new Set(["op", "exam"]), ["op", "exam"]);
      const e = body.exam;
      if (!e || typeof e !== "object" || Array.isArray(e) || Object.keys(e).some(k => !["id", "title", "difficulty", "questions"].includes(k)) || !Array.isArray(e.questions) || e.questions.length < 2 || e.questions.length > 20) throw fail(400, "invalid_request");
      if (!e.id || !SAFE_ID_RE.test(e.id) || !["medium", "hard"].includes(e.difficulty)) throw fail(400, "invalid_request");
      const title = text(e.title, 160, true);
      const questions = e.questions.map(q => {
        const allowed = new Set(["id", "q", "type", "options", "answer", "modelAnswer", "explanation", "instruction", "passage", "statement"]);
        if (!q || typeof q !== "object" || Array.isArray(q) || Object.keys(q).some(k => !allowed.has(k))) throw fail(400, "invalid_request");
        const type = q.type;
        if (!["multiple", "truefalse", "essay"].includes(type)) throw fail(400, "invalid_request");
        const result = { id: id(q.id), q: text(q.q, 600, true), type,
          instruction: text(q.instruction || "", 500), passage: text(q.passage || "", 2000), statement: text(q.statement || "", 1000) };
        if (type === "essay") {
          result.options = [];
          result.modelAnswer = text(q.modelAnswer || q.answer || "", 2000, true);
          result.explanation = text(q.explanation || "", 1200);
        } else {
          if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw fail(400, "invalid_request");
          result.options = q.options.map(o => text(o, 500, true));
          result.answer = text(q.answer, 500, true);
          if (!result.options.includes(result.answer)) throw fail(400, "invalid_request");
          result.explanation = text(q.explanation || "", 1200);
        }
        return result;
      });
      if (new Set(questions.map(q => q.id)).size !== questions.length) throw fail(400, "invalid_request");
      return { op: body.op, exam: { id: e.id, title, difficulty: e.difficulty, questions } };
    }
    case "published_delete":
      keys(body, new Set(["op", "examId"]), ["op", "examId"]); return { op: body.op, examId: id(body.examId) };
    case "attachment_url":
      keys(body, new Set(["op", "attemptId"]), ["op", "attemptId"]);
      if (typeof body.attemptId !== "string" || !UUID_RE.test(body.attemptId)) throw fail(400, "invalid_request");
      return { op: body.op, attemptId: body.attemptId };
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
function parseSharedValue(row) {
  let value = row?.data?.value;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch (_) { return null; } }
  return value;
}
function publicQuestion(q, examId, index) {
  const result = {};
  for (const k of ["id", "q", "question", "type", "options", "instruction", "passage", "statement", "difficulty"]) if (q && q[k] !== undefined) result[k] = q[k];
  if (!result.id) result.id = `legacy-${examId}-${index}`;
  return result;
}
async function listExams() {
  const [questionRow, publishedRow, archiveRow] = await Promise.all([readShared("examQuestions"), readShared("aiExams"), readShared("examArchive")]);
  const questionBank = parseSharedValue(questionRow);
  const published = parseSharedValue(publishedRow);
  const archive = parseSharedValue(archiveRow);
  return {
    questionBank: Array.isArray(questionBank) ? questionBank.slice(0, 100).map(q => ({ id: q.id, question: q.question })) : [],
    published: Array.isArray(published) ? published.filter(e => e?.published === true).slice(0, 20).map(e => ({ id: e.id, title: e.title || "اختبار منشور", difficulty: e.difficulty || "medium", date: e.date || "", authorName: e.authorName || "القائد", questions: Array.isArray(e.questions) ? e.questions.slice(0, 20).map((q, i) => publicQuestion(q, e.id, i)) : [] })) : [],
    archive: Array.isArray(archive) ? archive.slice(0, 300).map(q => ({ id: q.id, question: q.question, date: q.date })) : []
  };
}
function rpcArgs(actor, operation, details = {}) {
  return {
    p_auth_user_id: actor.authUser.id, p_op: operation.op, p_kind: operation.kind ?? null,
    p_exam_id: operation.examId ?? null, p_target_user_id: operation.studentId ?? null,
    p_qid: operation.qid ?? null, p_answers: operation.answers ?? null,
    p_points: operation.points ?? null, p_question: operation.question ?? null,
    p_answer: operation.answer ?? null, p_exam: operation.exam ?? null,
    p_attempt_id: details.attemptId ?? operation.attemptId ?? null,
    p_attachment_path: details.path ?? null, p_attachment_mime: details.mime ?? null
  };
}
async function runRpc(actor, operation, details) { return callRpc("student_exams_action", rpcArgs(actor, operation, details)); }
function safeError(error) {
  const status = Number(error?.status) || 500;
  if (status === 401) return json({ error: "unauthorized" }, 401);
  if (status === 403) return json({ error: error?.code === "password_reset_required" ? "password_reset_required" : "forbidden" }, 403);
  if (status === 400 || status === 413) return json({ error: status === 413 ? "payload_too_large" : "invalid_request" }, status);
  if (status === 404) return json({ error: "not_found" }, 404);
  if (status === 409) return json({ error: "conflict" }, 409);
  console.error("student-exams request failed", { code: error?.code || "internal_error" });
  return json({ error: "service_unavailable" }, status >= 500 ? 503 : 500);
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let pendingPath = null;
  let committed = false;
  let preservePendingPathOnError = false;
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw fail(400, "invalid_request");
    const body = await readJsonRequest(request, MAX_BODY_BYTES);
    const operation = parseOperation(body);
    const actor = await resolveActor(request);
    if (actor.mapping.needs_password_reset !== false) throw fail(403, "password_reset_required");
    if (operation.op === "list") return json(await listExams());
    if (operation.op === "submit") {
      const attemptId = crypto.randomUUID();
      let attachment = null;
      if (operation.attachmentData !== undefined) {
        attachment = parseAttachment(operation.attachmentData);
        pendingPath = `${actor.authUser.id}/${attemptId}.${attachment.extension}`;
        await uploadPrivateObject(BUCKET, pendingPath, attachment.bytes, { contentType: attachment.mime, upsert: false });
      }
      let result;
      try {
        result = await runRpc(actor, operation, { attemptId, path: pendingPath, mime: attachment?.mime ?? null });
      } catch (error) {
        // A timeout or 5xx may follow a committed insert; keep the attachment rather than
        // breaking the reference held by a durable exam attempt.
        const status = Number(error?.status) || 0;
        if (!status || status >= 500) preservePendingPathOnError = true;
        throw error;
      }
      if (result?.duplicate === true) {
        if (pendingPath) await deletePrivateObject(BUCKET, pendingPath).catch(() => {});
        pendingPath = null;
        return json({ ok: true, alreadySubmitted: true });
      }
      if (result?.ok !== true) throw fail(result?.conflict ? 409 : result?.forbidden ? 403 : 404, "operation_failed");
      committed = true;
      const response = { ok: true, attemptId: result.attemptId, result: result.result };
      if (pendingPath) response.attachmentUrl = await createPrivateSignedUrl(BUCKET, pendingPath, 60);
      pendingPath = null;
      return json(response);
    }
    const result = await runRpc(actor, operation);
    if (result?.ok !== true) throw fail(result?.forbidden ? 403 : result?.conflict ? 409 : 404, "operation_failed");
    if (operation.op === "mine" || operation.op === "review_queue") {
      if (!Array.isArray(result.items)) throw fail(503, "service_unavailable");
      const items = await Promise.all(result.items.map(async item => {
        const out = { ...item };
        if (typeof out.attachment_path === "string") {
          out.attachmentUrl = await createPrivateSignedUrl(BUCKET, out.attachment_path, 60);
          delete out.attachment_path;
        }
        return out;
      }));
      return json({ items });
    }
      if (operation.op === "attachment_url") {
      if (typeof result.attachment_path !== "string") throw fail(404, "not_found");
      return json({ attachmentUrl: await createPrivateSignedUrl(BUCKET, result.attachment_path, 60) });
    }
    const deletePath = result.delete_path ?? result.result?.delete_path;
    if (typeof deletePath === "string") await deletePrivateObject(BUCKET, deletePath).catch(() => {});
    const responseBody = result.result && typeof result.result === "object" ? { ...result.result } : {};
    delete responseBody.delete_path;
    return json({ ok: true, ...responseBody });
  } catch (error) {
    if (pendingPath && !committed && !preservePendingPathOnError) await deletePrivateObject(BUCKET, pendingPath).catch(() => {});
    return safeError(error);
  }
}

export { parseOperation, parseAttachment, listExams };
