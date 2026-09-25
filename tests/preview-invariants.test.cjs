const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const functionSource = fs.readFileSync(path.join(root, 'netlify/functions/generate-exam.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing body for ${name}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

function loadPureAppHelpers() {
  const state = { vacations: null, leaveRequests: [], users: [] };
  const context = {
    state,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Set,
    ensureAttendance: user => user.attendance || (user.attendance = { dates: [], streak: 0, lastDate: null }),
    getTotalPoints: user => Number(user.points || 0),
    getRank: () => ({ title: 'متقدم' }),
    activeLeaveForUser: () => null,
    leaveLabel: v => v.mode,
  };
  const names = [
    'leaveRulesForMode', 'leaveDateIsValid', 'leaveStartDate', 'leaveEndDate', 'leaveIsActive',
    'leaveRulesForRecord', 'isLeaveRuleEnabledForUser', 'missedDaysCoveredByProtectedLeave',
    'learnerSnapshot', 'publishedExamIsComplete',
  ];
  vm.runInNewContext(names.map(n => extractFunction(html, n)).join('\n'), context);
  return context;
}

function mockHandler(modelJson) {
  let calls = 0;
  const context = {
    exports: {},
    process: { env: { OPENAI_API_KEY: 'test-only-not-a-real-secret' } },
    console: { error() {} },
    fetch: async (_url, _options) => {
      calls++;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(modelJson) } }] }),
        text: async () => '',
      };
    },
  };
  vm.runInNewContext(functionSource, context);
  return { handler: context.exports.handler, get calls() { return calls; } };
}

const sourceText = 'هذه فقرة تعليمية طويلة بما يكفي لاختبار التحقق المحلي من طلبات النص، وتتضمن عدة كلمات ومعلومات يمكن بناء سؤال واضح عليها دون إرسال أي بيانات حقيقية.';

 test('quiz schema normalization accepts a complete four-option question', async () => {
  const mock = mockHandler({ questions: [{
    q: 'ما الفكرة الرئيسة؟', instruction: 'اقرأ الفقرة', passage: 'هذه فقرة أصلية مكتملة.',
    type: 'multiple', options: ['الفكرة الصحيحة', 'خيار ثانٍ', 'خيار ثالث', 'خيار رابع'],
    answer: 'الفكرة الصحيحة', modelAnswer: 'الفكرة الصحيحة',
  }] });
  const result = await mock.handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'quiz', source: sourceText, count: 1, type: 'multiple' }) });
  const payload = JSON.parse(result.body);
  assert.equal(result.statusCode, 200);
  assert.equal(payload.questions.length, 1);
  assert.equal(payload.questions[0].passage, 'هذه فقرة أصلية مكتملة.');
  assert.equal(payload.questions[0].options.length, 4);
  assert.ok(payload.questions[0].options.includes(payload.questions[0].answer));
  assert.equal(mock.calls, 1);
});

test('quiz rejects duplicate options and does not echo provider details', async () => {
  const mock = mockHandler({ questions: [{
    q: 'ما الفكرة؟', passage: 'فقرة كاملة.', type: 'multiple',
    options: ['إجابة', 'إجابة', 'ثلاثة', 'أربعة'], answer: 'إجابة', modelAnswer: 'إجابة',
  }] });
  const result = await mock.handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'quiz', source: sourceText }) });
  assert.equal(result.statusCode, 500);
  assert.equal(JSON.parse(result.body).questions, undefined);
  assert.equal(JSON.parse(result.body).detail, undefined);
});

test('true-false questions require the two exact choices', async () => {
  const mock = mockHandler({ questions: [{
    q: 'هل العبارة صحيحة؟', passage: 'فقرة كاملة.', type: 'truefalse',
    options: ['نعم', 'لا'], answer: 'صح', modelAnswer: 'صح',
  }] });
  const result = await mock.handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'quiz', source: sourceText, count: 1, type: 'truefalse' }) });
  assert.equal(result.statusCode, 500);
});

test('unknown operation and oversized source are rejected before calling the model', async () => {
  const mock = mockHandler({ questions: [] });
  const unknown = await mock.handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'not-an-action', source: sourceText }) });
  assert.equal(unknown.statusCode, 400);
  const large = await mock.handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'summary', source: 'ن'.repeat(30001) }) });
  assert.equal(large.statusCode, 413);
  assert.equal(mock.calls, 0);
});

test('essay question accepts its model answer and keeps the passage', async () => {
  const mock = mockHandler({ questions: [{
    q: 'اشرح الفكرة.', passage: 'فقرة مرجعية.', type: 'essay', options: [], answer: 'إجابة نموذجية.', modelAnswer: 'إجابة نموذجية.',
  }] });
  const result = await mock.handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'quiz', source: sourceText, count: 1, type: 'essay' }) });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).questions[0].modelAnswer, 'إجابة نموذجية.');
});

test('effective leave rules combine group and individual coverage without blanket attendance blocking', () => {
  const app = loadPureAppHelpers();
  const user = { id: 'synthetic-1' };
  app.state.vacations = { scope: 'all', mode: 'meetings', status: 'scheduled', start: '2026-09-01', end: '2026-09-30', rules: app.leaveRulesForMode('meetings') };
  app.state.leaveRequests = [{ userId: user.id, status: 'approved', mode: 'custom', start: '2026-09-01', end: '2026-09-30', rules: { attendance: true, streak: true } }];
  assert.equal(app.isLeaveRuleEnabledForUser(user, 'meetings'), true);
  assert.equal(app.isLeaveRuleEnabledForUser(user, 'attendance'), true);
  assert.equal(app.isLeaveRuleEnabledForUser(user, 'tasks'), false);
  assert.equal(app.leaveRulesForMode('light', { streak: false }).streak, false);
});

test('leave dates reject impossible calendar values instead of normalizing silently', () => {
  const app = loadPureAppHelpers();
  assert.equal(app.leaveDateIsValid('2026-02-28T10:00'), true);
  assert.equal(app.leaveDateIsValid('2026-02-30T10:00'), false);
  assert.equal(app.leaveStartDate({ start: '2026-02-30T10:00' }), null);
});

test('protected streak survives only when every missed calendar day is covered', () => {
  const app = loadPureAppHelpers();
  const user = { id: 'synthetic-2' };
  app.state.vacations = { scope: 'all', status: 'scheduled', start: '2026-09-02', end: '2026-09-03', rules: { streak: true } };
  assert.equal(app.missedDaysCoveredByProtectedLeave(user, '2026-09-01', '2026-09-04'), true);
  app.state.vacations.end = '2026-09-02';
  assert.equal(app.missedDaysCoveredByProtectedLeave(user, '2026-09-01', '2026-09-04'), false);
});

test('learner snapshot carries outcome aggregates but no free-text answers or real identity', () => {
  const app = loadPureAppHelpers();
  const user = {
    id: 'private-id', name: 'Synthetic Student', points: 45,
    attendance: { dates: ['2026-09-20'], streak: 2, lastDate: '2026-09-20' },
    completedTasks: [{ id: 't1', cycleKey: 'daily-2026-09-20' }],
    publishedExamResults: { e1: { date: '2026-09-20', answers: [
      { type: 'multiple', given: 'private answer text', isCorrect: false },
      { type: 'essay', given: 'private essay text', leaderReviewed: false },
    ] } },
    smartRecResult: { percent: 82, status: 'pending', date: '2026-09-20' },
  };
  const snapshot = app.learnerSnapshot(user, 'student_01');
  assert.equal(snapshot.student, 'student_01');
  assert.equal(snapshot.accuracy, 0);
  assert.equal(snapshot.wrongAnswers, 1);
  assert.equal(snapshot.essayReviewsPending, 1);
  assert.equal(snapshot.recitation.score, 82);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.recentTaskTrend)), { daily: 1, weekly: 0, meeting: 0, other: 0 });
  assert.equal(JSON.stringify(snapshot).includes('Synthetic Student'), false);
  assert.equal(JSON.stringify(snapshot).includes('private essay text'), false);
});

test('incomplete legacy exams are blocked; complete exam fixtures pass validation', () => {
  const app = loadPureAppHelpers();
  const complete = { questions: [{ q: 'سؤال', passage: 'الفقرة الأصلية', type: 'multiple', options: ['أ', 'ب', 'ج', 'د'], answer: 'أ' }] };
  const old = { questions: [{ q: 'سؤال قديم', answer: 'الإجابة التي يجب ألا تتحول إلى فقرة', options: ['أ', 'ب', 'ج', 'د'], type: 'multiple' }] };
  assert.equal(app.publishedExamIsComplete(complete), true);
  assert.equal(app.publishedExamIsComplete(old), false);
  assert.equal(html.includes("if(q.type==='multiple'&&!q.passage&&q.answer)q.passage=q.answer"), false);
  assert.match(html, /id="leaderExamPreview"/);
  assert.match(html, /confirmPublishLeaderExam/);
  const draftFlow = extractFunction(html, 'publishLeaderExam');
  const publishFlow = extractFunction(html, 'confirmPublishLeaderExam');
  assert.equal(draftFlow.includes('state.aiExams.unshift'), false);
  assert.equal(draftFlow.includes('renderLeaderExamDraft'), true);
  assert.equal(publishFlow.includes('state.aiExams.unshift'), true);
  assert.equal(publishFlow.includes('!isLeader(me())'), true);
});

test('medical leave bypasses the AI request and visible screens do not expose backend failure details', () => {
  assert.match(html, /if\(req\.type==='مرضية'\)return/);
  assert.match(functionSource, /body:JSON\.stringify\(\{error:'تعذر تنفيذ العملية الذكية الآن'\}\)/);
  assert.equal(functionSource.includes("detail:error.message"), false);
});
