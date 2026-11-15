/*
 * Hanabla Road feature cutover.
 * Loaded after the legacy UI declarations and before init(); replaces unsafe
 * browser/shared-document mutations with authenticated Netlify feature gateways.
 */
(() => {
  'use strict';

  const auth = () => window.hanabilaSupabaseAuth;
  const randomId = () => globalThis.crypto.randomUUID();
  const noopWarn = (feature, error) => console.warn(`${feature} gateway unavailable`, error?.code || error?.message || 'unknown');
  const call = (name, payload) => auth().feature(name, payload);
  const setById = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  const safeToast = (message) => { if (typeof toast === 'function') toast(message); };
  const toDataUrl = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(file);
  });
  const featureError = (error) => {
    if (error?.code === 'conflict' || error?.status === 409) return 'تعارضت العملية مع تحديث آخر؛ حدّث الصفحة وحاول مجددًا.';
    if (error?.code === 'forbidden' || error?.status === 403) return 'ليست لديك صلاحية لهذه العملية.';
    if (error?.code === 'password_reset_required') return 'يجب تغيير كلمة المرور المؤقتة أولًا.';
    return 'تعذّر إتمام العملية؛ تحقق من الاتصال ثم أعد المحاولة.';
  };

  async function refreshExamData() {
    try {
      const [catalog, mine] = await Promise.all([
        call('student-exams', { op: 'list' }),
        call('student-exams', { op: 'mine' })
      ]);
      state.examQuestions = Array.isArray(catalog.questionBank) ? catalog.questionBank : [];
      state.aiExams = Array.isArray(catalog.published) ? catalog.published : [];
      state.examArchive = Array.isArray(catalog.archive) ? catalog.archive : [];
      const user = me();
      const attempts = Array.isArray(mine.items) ? mine.items.filter(x => x?.status === 'submitted') : [];
      if (user) {
        const bank = attempts.find(x => x.kind === 'question_bank');
        user.examResult = bank ? { ...bank, sig: examSetSignature(), total: bank.total || bank.answers?.length || 0 } : null;
        user.publishedExamResults = Object.fromEntries(attempts.filter(x => x.kind === 'published').map(x => [x.examId, x]));
      }
      state.examReviewQueue = [];
      state.publishedExamReviewQueues = {};
      if (isLeader(me())) {
        const bankQueue = await call('student-exams', { op: 'review_queue', kind: 'question_bank', examId: 'current' });
        state.examReviewQueue = Array.isArray(bankQueue.items) ? bankQueue.items : [];
        const reviewable = state.aiExams.filter(exam => publishedExamResult(me(), exam.id));
        const queues = await Promise.all(reviewable.map(async exam => {
          const response = await call('student-exams', { op: 'review_queue', kind: 'published', examId: exam.id });
          return [exam.id, Array.isArray(response.items) ? response.items : []];
        }));
        state.publishedExamReviewQueues = Object.fromEntries(queues);
      }
      return true;
    } catch (error) {
      noopWarn('exam', error);
      return false;
    }
  }

  async function refreshLeaveData() {
    try {
      const user = me();
      const [mine, queue, excuseMine, excuseQueue] = await Promise.all([
        call('student-leaves', { op: 'mine' }),
        isLeader(user) ? call('student-leaves', { op: 'review_queue' }) : Promise.resolve({ items: [] }),
        call('student-leaves', { op: 'excuse_mine' }),
        isLeader(user) ? call('student-leaves', { op: 'excuse_review_queue' }) : Promise.resolve({ items: [] })
      ]);
      const authoritative = [...(Array.isArray(mine.items) ? mine.items : []), ...(Array.isArray(queue.items) ? queue.items : [])];
      if (!Array.isArray(state.legacyLeaveRequests)) {
        state.legacyLeaveRequests = (Array.isArray(state.leaveRequests) ? state.leaveRequests : []).filter(x => x?.id).map(x => ({ ...x, _legacyReadOnly: true }));
      }
      const merged = new Map(state.legacyLeaveRequests.filter(x => x?.id).map(x => [x.id, x]));
      authoritative.forEach(item => merged.set(item.id, item));
      state.leaveRequests = [...merged.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      const history = Array.isArray(state.leaveHistory) ? state.leaveHistory : [];
      const historyMap = new Map(history.filter(x => x?.id).map(x => [x.id, x]));
      authoritative.forEach(item => historyMap.set(item.id, { ...item, title: 'طلب إجازة فردية' }));
      state.leaveHistory = [...historyMap.values()];

      if (!Array.isArray(state.legacyExcuses)) {
        state.legacyExcuses = (Array.isArray(state.excuses) ? state.excuses : []).filter(x => x?.id).map(x => ({ ...x, _legacyReadOnly: true }));
      }
      const excuseMap = new Map(state.legacyExcuses.filter(x => x?.id).map(x => [x.id, x]));
      [...(Array.isArray(excuseMine.items) ? excuseMine.items : []), ...(Array.isArray(excuseQueue.items) ? excuseQueue.items : [])]
        .forEach(item => excuseMap.set(item.id, item));
      state.excuses = [...excuseMap.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return true;
    } catch (error) {
      noopWarn('leave', error);
      return false;
    }
  }

  async function refreshChallengeData() {
    try {
      const result = await call('student-challenges', { op: 'state' });
      const data = result.data || result || {};
      state.challengeServerState = data;
      state.challengeLogs = Array.isArray(data.logs) ? data.logs : [];
      state.challengeTickets = Number(data.challengeTickets) || 0;
      if (me()) me().challengeTickets = state.challengeTickets;
      state.weeklyChallenge = data.weekly || null;
      state.challengeTodaySubmitted = data.ayatSubmission || null;
      state.challengeTodaySubmissionCount = Number(data.ayatSubmissionCount) || 0;
      const submissions = state.challengeTodaySubmitted ? [state.challengeTodaySubmitted] : [];
      if (isLeader(me())) {
        const leader = await call('student-challenges', { op: 'leader_submissions' });
        state.challengeSubmissions = Array.isArray(leader.submissions) ? leader.submissions : submissions;
      } else {
        state.challengeSubmissions = submissions;
      }
      return true;
    } catch (error) {
      noopWarn('challenge', error);
      return false;
    }
  }

  async function refreshSocialFeed() {
    try {
      const result = await call('student-social', { op: 'feed' });
      if (!Array.isArray(state.legacyPosts)) {
        state.legacyPosts = Array.isArray(state.posts) ? state.posts.map(post => ({ ...post, _legacyReadOnly: true })) : [];
      }
      const serverPosts = Array.isArray(result.posts) ? result.posts : [];
      const serverIds = new Set(serverPosts.map(post => post.id));
      state.posts = [...serverPosts, ...state.legacyPosts.filter(post => !serverIds.has(post.id))];
      return true;
    } catch (error) {
      noopWarn('social', error);
      return false;
    }
  }

  async function refreshMigrationFeatures() {
    await Promise.all([refreshExamData(), refreshLeaveData(), refreshChallengeData(), refreshSocialFeed()]);
  }

  window.refreshExamData = refreshExamData;
  window.refreshLeaveData = refreshLeaveData;
  window.refreshChallengeData = refreshChallengeData;
  window.refreshSocialFeed = refreshSocialFeed;
  window.refreshMigrationFeatures = refreshMigrationFeatures;

  window.startAuthenticatedSession = async function startAuthenticatedSession(userId) {
    session.userId = userId;
    await loadState();
    if (!state.users.some(user => user && user.id === userId)) {
      session.userId = null;
      throw new Error('account_data_not_found');
    }
    await refreshMigrationFeatures();
    if (typeof refreshTaskReviewQueue === 'function' && isLeader(me())) void refreshTaskReviewQueue();
    attachChatListener();
    attachNotificationsListener();
    attachSharedLiveListener();
    enterApp();
  };

  // EXAMS -------------------------------------------------------------------
  window.renderExamQuestionsAdmin = function renderExamQuestionsAdmin() {
    const user = me(), wrap = document.getElementById('leaderQuestionsBox');
    if (wrap) wrap.style.display = isLeader(user) ? 'block' : 'none';
    const list = document.getElementById('examQuestionsAdminList');
    if (!list) return;
    const qs = Array.isArray(state.examQuestions) ? state.examQuestions : [];
    list.innerHTML = qs.length ? qs.map(q => `<div class="row-item"><div class="main"><div class="t">${escapeHtml(q.question || '')}</div><div class="d">مفتاح الإجابة محفوظ على الخادم</div></div><div class="actions"><button class="btn sm ghost" onclick="deleteExamQuestion('${q.id}')">حذف</button></div></div>`).join('') : '<div class="empty">لا توجد أسئلة بعد</div>';
  };

  window.addExamQuestion = async function addExamQuestion() {
    if (!isLeader(me())) return;
    const question = document.getElementById('examQInput')?.value.trim() || '';
    const answer = document.getElementById('examAInput')?.value.trim() || '';
    if (!question || !answer) { safeToast('اكتب السؤال والإجابة'); return; }
    try {
      await call('student-exams', { op: 'question_add', question, answer });
      setById('examQInput', ''); setById('examAInput', '');
      await refreshExamData(); renderExamQuestionsAdmin(); renderExamQuestionsBox(); renderExamArchive();
      safeToast('تم حفظ السؤال بأمان');
      const user = me();
      await logDiwan('اختبارات', '📝', 'أضاف قائد الأسبوع ' + user.name + ' سؤالًا جديدًا في الاختبار');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.deleteExamQuestion = async function deleteExamQuestion(id) {
    if (!isLeader(me())) return;
    try {
      await call('student-exams', { op: 'question_delete', qid: id });
      await refreshExamData(); renderExamQuestionsAdmin(); renderExamQuestionsBox(); renderExamArchive(); renderSavedAiExams();
      safeToast('تم حذف السؤال وأُرشف على الخادم');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.submitExamAnswers = async function submitExamAnswers() {
    const user = me(); if (!user) return;
    const answers = [...document.querySelectorAll('.examAnswerInput')].map(input => ({ qid: input.dataset.qid, given: input.value.trim() }));
    if (!answers.length || answers.some(answer => !answer.given)) { safeToast('أجب عن جميع الأسئلة قبل التسليم'); return; }
    try {
      const result = await call('student-exams', { op: 'submit', kind: 'question_bank', examId: 'current', answers });
      if (result.alreadySubmitted) safeToast('لديك إجابة مسجلة بالفعل');
      await refreshExamData(); renderExamQuestionsBox(); renderExamReviewList();
      if (!result.alreadySubmitted) {
        safeToast('تم إرسال إجاباتك بأمان، بانتظار مراجعة قائد الأسبوع');
        await logDiwan('اختبارات', '📝', user.name + ' أجاب على أسئلة الاختبار وينتظر مراجعة قائد الأسبوع');
      }
    } catch (error) { safeToast(featureError(error)); }
  };

  window.redoExamResult = async function redoExamResult() {
    if (!me()?.examResult) return;
    try {
      await call('student-exams', { op: 'redo', kind: 'question_bank', examId: 'current' });
      await loadState(); await refreshExamData();
      renderExamQuestionsBox(); renderExamQuestionsAdmin(); renderExamReviewList(); renderRanking();
      safeToast('تم إلغاء المحاولة ويمكنك الإجابة من جديد');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.renderExamReviewList = function renderExamReviewList() {
    const wrap = document.getElementById('leaderExamReviewBox'), box = document.getElementById('examAnswersReviewBox');
    const leader = isLeader(me());
    if (wrap) wrap.style.display = leader ? 'block' : 'none';
    if (!box || !leader) return;
    const attempts = Array.isArray(state.examReviewQueue) ? state.examReviewQueue : [];
    box.innerHTML = attempts.length ? attempts.map(attempt => `<div class="subsection-label">${escapeHtml(attempt.studentName || attempt.studentId)}</div>` + (attempt.answers || []).map(answer => {
      const options = [0, 2, 4, 6, 8, 10].map(points => `<option value="${points}" ${Number(answer.awardedPoints || 0) === points ? 'selected' : ''}>${points} نقاط</option>`).join('');
      return `<div class="row-item"><div class="main"><div class="t">${escapeHtml(answer.question || '')}</div><div class="d">إجابة الطالب: ${escapeHtml(answer.given || '—')} • ${answer.leaderReviewed ? 'تمت المراجعة' : 'بانتظار المراجعة'}</div></div><div class="actions"><select onchange="leaderMarkExamAnswer('${attempt.studentId}','${answer.qid}',this.value)">${options}</select></div></div>`;
    }).join('')).join('') : '<div class="empty">لا توجد إجابات طلاب بانتظار المراجعة بعد</div>';
  };

  window.leaderMarkExamAnswer = async function leaderMarkExamAnswer(userId, qid, points) {
    if (!isLeader(me())) return;
    const awarded = Number(points);
    if (![0, 2, 4, 6, 8, 10].includes(awarded)) { safeToast('الدرجة غير صالحة'); return; }
    try {
      await call('student-exams', { op: 'grade', kind: 'question_bank', examId: 'current', studentId: userId, qid, points: awarded });
      await loadState(); await refreshExamData(); renderExamReviewList(); renderExamQuestionsAdmin(); renderRanking();
      safeToast('تم حفظ الدرجة عبر الخادم');
    } catch (error) { safeToast(featureError(error)); }
  };

  const legacyPublishedResult = window.publishedExamResult;
  window.renderPublishedExamStudent = function renderPublishedExamStudent(exam, user) {
    const result = legacyPublishedResult(user, exam.id);
    if (result) {
      const correct = (result.answers || []).filter(answer => answer.isCorrect === true).length;
      const answers = (result.answers || []).map(answer => `<div class="row-item"><div class="main"><div class="t">${escapeHtml(answer.question || '')}</div><div class="d">إجابتك: ${escapeHtml(answer.given || '—')} — ${answer.type === 'essay' && answer.leaderReviewed !== true ? '⏳ بانتظار مراجعة القائد' : (answer.isCorrect ? '✅ صحيحة' : '❌ غير صحيحة')} • ${Number(answer.awardedPoints || 0)} نقطة</div></div></div>`).join('');
      return `<div class="card" style="margin-top:12px;"><div class="pill gold">نتيجتك: ${correct}/${exam.questions.length} — النقاط المعتمدة: ${Number(result.points || 0)}</div><div style="margin-top:10px;">${answers}</div><button class="btn sm ghost" onclick="redoPublishedExam('${exam.id}')">إعادة الاختبار</button></div>`;
    }
    const questions = exam.questions.map((q, i) => {
      const head = `<div class="exam-question-title"><span class="exam-question-number">${i + 1}</span>${escapeHtml(q.q || 'سؤال')}</div><div class="exam-instruction">${escapeHtml(q.instruction || 'اقرأ النص ثم أجب.')}</div>`;
      const passage = q.passage ? `<div class="exam-passage"><span class="exam-passage-label">الفقرة</span>${escapeHtml(q.passage)}</div>` : '';
      if (q.type === 'essay') return `<div class="exam-question-card">${head}${passage}<textarea name="pub-${exam.id}-${i}" rows="5" maxlength="2000" placeholder="اكتب إجابتك بأسلوبك..."></textarea></div>`;
      return `<div class="exam-question-card">${head}${passage}<div class="exam-options">${(q.options || []).map(option => `<label class="exam-option"><input type="radio" name="pub-${exam.id}-${i}" value="${escapeHtml(option)}"><span>${escapeHtml(option)}</span></label>`).join('')}</div></div>`;
    }).join('');
    return `<div class="card" style="margin-top:12px;"><div class="exam-meta"><span class="pill gold">${exam.difficulty === 'hard' ? 'صعب' : 'متوسط'}</span><span class="d">أجب عن جميع الأسئلة</span></div>${questions}<button class="btn gold block" onclick="submitPublishedExam('${exam.id}')">تسليم الاختبار</button></div>`;
  };

  window.submitPublishedExam = async function submitPublishedExam(examId) {
    const exam = (state.aiExams || []).find(item => item.id === examId);
    if (!exam || !me()) return;
    const answers = exam.questions.map((question, index) => ({
      qid: question.id || `legacy-${examId}-${index}`,
      given: question.type === 'essay'
        ? (document.querySelector(`[name="pub-${examId}-${index}"]`)?.value || '').trim()
        : (document.querySelector(`input[name="pub-${examId}-${index}"]:checked`)?.value || '').trim()
    }));
    if (answers.some(answer => !answer.given)) { safeToast('أجب عن جميع الأسئلة قبل التسليم'); return; }
    try {
      const result = await call('student-exams', { op: 'submit', kind: 'published', examId, answers });
      if (result.alreadySubmitted) safeToast('لديك إجابة مسجلة بالفعل');
      await loadState(); await refreshExamData(); renderPublishedExams();
      if (!result.alreadySubmitted) safeToast('تم تسليم الاختبار، وستراجع الإجابات المقالية من القائد');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.setPublishedAnswerPoints = async function setPublishedAnswerPoints(userId, examId, qid, value) {
    if (!isLeader(me())) return;
    const points = Number(value);
    if (![0, 2, 4, 6, 8, 10].includes(points)) return;
    try {
      await call('student-exams', { op: 'grade', kind: 'published', examId, studentId: userId, qid, points });
      await loadState(); await refreshExamData(); renderPublishedExams();
      safeToast('تم تحديث نقاط الإجابة');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.renderPublishedExamLeaderResults = function renderPublishedExamLeaderResults(exam) {
    if (!isLeader(me())) return '';
    if (!legacyPublishedResult(me(), exam.id)) return '<div class="card" style="margin-top:12px;background:var(--night-2);"><div class="eyebrow">إجابات الطلاب 🔒</div><div class="d">حل الاختبار أولًا لفتح قائمة المراجعة.</div></div>';
    const rows = state.publishedExamReviewQueues?.[exam.id] || [];
    const content = rows.length ? rows.map(attempt => `<div class="row-item"><div class="main"><div class="t">${escapeHtml(attempt.studentName || attempt.studentId)} — ${Number(attempt.score || 0)}/${exam.questions.length}</div><div class="d">النقاط المعتمدة: ${Number(attempt.points || 0)}</div>${(attempt.answers || []).map(answer => `<div class="d" style="margin-top:5px;">${escapeHtml(answer.question || '')}<br>إجابة: ${escapeHtml(answer.given || '—')} — ${answer.type === 'essay' ? 'مقالي' : (answer.isCorrect ? 'صحيحة' : 'خطأ')} <select onchange="setPublishedAnswerPoints('${attempt.studentId}','${exam.id}','${answer.qid}',this.value)">${[0,2,4,6,8,10].map(points => `<option value="${points}" ${Number(answer.awardedPoints || 0) === points ? 'selected' : ''}>${points} نقاط</option>`).join('')}</select></div>`).join('')}</div></div>`).join('') : '<div class="empty">لم يسلّم أي طالب هذا الاختبار بعد</div>';
    return `<div class="card" style="margin-top:12px;background:var(--night-2);"><div class="eyebrow">درجات الطلاب — للقائد فقط</div>${content}</div>`;
  };

  window.redoPublishedExam = async function redoPublishedExam(examId) {
    try {
      await call('student-exams', { op: 'redo', kind: 'published', examId });
      await loadState(); await refreshExamData(); renderPublishedExams();
    } catch (error) { safeToast(featureError(error)); }
  };
  window.deletePublishedExam = async function deletePublishedExam(examId) {
    if (!isLeader(me()) || !confirm('حذف الاختبار المنشور؟')) return;
    try { await call('student-exams', { op: 'published_delete', examId }); await refreshExamData(); renderPublishedExams(); safeToast('تم حذف الاختبار'); }
    catch (error) { safeToast(featureError(error)); }
  };

  function cleanPublishedQuestions(questions) {
    return (Array.isArray(questions) ? questions : []).slice(0, 20).map(question => {
      const type = ['multiple', 'truefalse', 'essay'].includes(question?.type) ? question.type : 'multiple';
      const normalized = {
        id: randomId(), q: String(question?.q || question?.question || '').trim().slice(0, 600), type,
        instruction: String(question?.instruction || '').slice(0, 500),
        passage: String(question?.passage || '').slice(0, 2000),
        statement: String(question?.statement || '').slice(0, 1000)
      };
      if (type === 'essay') {
        normalized.options = [];
        normalized.modelAnswer = String(question?.modelAnswer || question?.answer || '').slice(0, 2000);
        normalized.explanation = String(question?.explanation || '').slice(0, 1200);
      } else {
        normalized.options = (Array.isArray(question?.options) ? question.options : []).map(value => String(value).slice(0, 500)).filter(Boolean).slice(0, 6);
        normalized.answer = String(question?.answer || '').slice(0, 500);
        normalized.explanation = String(question?.explanation || '').slice(0, 1200);
      }
      return normalized;
    }).filter(question => question.q && (question.type === 'essay' ? question.modelAnswer : question.options.length >= 2 && question.options.includes(question.answer)));
  }

  window.publishLeaderExam = async function publishLeaderExam() {
    if (!isLeader(me())) return;
    const title = document.getElementById('leaderExamTitle')?.value.trim() || 'اختبار القائد';
    const count = Math.max(2, Math.min(20, parseInt(document.getElementById('leaderExamCount')?.value, 10) || 5));
    const type = document.getElementById('leaderExamType')?.value || 'mixed';
    const difficultyInput = document.getElementById('leaderExamDifficulty')?.value;
    const difficulty = difficultyInput === 'hard' ? 'hard' : 'medium';
    const source = document.getElementById('leaderExamSource')?.value.trim() || '';
    if (source.length < 120) { safeToast('أدخل نصًا تعليميًا أطول حتى يستطيع الذكاء فهمه'); return; }
    try {
      const raw = await requestAiExam(source, count, type, difficulty);
      const questions = cleanPublishedQuestions(raw);
      if (questions.length < 2) { safeToast('لم يتم إنشاء أسئلة صالحة كافية؛ جرّب نصًا أوضح وأطول'); return; }
      const exam = { id: randomId(), title, difficulty, questions };
      await call('student-exams', { op: 'publish', exam });
      await refreshExamData(); renderPublishedExams(); safeToast('تم نشر الاختبار عبر الخادم');
      await pushNotification('all', '📝 نشر القائد اختبارًا ذكيًا جديدًا: ' + title, me().name, me().id);
    } catch (error) { console.error(error); safeToast(featureError(error)); }
  };

  window.saveGeneratedAiExam = async function saveGeneratedAiExam() {
    const exam = currentGeneratedAiExam;
    if (!isLeader(me()) || !exam || !Array.isArray(exam.questions)) { safeToast('ولّد اختبارًا أولًا'); return; }
    const questions = cleanPublishedQuestions(exam.questions);
    if (questions.length < 2) { safeToast('يلزم وجود سؤالين صالحين على الأقل'); return; }
    try {
      await call('student-exams', { op: 'publish', exam: { id: randomId(), title: String(exam.title || 'اختبار ذكي').slice(0, 160), difficulty: 'medium', questions } });
      await refreshExamData(); renderPublishedExams(); safeToast('تم حفظ الاختبار ونشره بأمان');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.renderExamsPage = function renderExamsPage() {
    renderPublishedExams();
    const leader = isLeader(me());
    const smart = document.getElementById('leaderSmartRecBox'), admin = document.getElementById('leaderQuestionsBox');
    if (smart) smart.style.display = leader ? 'block' : 'none';
    if (admin) admin.style.display = leader ? 'block' : 'none';
    renderRequiredMem(); renderSmartRecBox(); renderSmartRecReviewList();
    renderExamQuestionsAdmin(); renderExamQuestionsBox(); renderExamReviewList(); renderExamArchive();
  };

  // LEAVE REQUESTS ----------------------------------------------------------
  window.submitLeaveRequest = async function submitLeaveRequest() {
    const user = me();
    const start = document.getElementById('leaveRequestStart')?.value;
    const end = document.getElementById('leaveRequestEnd')?.value;
    const reason = document.getElementById('leaveRequestReason')?.value.trim() || '';
    const type = document.getElementById('leaveRequestType')?.value || 'عادية';
    const mode = document.getElementById('leaveRequestMode')?.value || 'light';
    const file = document.getElementById('leaveRequestFile')?.files?.[0];
    const protectStreak = !!document.getElementById('leaveProtectStreak')?.checked;
    if (!user || !start || !end || !reason) { safeToast('أكمل بيانات طلب الإجازة'); return; }
    if (file && file.size > 2 * 1024 * 1024) { safeToast('حجم المرفق يجب ألا يتجاوز 2MB'); return; }
    try {
      const payload = { op: 'submit', start, end, type, mode, reason: reason.slice(0, 1000), protectStreak };
      if (file) payload.attachmentData = await toDataUrl(file);
      const response = await call('student-leaves', payload);
      const request = response.request;
      state.leaveRequests = [...(state.leaveRequests || []).filter(item => item.id !== request.id), request];
      state.leaveHistory = [ { ...request, title: 'طلب إجازة فردية' }, ...(state.leaveHistory || []).filter(item => item.id !== request.id) ];
      ['leaveRequestStart', 'leaveRequestEnd', 'leaveRequestReason', 'leaveRequestFile'].forEach(id => setById(id, ''));
      await refreshLeaveData(); renderVacationsPage(); safeToast('تم إرسال الطلب وسيُراجع من القائد');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.decideLeaveRequest = async function decideLeaveRequest(requestId, status) {
    if (!isLeader(me()) || !['approved', 'rejected'].includes(status)) return;
    if ((state.leaveRequests || []).some(item => item.id === requestId && item._legacyReadOnly)) return;
    try {
      const response = await call('student-leaves', { op: status === 'approved' ? 'approve' : 'reject', requestId });
      const request = response.request;
      state.leaveRequests = [...(state.leaveRequests || []).filter(item => item.id !== request.id), request];
      state.leaveHistory = [{ ...request, title: 'قرار طلب إجازة' }, ...(state.leaveHistory || []).filter(item => item.id !== request.id)];
      await refreshLeaveData(); renderVacationsPage();
      safeToast(status === 'approved' ? 'تم اعتماد الإجازة' : 'تم رفض الطلب');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.cancelLeaveRequest = async function cancelLeaveRequest(requestId) {
    try {
      const response = await call('student-leaves', { op: 'cancel', requestId });
      const request = response.request;
      state.leaveRequests = [...(state.leaveRequests || []).filter(item => item.id !== request.id), request];
      await refreshLeaveData(); renderVacationsPage(); safeToast('تم إلغاء الطلب');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.analyzeLeaveRequest = async function analyzeLeaveRequest(requestId) {
    if (!isLeader(me())) return;
    const request = (state.leaveRequests || []).find(item => item.id === requestId);
    if (!request || request._legacyReadOnly) return;
    safeToast('جارٍ تحليل الطلب ذكيًا...');
    request.aiReview = await analyzeLeavePayload(request);
    renderVacationsPage();
  };

  window.submitExcuse = async function submitExcuse() {
    const user = me(), input = document.getElementById('excuseText');
    const text = String(input?.value || '').trim();
    const type = document.getElementById('excuseType')?.value || 'أخرى';
    const file = document.getElementById('excuseFile')?.files?.[0];
    if (!user || !text) { safeToast('اكتب تفاصيل العذر'); return; }
    if (file && file.size > 2 * 1024 * 1024) { safeToast('حجم المرفق يجب ألا يتجاوز 2MB'); return; }
    try {
      const payload = { op: 'excuse_submit', type, text: text.slice(0, 1000) };
      if (file) payload.attachmentData = await toDataUrl(file);
      const response = await call('student-leaves', payload);
      await refreshLeaveData();
      if (input) input.value = '';
      setById('excuseFile', '');
      renderVacationsPage();
      await notifyLeaderByWhatsApp({ student: user.name, type, details: text, date: response.excuse?.date || nowStr(), hasAttachment: Boolean(file) });
      safeToast('تم إرسال العذر وإشعار القائد');
    } catch (error) { safeToast(featureError(error)); }
  };

  window.reviewExcuse = async function reviewExcuse(requestId, decision) {
    if (!isLeader(me()) || !['approved', 'rejected'].includes(decision)) return;
    if ((state.excuses || []).some(item => item.id === requestId && item._legacyReadOnly)) return;
    try {
      await call('student-leaves', { op: 'excuse_review', requestId, decision });
      await refreshLeaveData(); renderVacationsPage();
      safeToast(decision === 'approved' ? 'تم اعتماد العذر' : 'تم رفض العذر');
    } catch (error) { safeToast(featureError(error)); }
  };

  // SOCIAL FEED -------------------------------------------------------------
  window.renderFeed = function renderFeed() {
    const box = document.getElementById('feedList'), empty = document.getElementById('feedEmpty');
    if (!box) return;
    const posts = Array.isArray(state.posts) ? state.posts : [];
    if (!posts.length) { box.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';
    box.innerHTML = posts.map(post => {
      const reactions = Array.isArray(post.reactions) ? post.reactions : [];
      const reactionsHtml = FEED_REACTIONS.map(reaction => {
        const summary = reactions.find(item => item.emoji === reaction.emoji);
        const count = post._legacyReadOnly ? reactions.filter(item => item.emoji === reaction.emoji).length : Number(summary?.count || 0);
        const mine = post._legacyReadOnly ? reactions.some(item => item.userId === me()?.id && item.emoji === reaction.emoji) : !!summary?.mine;
        return `<button class="feed-react-btn${mine ? ' mine' : ''}" title="${escapeHtml(reaction.label)}" ${post._legacyReadOnly ? 'disabled' : `onclick="toggleReaction('${post.id}','${reaction.emoji}')"`}>${reaction.emoji}${count ? ' ' + count : ''}</button>`;
      }).join('');
      const comments = Array.isArray(post.comments) ? post.comments : [];
      const commentHtml = comments.map(comment => `<div class="feed-comment"><div><span class="fc-name">${escapeHtml(comment.authorName || 'طالب')}</span> <span class="fc-text">${escapeHtml(comment.text || '')}</span></div></div>`).join('');
      const commentForm = post._legacyReadOnly ? '' : `<div class="feed-comment-form"><input type="text" id="feedCommentInput-${post.id}" maxlength="500" placeholder="اكتب تعليقًا..."><button class="btn sm gold" onclick="addComment('${post.id}')">إرسال</button></div>`;
      return `<div class="feed-post"><div class="feed-post-head"><div class="feed-avatar">${escapeHtml(userInitial(post.authorName))}</div><div class="feed-post-meta"><div class="feed-post-name">${escapeHtml(post.authorName || 'طالب')}</div><div class="feed-post-time">${timeAgo(post.date)}</div></div></div><div class="feed-post-text">${escapeHtml(post.text || '')}</div><div class="feed-reactions">${reactionsHtml}</div><div class="feed-comments" id="feedComments-${post.id}" style="${comments.length ? '' : 'display:none;'}">${commentHtml}${commentForm}</div><button class="feed-toggle-comments" onclick="toggleFeedComments('${post.id}')">${comments.length ? comments.length + ' تعليق' : (post._legacyReadOnly ? 'لا توجد تعليقات' : 'أضف تعليقًا')}</button></div>`;
    }).join('');
  };

  window.addPost = async function addPost(userId, text) {
    const user = me();
    const content = String(text || '').trim();
    if (!user || user.id !== userId || !content) return;
    try {
      await call('student-social', { op: 'create_post', requestId: randomId(), text: content.slice(0, 2000) });
      await refreshSocialFeed(); if (currentPage === 'feed') renderFeed();
    } catch (error) { safeToast(featureError(error)); }
  };

  window.submitPost = async function submitPost() {
    const user = me(), input = document.getElementById('feedComposerInput');
    if (!user || !input || !input.value.trim()) { safeToast('اكتب شيئًا أولاً'); return; }
    await addPost(user.id, input.value); input.value = '';
  };

  window.toggleReaction = async function toggleReaction(postId, emoji) {
    if (!me()) return;
    try { await call('student-social', { op: 'toggle_reaction', postId, requestId: randomId(), emoji }); await refreshSocialFeed(); renderFeed(); }
    catch (error) { safeToast(featureError(error)); }
  };

  window.addComment = async function addComment(postId) {
    const input = document.getElementById('feedCommentInput-' + postId), text = input?.value.trim() || '';
    if (!me() || !text) return;
    try { await call('student-social', { op: 'create_comment', postId, requestId: randomId(), text: text.slice(0, 500) }); await refreshSocialFeed(); renderFeed(); }
    catch (error) { safeToast(featureError(error)); }
  };

  // CHALLENGES --------------------------------------------------------------
  window.todayChallengeKey = function todayChallengeKey() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  };
  window.ensureChallengeState = function ensureChallengeState() {
    if (!Array.isArray(state.challengeSubmissions)) state.challengeSubmissions = [];
    if (!Array.isArray(state.challengeLogs)) state.challengeLogs = [];
  };
  const legacyRenderChallengesPage = window.renderChallengesPage;
  if (typeof legacyRenderChallengesPage === 'function') {
    window.renderChallengesPage = function renderChallengesPageWithServerCount() {
      legacyRenderChallengesPage();
      const status = document.getElementById('ayatChallengeStatus');
      if (status && me()) {
        const count = Number(state.challengeTodaySubmissionCount) || 0;
        status.textContent = count ? `✅ مشاركاتك اليوم: ${count} — يمكنك الإرسال مرة أخرى.` : 'لم ترسل مشاركة اليوم بعد.';
      }
      const balance = document.getElementById('challengeTicketBalance');
      if (balance) balance.textContent = String(Number(state.challengeTickets) || 0);
    };
  }
  window.todayAyatSubmission = function todayAyatSubmission(user) {
    if (!user || user.id !== me()?.id) return (state.challengeSubmissions || []).find(item => item.userId === user?.id && item.dateKey === todayChallengeKey());
    return state.challengeTodaySubmitted || (state.challengeSubmissions || []).find(item => item.userId === user.id && item.dateKey === todayChallengeKey());
  };

  window.ensureWeeklyChallenge = function ensureWeeklyChallenge() { return state.weeklyChallenge; };
  window.renderWeeklyChallenge = function renderWeeklyChallenge() {
    const box = document.getElementById('weeklyChallengeBox'), user = me(), weekly = state.weeklyChallenge;
    if (!box || !user || !weekly?.options?.length) { if (box) box.innerHTML = '<div class="empty">لا يوجد تحدٍ متاح حاليًا</div>'; return; }
    if (weekly.answered) {
      box.innerHTML = `<div class="weekly-done">${weekly.correct ? '✅ أجبت بشكل صحيح هذا الأسبوع، بارك الله فيك!' : '↩️ لقد أجبت على تحدي هذا الأسبوع بالفعل'}</div><div class="quiz-explain">${escapeHtml(weekly.explanation || '')}</div>`;
      return;
    }
    box.innerHTML = `<div class="quiz-q" style="text-align:start;">${escapeHtml(weekly.question || '')}</div><div class="quiz-options" id="weeklyOptionsBox">${weekly.options.map((option, index) => `<button class="quiz-opt" onclick="answerWeekly(${index})">${escapeHtml(option)}</button>`).join('')}</div><div id="weeklyExplainBox"></div>`;
  };

  window.answerWeekly = async function answerWeekly(choiceIndex) {
    if (!me() || !Number.isInteger(Number(choiceIndex))) return;
    try {
      const result = await call('student-challenges', { op: 'weekly_answer', choiceIndex: Number(choiceIndex) });
      await loadState(); await refreshChallengeData(); renderWeeklyChallenge(); renderChallengesPage();
      if (result.correct) safeToast(`إجابة صحيحة! حصلت على ${Number(result.points || 0)} نقاط`);
      else if (result.alreadyAnswered) safeToast('لقد أجبت على تحدي هذا الأسبوع بالفعل');
      else safeToast('تم تسجيل إجابتك');
      if (currentPage === 'points') renderRanking();
    } catch (error) { safeToast(featureError(error)); }
  };

  window.submitAyatChallenge = async function submitAyatChallenge() {
    const input = document.getElementById('ayatChallengeText'), text = (input?.value || '').trim();
    if (!me() || !text) { safeToast('اكتب الآية أولًا'); return; }
    try {
      const result = await call('student-challenges', { op: 'ayat_submit', text: text.slice(0, 500) });
      await loadState(); await refreshChallengeData(); input.value = ''; renderChallengesPage();
      safeToast(result.ticketAwarded ? 'تم تسجيل المشاركة ومنحك تذكرة 🎟️' : 'تم تسجيل المشاركة؛ تُمنح تذكرة واحدة فقط في اليوم.');
      await logDiwan('تحديات', '📖', me().name + (result.ticketAwarded ? ' شارك في يوم الآيات وحصل على تذكرة' : ' أضاف مشاركة في يوم الآيات'));
    } catch (error) { safeToast(featureError(error)); }
  };

  window.awardAyatWinner = async function awardAyatWinner() {
    if (!isLeader(me())) { safeToast('هذه العملية لقائد الأسبوع فقط'); return; }
    try {
      const result = await call('student-challenges', { op: 'ayat_award_winner' });
      await loadState(); await refreshChallengeData(); renderChallengesPage(); renderRanking();
      safeToast(`تم منح 25 نقطة للفائز: ${result.winnerName || 'الطالب الفائز'}`);
    } catch (error) { safeToast(featureError(error)); }
  };

  window.startGuessGame = async function startGuessGame() {
    if (!me()) return;
    try {
      const result = await call('student-challenges', { op: 'guess_start', gameId: randomId() });
      activeGuess = { gameId: result.gameId, kind: result.kind, icon: result.icon, prompt: result.prompt };
      const box = document.getElementById('guessGameBox');
      if (box) box.innerHTML = `<div class="card" style="background:var(--night-2);text-align:center;"><div style="font-size:64px;margin:8px 0;">${escapeHtml(activeGuess.icon || '🎯')}</div><div class="pill gold">${escapeHtml(activeGuess.kind || 'تحدي')}</div><p style="margin:12px 0;">${escapeHtml(activeGuess.prompt || 'ما الإجابة؟')}</p><input id="guessAnswer" type="text" maxlength="120" placeholder="اكتب تخمينك..." style="max-width:420px;margin:auto;display:block;"><button class="btn gold" style="margin-top:10px;" onclick="submitGuessAnswer()">إجابة</button></div>`;
    } catch (error) { safeToast(featureError(error)); }
  };

  window.submitGuessAnswer = async function submitGuessAnswer() {
    const answer = String(document.getElementById('guessAnswer')?.value || '').trim();
    if (!activeGuess || !me()) { safeToast('ابدأ لعبة التخمين أولًا'); return; }
    if (!answer) { safeToast('اكتب إجابتك'); return; }
    try {
      const result = await call('student-challenges', { op: 'guess_answer', gameId: activeGuess.gameId, answer });
      activeGuess = null; await loadState(); await refreshChallengeData(); renderChallengesPage();
      safeToast(result.correct ? `إجابة صحيحة! +${Number(result.points || 0)} نقطة` : 'ليست الإجابة الصحيحة هذه المرة');
      if (currentPage === 'points') renderRanking();
    } catch (error) { safeToast(featureError(error)); }
  };

  window.spinChallengeWheel = async function spinChallengeWheel() {
    if (fortuneWheelBusy || !me()) return;
    fortuneWheelBusy = true;
    try {
      const result = await call('student-challenges', { op: 'wheel_spin', gameId: randomId() });
      const wheel = document.getElementById('fortuneWheel');
      if (wheel) { wheel.classList.remove('spinning'); void wheel.offsetWidth; wheel.style.transform = 'rotate(' + (1440 + Math.floor(Math.random() * 1440)) + 'deg)'; wheel.classList.add('spinning'); }
      await new Promise(resolve => setTimeout(resolve, 3000));
      const data = result || {}, message = data.type === 'points' ? `مبروك! ${data.label || (data.amount + ' نقطة')} 🎉` : data.type === 'ticket' ? `مبروك! ${data.label || 'تذكرة إضافية'} 🎟️` : data.type === 'retry' ? 'أعد المحاولة في دورة أخرى 🔁' : 'لم تحصل على جائزة هذه المرة 🫥';
      await loadState(); await refreshChallengeData(); renderChallengesPage();
      const output = document.getElementById('wheelResult'); if (output) output.textContent = `${data.icon || '🎟️'} ${message}`;
      safeToast(message); if (currentPage === 'points') renderRanking();
    } catch (error) { safeToast(featureError(error)); }
    finally { fortuneWheelBusy = false; }
  };

  // No feature action is allowed to fall back to old shared-document mutations.
  window.addChallengeLog = function addChallengeLog() { console.warn('Challenge logs are server-generated; direct client writes are disabled.'); };
  window.grantChallengeTicket = async function grantChallengeTicket() { throw new Error('challenge_rewards_server_authoritative'); };
  window.spendChallengeTicket = async function spendChallengeTicket() { throw new Error('challenge_rewards_server_authoritative'); };

  // Refresh the gateway-backed panels on navigation without creating a polling storm.
  const refreshAt = Object.create(null);
  const throttleRefresh = (key, fn, rerender, ms = 15000) => {
    const now = Date.now();
    if (now - (refreshAt[key] || 0) < ms) return;
    refreshAt[key] = now;
    void fn().then(ok => { if (ok && typeof rerender === 'function') rerender(); });
  };
  const originalShowPage = window.showPage;
  if (typeof originalShowPage === 'function') {
    window.showPage = function showPageWithFeatureRefresh(page, ...args) {
      const result = originalShowPage.call(this, page, ...args);
      if (page === 'exams') throttleRefresh('exams', refreshExamData, renderExamsPage);
      if (page === 'vacations') throttleRefresh('leaves', refreshLeaveData, renderVacationsPage);
      if (page === 'challenges') throttleRefresh('challenges', refreshChallengeData, renderChallengesPage);
      if (page === 'feed') throttleRefresh('social', refreshSocialFeed, renderFeed);
      return result;
    };
  }
})();
