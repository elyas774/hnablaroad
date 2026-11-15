const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(new URL('./supabase-feature-cutover.js', `file://${__filename}`), 'utf8');

function createHarness({ feature, posts = [] } = {}) {
  const calls = [];
  const user = { id: 'student-1', name: 'Learner', examResult: null };
  const context = {
    console,
    Promise,
    Date,
    Intl,
    Math,
    setTimeout,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    state: { users: [user], posts, examQuestions: [], aiExams: [], leaveRequests: [], leaveHistory: [], challengeSubmissions: [], challengeLogs: [] },
    session: { userId: user.id },
    currentPage: 'exams',
    me: () => user,
    isLeader: () => false,
    examSetSignature: () => 'q1',
    publishedExamResult: () => null,
    escapeHtml: value => String(value ?? ''),
    toast: () => {},
    logDiwan: async () => {},
    renderExamQuestionsBox: () => {},
    renderExamQuestionsAdmin: () => {},
    renderRanking: () => {},
    renderChallengesPage: () => {},
    renderWeeklyChallenge: () => {},
    renderFeed: () => {},
    loadState: async () => {},
    attachChatListener: () => {},
    attachNotificationsListener: () => {},
    attachSharedLiveListener: () => {},
    enterApp: () => {},
    document: {
      querySelectorAll: selector => selector === '.examAnswerInput' ? [{ dataset: { qid: 'q1' }, value: 'جواب كتبه الطالب' }] : [],
      getElementById: () => null
    }
  };
  context.window = context;
  context.globalThis = context;
  context.hanabilaSupabaseAuth = {
    feature: async (name, payload) => {
      calls.push({ name, payload });
      if (feature) return feature(name, payload);
      if (name === 'student-exams' && payload.op === 'list') return { questionBank: [{ id: 'q1', question: 'سؤال' }], published: [], archive: [] };
      if (name === 'student-exams' && payload.op === 'mine') return { items: [] };
      return {};
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'supabase-feature-cutover.js' });
  return { context, calls, user };
}

test('question-bank submission sends only qid and the student answer to the authenticated gateway', async () => {
  const { context, calls } = createHarness();
  await context.submitExamAnswers();
  const submitted = calls.find(call => call.name === 'student-exams' && call.payload.op === 'submit');
  assert.ok(submitted);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.payload.answers)), [{ qid: 'q1', given: 'جواب كتبه الطالب' }]);
  assert.equal('correctAnswer' in submitted.payload, false);
  assert.equal('score' in submitted.payload, false);
  assert.equal('isCorrect' in submitted.payload.answers[0], false);
});

test('challenge state consumes the feature gateway data envelope and carries only own submission status', async () => {
  const serverData = {
    weekly: { question: 'سؤال الأسبوع', options: ['أ', 'ب', 'ج', 'د'], answered: false, correct: null },
    challengeTickets: 3,
    logs: [{ text: 'تذكرة', icon: '🎟️' }],
    ayatSubmission: { id: 'submission-1', userId: 'student-1', dateKey: '2026-11-14', text: 'آية' }
  };
  const { context } = createHarness({ feature: async (_name, payload) => payload.op === 'state' ? serverData : {} });
  await context.refreshChallengeData();
  assert.equal(context.state.weeklyChallenge.question, 'سؤال الأسبوع');
  assert.equal(context.state.challengeTickets, 3);
  assert.equal(context.todayAyatSubmission(context.me()).id, 'submission-1');
});

test('daily Ayat entries remain unlimited while ticket award is server-capped at one', async () => {
  let submissions = 0;
  const { context, calls } = createHarness({
    feature: async (_name, payload) => {
      if (payload.op === 'ayat_submit') return { ticketAwarded: ++submissions === 1 };
      if (payload.op === 'state') return { challengeTickets: 1, logs: [], ayatSubmissionCount: submissions, ayatSubmission: { id: `submission-${submissions}`, userId: 'student-1', dateKey: '2026-11-14' } };
      return {};
    }
  });
  const input = { value: 'آية أولى' }, status = { textContent: '' }, balance = { textContent: '' };
  context.document.getElementById = id => id === 'ayatChallengeText' ? input : id === 'ayatChallengeStatus' ? status : id === 'challengeTicketBalance' ? balance : null;
  await context.submitAyatChallenge();
  input.value = 'آية ثانية';
  await context.submitAyatChallenge();
  assert.equal(calls.filter(call => call.name === 'student-challenges' && call.payload.op === 'ayat_submit').length, 2);
  assert.match(status.textContent, /2/);
});

test('feed refresh retains imported posts as read-only alongside Supabase posts', async () => {
  const { context } = createHarness({
    posts: [{ id: 'legacy-id', authorName: 'قديماً', text: 'منشور سابق', reactions: [], comments: [] }],
    feature: async () => ({ posts: [{ id: '00000000-0000-4000-8000-000000000002', authorName: 'Learner', text: 'منشور جديد', reactions: [], comments: [] }] })
  });
  await context.refreshSocialFeed();
  assert.deepEqual(JSON.parse(JSON.stringify(context.state.posts.map(post => post.id))), ['00000000-0000-4000-8000-000000000002', 'legacy-id']);
  assert.equal(context.state.posts[1]._legacyReadOnly, true);
});


test('leave refresh merges server-owned excuses with read-only imported history', async () => {
  const { context, calls } = createHarness({
    feature: async (_name, payload) => {
      if (payload.op === 'mine') return { items: [{ id: 'new-leave', status: 'pending' }] };
      if (payload.op === 'excuse_mine') return { items: [{ id: 'new-excuse', status: 'pending', text: 'جديد' }] };
      return { items: [] };
    }
  });
  context.state.leaveRequests = [{ id: 'old-leave', status: 'pending' }];
  context.state.excuses = [{ id: 'old-excuse', status: 'pending', text: 'سابق' }];
  await context.refreshLeaveData();
  assert.equal(context.state.leaveRequests.find(item => item.id === 'old-leave')._legacyReadOnly, true);
  assert.equal(context.state.leaveRequests.find(item => item.id === 'new-leave')._legacyReadOnly, undefined);
  assert.equal(context.state.excuses.find(item => item.id === 'old-excuse')._legacyReadOnly, true);
  assert.equal(context.state.excuses.find(item => item.id === 'new-excuse')._legacyReadOnly, undefined);
  assert.equal(calls.some(call => call.name === 'student-leaves' && call.payload.op === 'excuse_mine'), true);
});

test('new excuse submission sends only bounded details to the private leave gateway', async () => {
  const { context, calls } = createHarness({
    feature: async (_name, payload) => payload.op === 'excuse_submit' ? { ok: true, excuse: { id: 'server-excuse', date: '2026-11-15 05:00' } } : { items: [] }
  });
  const reason = { value: 'موعد طبي' }, type = { value: 'غياب' }, file = { value: '', files: [] };
  context.document.getElementById = id => id === 'excuseText' ? reason : id === 'excuseType' ? type : id === 'excuseFile' ? file : null;
  context.renderVacationsPage = () => {};
  context.notifyLeaderByWhatsApp = async () => {};
  await context.submitExcuse();
  const submitted = calls.find(call => call.name === 'student-leaves' && call.payload.op === 'excuse_submit');
  assert.ok(submitted);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.payload)), { op: 'excuse_submit', type: 'غياب', text: 'موعد طبي' });
  assert.equal(reason.value, '');
  assert.equal(calls.some(call => call.name === 'student-leaves' && call.payload.op === 'submit'), false);
});

test('legacy excuse review is rejected locally while a new review uses the gateway', async () => {
  const { context, calls } = createHarness({ feature: async () => ({ items: [] }) });
  context.isLeader = () => true;
  context.state.excuses = [{ id: 'old-excuse', status: 'pending', _legacyReadOnly: true }];
  await context.reviewExcuse('old-excuse', 'approved');
  assert.equal(calls.some(call => call.name === 'student-leaves' && call.payload.op === 'excuse_review'), false);
  context.state.excuses = [{ id: 'new-excuse', status: 'pending' }];
  context.renderVacationsPage = () => {};
  await context.reviewExcuse('new-excuse', 'approved');
  assert.equal(calls.some(call => call.name === 'student-leaves' && call.payload.op === 'excuse_review' && call.payload.requestId === 'new-excuse'), true);
});
