import { db, uid, exportAll, importAll } from './db.js';
import { schedule, newSrs, isDue, mastery, weakness, daysUntil } from './srs.js';
import * as AI from './ai.js';
import { esc, md, renderMath, resizeImage, blobToBase64, blobURL, toast, todayKey, shuffle, copyText } from './util.js';
import { WRITING_TASKS, WRITING_RULES, countWords } from './eiken.js';
import { ELEMENTS, PT_CATS, PT_TARGETS } from './chem.js';

// ====================================================================
// constants
// ====================================================================

// 英検準1級 一次試験の4つのパート ＋ 共通テスト 化学基礎
export const SUBJECTS = [
  { id: 'vocab', name: '語彙・熟語', book: '単熟語EX', color: '#4f7cff', icon: '🔤', modes: ['cards', 'problem', 'lesson'], exam: 'eiken' },
  { id: 'read', name: '長文読解', book: '過去問', color: '#16b26b', icon: '📰', modes: ['problem', 'lesson', 'cards'], exam: 'eiken' },
  { id: 'write', name: '英作文', book: '過去問', color: '#e24a6b', icon: '✍️', modes: ['cards', 'lesson'], exam: 'eiken' },
  { id: 'listen', name: 'リスニング', book: '過去問', color: '#ff8a3d', icon: '🎧', modes: ['problem', 'cards'], exam: 'eiken' },
  // id は旧バージョンの「化学」(chem) と別にして、昔のデータが混ざらないようにする
  { id: 'chemb', name: '化学基礎', book: '教科書・プリント', color: '#9b5de5', icon: '⚗️', modes: ['cards', 'problem', 'lesson'], exam: 'kyotsu' },
];
const SUBJ = Object.fromEntries(SUBJECTS.map(s => [s.id, s]));
const EXAMS = {
  eiken: { name: '英検準1級 一次試験', short: '英検' },
  kyotsu: { name: '共通テスト', short: '共通テスト' },
};
const examSubjects = ex => SUBJECTS.filter(s => s.exam === ex);
const REASONS_BY_EXAM = {
  eiken: ['不认识单词', '没读懂句子', '找不到根据', '被选项骗了', '听不清', '时间不够'],
  kyotsu: ['知识没记住', '概念没理解', '计算错误', '看错题目', '被选项骗了', '时间不够'],
};
const REASONS = [...new Set(Object.values(REASONS_BY_EXAM).flat())];
const reasonsFor = sid => REASONS_BY_EXAM[SUBJ[sid]?.exam] || REASONS;
const DAY = 86400000;

// ====================================================================
// state
// ====================================================================

const S = {
  cards: [],
  problems: [],
  sources: [],
  feynman: [],
  essays: [],
  sheets: [],
  settings: null,
  stats: null,
};
const imgCache = new Map();

let draft = null;       // 拍照导入 in progress
let session = null;     // active review session
let lib = { subject: 'all', tab: 'problems', q: '' };
let timerHandle = null;
let busy = false;

// 2026年度 第3回 英検 一次試験（本会場）。出願前に公式サイトで確認すること。
const EXAM_DAY = '2027-01-24';
// 令和10年度 共通テスト（2028年1月）。日程は未発表なので例年どおり1月中旬の土日の2日目（理科）と仮定。
const KYOTSU_DAY = '2028-01-16';
const EXAM_PRESET = Object.fromEntries(SUBJECTS.map(s => [s.id, s.exam === 'kyotsu' ? KYOTSU_DAY : EXAM_DAY]));
// the preset stays the default until the exam day has passed
const presetActive = sid => daysUntil(EXAM_PRESET[sid]) >= 0;

function defaultSettings() {
  const later = todayKey(Date.now() + 22 * DAY);
  return {
    apiKey: '',
    model: AI.MODELS[0].id,
    lang: 'zh',
    dailyGoal: 60,
    autoSpeak: false,
    exams: Object.fromEntries(SUBJECTS.map(s => [s.id, presetActive(s.id) ? EXAM_PRESET[s.id] : later])),
    eikenV1: true,
  };
}

async function load() {
  const [cards, problems, sources, feynman, essays, settings, stats] = await Promise.all([
    db.all('cards'), db.all('problems'), db.all('sources'), db.all('feynman'), db.all('essays'),
    db.getMeta('settings', null), db.getMeta('stats', null),
  ]);
  S.sheets = await db.all('sheets');
  // Data from the old school-subject version stays in the database but is not shown.
  const known = x => SUBJ[x.subject];
  S.cards = cards.filter(known);
  S.problems = problems.filter(known);
  S.sources = sources.filter(known);
  S.feynman = feynman.filter(known);
  S.essays = essays;
  S.settings = { ...defaultSettings(), ...(settings || {}) };
  S.settings.exams = { ...defaultSettings().exams, ...(settings?.exams || {}) };
  if (!settings) await db.setMeta('settings', S.settings);
  // Installs from the school version: switch to the 英検 exam date once.
  if (settings && !settings.eikenV1) {
    const fresh = defaultSettings().exams;
    examSubjects('eiken').forEach(s => { S.settings.exams[s.id] = fresh[s.id]; });
    S.settings.eikenV1 = true;
    await saveSettings();
    setTimeout(() => toast('已切换为英検準1級模式 📚', 3500), 600);
  }
  S.stats = stats || { xp: 0, streak: 0, lastDay: null, days: {} };
}

const saveSettings = () => db.setMeta('settings', S.settings);
const saveStats = () => db.setMeta('stats', S.stats);

async function putCard(c) { await db.put('cards', c); upsert(S.cards, c); }
async function putProblem(p) { await db.put('problems', p); upsert(S.problems, p); }
async function putSource(s) { await db.put('sources', s); upsert(S.sources, s); }
async function putEssay(e) { await db.put('essays', e); upsert(S.essays, e); }
function upsert(arr, obj) {
  const i = arr.findIndex(x => x.id === obj.id);
  if (i >= 0) arr[i] = obj; else arr.push(obj);
}

async function saveImages(blobs) {
  const rows = blobs.map(blob => ({ id: uid(), blob }));
  await db.putMany('images', rows);
  rows.forEach(r => imgCache.set(r.id, r.blob));
  return rows.map(r => r.id);
}
async function getImage(id) {
  if (imgCache.has(id)) return imgCache.get(id);
  const row = await db.get('images', id);
  if (row) imgCache.set(id, row.blob);
  return row?.blob;
}
async function imgsHTML(ids, cls = 'thumbs') {
  if (!ids?.length) return '';
  const parts = await Promise.all(ids.map(async id => {
    const b = await getImage(id);
    return b ? `<img src="${blobURL(id, b)}" data-act="zoom" data-id="${id}" alt="">` : '';
  }));
  return `<div class="${cls}">${parts.join('')}</div>`;
}
async function imagesB64(ids) {
  const out = [];
  for (const id of ids || []) {
    const b = await getImage(id);
    if (b) out.push(await blobToBase64(b));
  }
  return out;
}

// ====================================================================
// stats / game
// ====================================================================

function levelInfo(xp) {
  const level = Math.floor(Math.sqrt(xp / 40)) + 1;
  const cur = 40 * (level - 1) ** 2;
  const next = 40 * level ** 2;
  return { level, pct: (xp - cur) / (next - cur), toNext: next - xp };
}
const TITLES = ['见习生', '勤学者', '刷题人', '解法猎人', '公式术士', '考场骑士', '满分魔导师', '传说学霸'];

function addXP(n, { review = false, correct = false, problem = false } = {}) {
  const st = S.stats;
  const t = todayKey();
  const y = todayKey(Date.now() - DAY);
  if (st.lastDay !== t) {
    st.streak = st.lastDay === y ? st.streak + 1 : 1;
    st.lastDay = t;
  }
  const d = st.days[t] || (st.days[t] = { reviews: 0, correct: 0, xp: 0, problems: 0 });
  d.xp += n;
  if (review) d.reviews += 1;
  if (correct) d.correct += 1;
  if (problem) d.problems += 1;
  st.xp += n;
  saveStats();
}

function today() {
  return S.stats.days[todayKey()] || { reviews: 0, correct: 0, xp: 0, problems: 0 };
}

function streakNow() {
  const st = S.stats;
  if (st.lastDay === todayKey() || st.lastDay === todayKey(Date.now() - DAY)) return st.streak;
  return 0;
}

// ====================================================================
// planning
// ====================================================================

const daysTo = sid => daysUntil(S.settings.exams[sid]);

function nearestExam(ex = null) {
  let best = null;
  for (const s of SUBJECTS) {
    if (ex && s.exam !== ex) continue;
    const d = daysTo(s.id);
    if (d != null && d >= 0 && (best == null || d < best)) best = d;
  }
  return best;
}

// The exam that is coming up first (its phase is shown on the home screen).
function nearestExamKey() {
  let best = null;
  for (const ex of Object.keys(EXAMS)) {
    const d = nearestExam(ex);
    if (d != null && (best == null || d < best.d)) best = { ex, d };
  }
  return best?.ex || 'eiken';
}

function phase(d, ex = 'eiken') {
  if (ex === 'kyotsu') return kyotsuPhase(d);
  if (d == null) return { name: '设置考试日期', tip: '到 设置 里填写考试日期。' };
  if (d > 45) return { name: '第1阶段：词汇打底', tip: '每天把单词卡清零；単熟語EX里不会的词做上记号拍进来。每周写 1 篇作文。' };
  if (d > 14) return { name: '第2阶段：过去问＋写作', tip: '每周做 1 回过去问，错题拍进来分析；每周写 2 篇作文并批改。单词卡继续每天清零。' };
  if (d > 3) return { name: '第3阶段：冲刺', tip: '用“考前冲刺”刷弱项单词；按考试时间做过去问；作文每天 1 篇，把范文里的表达背下来。' };
  if (d > 0) return { name: '最后调整', tip: '不再加新词，只复习弱项；看一遍自己作文里的常见错误。早点睡！' };
  if (d === 0) return { name: '考试当天', tip: '早上用冲刺模式过一遍弱项单词，然后相信自己！' };
  return { name: '考试结束', tip: '辛苦了！可以在设置里改成二次考试（面接）或下次考试的日期。' };
}

function kyotsuPhase(d) {
  if (d == null) return { name: '设置考试日期', tip: '到 设置 里填写共通テスト的日期。' };
  if (d > 300) return { name: '第0阶段：跟着学校打基础', tip: '每天把化学基礎闪卡清零（新卡每天约 15 张）。学校学到哪个单元，就把讲义拍进来做卡。' };
  if (d > 150) return { name: '第1阶段：全范围过一遍', tip: '所有单元的卡都在复习中；用周期表练习把 1–20 号元素背熟；计算题（物质量・中和・氧化还原）错题拍进来。' };
  if (d > 60) return { name: '第2阶段：共通テスト过去问', tip: '每周做 1 回化学基礎过去问（30 分钟），错题拍进来分析；闪卡继续每天清零。' };
  if (d > 14) return { name: '第3阶段：实战演练', tip: '按考试时间做过去问和模拟题；用“考前冲刺”刷弱项；化学基礎和另一门基礎科目一共 60 分钟，练好时间分配。' };
  if (d > 3) return { name: '第4阶段：冲刺', tip: '不再加新卡，只刷弱项和错题；重看炎色反应、指示薬、半反应式这些容易混的点。' };
  if (d > 0) return { name: '最后调整', tip: '只复习弱项，早点睡！' };
  if (d === 0) return { name: '考试当天', tip: '早上用冲刺模式过一遍弱项，然后相信自己！' };
  return { name: '考试结束', tip: '辛苦了！可以在设置里改成下次考试的日期。' };
}

function newQuota(sid) {
  const fresh = S.cards.filter(c => c.subject === sid && c.srs?.isNew !== false).length;
  if (!fresh) return 0;
  const d = daysTo(sid);
  const daysLeft = d == null ? 14 : Math.max(1, d - 3);
  const learnedToday = S.cards.filter(c => c.subject === sid && c.srs?.firstSeen === todayKey()).length;
  const quota = Math.max(15, Math.ceil((fresh + learnedToday) / daysLeft));
  return Math.max(0, Math.min(fresh, quota - learnedToday));
}

function todayPlan(sid = null) {
  const now = Date.now();
  const subs = sid ? [sid] : SUBJECTS.map(s => s.id);
  let dueCards = [], newCards = [], dueProblems = [];
  for (const s of subs) {
    const cs = S.cards.filter(c => c.subject === s);
    dueCards.push(...cs.filter(c => isDue(c.srs, now)));
    const fresh = cs.filter(c => !c.srs || c.srs.isNew)
      .sort((a, b) => (b.importance || 2) - (a.importance || 2) || a.created - b.created);
    newCards.push(...fresh.slice(0, newQuota(s)));
    dueProblems.push(...S.problems.filter(p => p.subject === s && (!p.srs || p.srs.isNew || isDue(p.srs, now))));
  }
  return { dueCards, newCards, dueProblems };
}

// ====================================================================
// rendering helpers
// ====================================================================

const $view = () => document.getElementById('view');

function subjChip(sid, active, act = 'pickSubject') {
  const s = SUBJ[sid];
  return `<button class="chip ${active ? 'on' : ''}" style="--c:${s.color}" data-act="${act}" data-sid="${sid}">${s.icon} ${s.name}</button>`;
}

function setView(html) {
  clearInterval(timerHandle);
  const v = $view();
  v.innerHTML = html;
  renderMath(v);
  window.scrollTo(0, 0);
}

function header() {
  const lv = levelInfo(S.stats.xp);
  const el = document.getElementById('hud');
  el.innerHTML = `
    <div class="hud-l"><span class="lv">Lv.${lv.level}</span>
      <div class="xpbar"><i style="width:${Math.round(lv.pct * 100)}%"></i></div></div>
    ${session && document.body.dataset.view !== 'session' ? '<button class="resume" data-act="nav" data-to="session">↩ 继续复习</button>' : ''}
    <div class="hud-r"><span title="连续学习天数">🔥 ${streakNow()}</span><span title="经验值">⭐ ${S.stats.xp}</span></div>`;
}

function tabs(active) {
  document.querySelectorAll('#tabbar a').forEach(a => a.classList.toggle('on', a.dataset.tab === active));
}

// ====================================================================
// router
// ====================================================================

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, arg] = hash.split('/');
  if (name === 'sheets' && document.body.dataset.view !== 'sheets') {
    // coming from another screen: start on today's list
    sheetsUI.tab = 'today';
    sheetsUI.undo = null;
  }
  document.body.dataset.view = name;
  header();
  const map = { home: viewHome, add: viewAdd, review: viewReview, session: viewSession, lib: viewLib,
    problem: viewProblem, tutor: viewTutor, source: viewSource, settings: viewSettings,
    feynman: viewFeynmanList, fey: viewFey, packs: viewPacks, writing: viewWriting, essay: viewEssay, essayr: viewEssayResult,
    sheets: viewSheets, ptable: viewPtable };
  tabs({ problem: 'lib', tutor: 'lib', source: 'lib', session: 'review', feynman: 'review', fey: 'review', packs: 'add',
    writing: 'review', essay: 'review', essayr: 'review', ptable: 'review' }[name] || name);
  await (map[name] || viewHome)(arg);
}

function go(h) {
  if (location.hash === '#/' + h) route(); else location.hash = '#/' + h;
}

// ====================================================================
// HOME
// ====================================================================

async function viewHome() {
  const heroEx = nearestExamKey();
  const d = nearestExam(heroEx);
  const ph = phase(d, heroEx);
  const plan = todayPlan();
  const t = today();
  const goal = S.settings.dailyGoal;
  const pct = Math.min(1, t.reviews / goal);
  const total = plan.dueCards.length + plan.newCards.length + plan.dueProblems.length;
  const lv = levelInfo(S.stats.xp);
  const empty = !S.cards.length && !S.problems.length;

  const reasons = {};
  S.problems.forEach(p => (p.reason || []).forEach(r => { reasons[r] = (reasons[r] || 0) + 1; }));
  const reasonMax = Math.max(1, ...Object.values(reasons));

  const upcoming = SUBJECTS.map(s => ({ s, d: daysTo(s.id) })).filter(x => x.d != null && x.d >= 0).sort((a, b) => a.d - b.d);
  // "英検準1級 一次試験" when every part of that exam is on the list, otherwise the part names
  const groupLabel = xs => Object.keys(EXAMS).map(ex => {
    const mine = xs.filter(x => x.s.exam === ex);
    if (!mine.length) return '';
    return mine.length === examSubjects(ex).length ? EXAMS[ex].name : mine.map(x => x.s.name).join('、');
  }).filter(Boolean).join('、');
  const examLine = ex => {
    const xs = upcoming.filter(x => x.s.exam === ex && x.d > 0);
    if (!xs.length) return '';
    const sameDay = new Set(examSubjects(ex).map(s => S.settings.exams[s.id])).size === 1;
    const n = xs[0];
    const date = S.settings.exams[n.s.id].split('-').map(Number);
    const label = sameDay ? EXAMS[ex].name : `${EXAMS[ex].short}・${n.s.name}`;
    return `${label} · ${ex === heroEx ? '' : `${date[0]}/`}${date[1]}/${date[2]}${ex === heroEx ? '' : ` · 还有 <b>${n.d}</b> 天`}`;
  };
  const bannerTip = (xs, when) => xs.every(x => x.s.exam === 'kyotsu')
    ? (when === 'today' ? '考前用 10 分钟刷一下弱项就好，相信自己！' : '今晚只复习弱项和错题，然后早点睡。')
    : (when === 'today' ? '考前用 10 分钟刷一下弱项就好，相信自己！' : '今晚只复习弱项单词和自己作文里的常见错误，然后早点睡。');
  const weekEssays = S.essays.filter(e => e.result && e.gradedAt > Date.now() - 7 * DAY).length;
  const sheetsDue = S.sheets.filter(x => !x.archived && !x.done && x.due <= todayKey());
  const sheetsLate = sheetsDue.filter(x => x.due < todayKey()).length;
  const todayExams = upcoming.filter(x => x.d === 0);
  const tomorrowExams = upcoming.filter(x => x.d === 1);
  const next = upcoming.find(x => x.d > 0);

  setView(`
  ${todayExams.length ? `<section class="card exam-banner today-exam">📝 <b>今天考：${groupLabel(todayExams)}</b><br><span class="small">${bannerTip(todayExams, 'today')}</span>
    <div class="row wrap">${todayExams.map(x => `<button class="btn small" data-act="startMode" data-mode="cram" data-sid="${x.s.id}">🔥 ${x.s.name} 弱项</button>`).join('')}</div></section>` : ''}
  ${tomorrowExams.length ? `<section class="card exam-banner">⏰ <b>明天考：${groupLabel(tomorrowExams)}</b><br><span class="small">${bannerTip(tomorrowExams, 'tomorrow')}</span>
    <div class="row wrap">${tomorrowExams.map(x => `<button class="btn primary small" data-act="startMode" data-mode="cram" data-sid="${x.s.id}">🔥 ${x.s.name} 冲刺</button>`).join('')}</div></section>` : ''}
  <section class="hero">
    <div class="hero-days"><b>${d == null ? '?' : Math.max(0, d)}</b><span>天后考试</span></div>
    <div class="hero-txt">
      <div class="phase">${esc(ph.name)}</div>
      ${next ? `<div class="small next-exam">${examLine(heroEx)}</div>` : ''}
      ${Object.keys(EXAMS).filter(ex => ex !== heroEx).map(examLine).filter(Boolean).map(l => `<div class="small next-exam other-exam">${l}</div>`).join('')}
      <div class="muted small">${esc(ph.tip)}</div>
      <div class="muted small">称号：${TITLES[Math.min(TITLES.length - 1, lv.level - 1)]} · 再 ${lv.toNext} XP 升级</div>
    </div>
  </section>

  ${empty ? `
  <section class="card onboarding">
    <h3>👋 英検準1級 3步开始</h3>
    <ol>
      <li><b>单词</b>：拍照 → 📦 导入卡包，先导入准1级高频词；単熟語EX里不会的词做上记号拍进来。</li>
      <li><b>写作</b>：复习 → ✍️ 英作文，每周写 1–2 篇并批改。</li>
      <li><b>每天</b>：点“开始今日任务”，把数字清零就赢了。</li>
    </ol>
    <div class="row"><button class="btn" data-act="nav" data-to="settings">去设置</button><button class="btn primary" data-act="nav" data-to="packs">📦 导入单词</button></div>
  </section>` : ''}

  <button class="big-btn sheet-entry ${sheetsDue.length ? 'has-due' : ''}" data-act="nav" data-to="sheets">${S.sheets.length
    ? `<b>📝 纸上问题：今天 ${sheetsDue.length} 张${sheetsLate ? `（逾期 ${sheetsLate}）` : ''}</b><span>${sheetsDue.length ? '做完在 App 里点 ○ △ ×' : '今天的都做完了 🎉'}</span>`
    : '<b>📝 纸上问题</b><span>自己出在纸上的题，也能按遗忘曲线提醒你哪天做</span>'}</button>

  <section class="card today">
    <div class="ring" style="--p:${pct}"><div><b>${t.reviews}</b><small>/${goal}</small></div></div>
    <div class="today-body">
      <h3>今日任务</h3>
      <div class="kv"><span>🔁 待复习闪卡</span><b>${plan.dueCards.length}</b></div>
      <div class="kv"><span>🆕 今日新卡</span><b>${plan.newCards.length}</b></div>
      <div class="kv"><span>✏️ 错题重做</span><b>${plan.dueProblems.length}</b></div>
      <button class="btn primary block" data-act="startToday" ${total ? '' : 'disabled'}>${total ? `▶ 开始今日任务（${total}）` : '🎉 今天的任务清零了'}</button>
    </div>
  </section>

  <button class="big-btn write-entry" data-act="nav" data-to="writing"><b>✍️ 英作文</b><span>最近 7 天批改了 ${weekEssays} 篇 · 目标每周 2 篇</span></button>

  <h3 class="sec">科目</h3>
  <section class="subjects">
    ${SUBJECTS.map(s => {
      const cs = S.cards.filter(c => c.subject === s.id);
      const ps = S.problems.filter(p => p.subject === s.id);
      const all = [...cs.map(c => c.srs), ...ps.map(p => p.srs)];
      const m = all.length ? Math.round(all.reduce((a, x) => a + mastery(x), 0) / all.length * 100) : 0;
      const sp = todayPlan(s.id);
      const due = sp.dueCards.length + sp.newCards.length + sp.dueProblems.length;
      const dd = daysTo(s.id);
      return `<button class="subj" style="--c:${s.color}" data-act="subjectMenu" data-sid="${s.id}">
        <div class="subj-top"><span class="subj-ic">${s.icon}</span><span class="subj-d">${dd == null ? '' : dd >= 0 ? `${dd}天` : '已考'}</span></div>
        <div class="subj-name">${s.name}</div>
        <div class="subj-meta">卡 ${cs.length} · 题 ${ps.length}${due ? ` · <b>待${due}</b>` : ''}</div>
        <div class="bar"><i style="width:${m}%"></i></div>
      </button>`;
    }).join('')}
  </section>

  ${Object.keys(reasons).length ? `
  <h3 class="sec">错因分析</h3>
  <section class="card">
    ${REASONS.filter(r => reasons[r]).map(r => `<div class="hbar"><span>${r}</span><div><i style="width:${reasons[r] / reasonMax * 100}%"></i></div><b>${reasons[r]}</b></div>`).join('')}
    <div class="muted small">${reasonTip(reasons)}</div>
  </section>` : ''}

  ${weekChart()}
  `);
}

function reasonTip(r) {
  const top = Object.entries(r).sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    '不认识单词': '“不认识单词”最多 → 把这些题里的生词全部做成单词卡（拍照 → 🔤 单词）。',
    '没读懂句子': '“没读懂句子”最多 → 用 📖 补课把看不懂的长句拆开讲，重点练从句和分词构文。',
    '找不到根据': '“找不到根据”最多 → 先读设问再读文章，在文章里画出根据句再选答案。',
    '被选项骗了': '“被选项骗了”最多 → 正确选项通常是本文的换说；和原文用词一模一样的选项要小心。',
    '听不清': '“听不清”最多 → 用过去问的音频跟读（shadowing），对照スクリプト找出没听出来的地方。',
    '时间不够': '“时间不够”最多 → 词汇题每题控制在 30 秒内；写作先列提纲再写，按考试时间练。化学基礎每大题按分配时间做。',
    '知识没记住': '“知识没记住”最多 → 把这些题考到的知识做成闪卡（拍照 → 资料），每天清零。',
    '概念没理解': '“概念没理解”最多 → 用 📖 补课把这个单元从头讲一遍，再用 🗣 费曼模式讲给小明听。',
    '计算错误': '“计算错误”最多 → 先写出“求什么 mol”再列式；单位（g・mol・L・mL）每步都写上；有效数字最后再处理。',
    '看错题目': '“看错题目”最多 → 把“正しいもの／誤っているもの”“すべて選べ”圈出来再作答。',
  }[top] || '';
}

function weekChart() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const k = todayKey(Date.now() - i * DAY);
    days.push({ k, d: S.stats.days[k] || { reviews: 0 } });
  }
  const max = Math.max(10, ...days.map(x => x.d.reviews));
  return `<h3 class="sec">最近 7 天</h3><section class="card week">
    ${days.map(x => `<div class="wk"><div class="wk-bar"><i style="height:${x.d.reviews / max * 100}%"></i></div><small>${x.k.slice(8)}</small><small class="muted">${x.d.reviews}</small></div>`).join('')}
  </section>`;
}

// ====================================================================
// ADD (photo import)
// ====================================================================

function newDraft(sid = 'vocab') {
  return { subject: sid, mode: SUBJ[sid].modes[0], sourceKind: 'print', photos: [], solPhotos: [], note: '', ref: '', reason: [], preview: null };
}

async function viewAdd() {
  if (!draft) draft = newDraft();
  const s = SUBJ[draft.subject];
  if (draft.preview) return viewPreview();
  const photoList = (arr, key) => arr.map((p, i) => `<div class="ph"><img src="${p.url}"><button data-act="rmPhoto" data-key="${key}" data-i="${i}">×</button></div>`).join('');
  const isP = draft.mode === 'problem';
  const isL = draft.mode === 'lesson';
  const isW = draft.mode === 'cards' && draft.subject === 'vocab';
  const isC = s.exam === 'kyotsu';
  setView(`
  <h2>📷 拍照导入</h2>
  <button class="big-btn pack-entry" data-act="nav" data-to="packs"><b>📦 导入卡包</b><span>Claude 在聊天里帮你做好的闪卡・错题解法・补课（不花 API 费用）</span></button>
  <div class="chips">${SUBJECTS.map(x => subjChip(x.id, x.id === draft.subject)).join('')}</div>

  <div class="seg seg3">
    <button class="${draft.mode === 'cards' ? 'on' : ''}" data-act="setMode" data-mode="cards">${draft.subject === 'vocab' ? '🔤 单词<br><small>→单词卡</small>' : '📄 资料<br><small>→闪卡</small>'}</button>
    <button class="${isP ? 'on' : ''}" data-act="setMode" data-mode="problem">✏️ 错题<br><small>→解析</small></button>
    <button class="${isL ? 'on' : ''}" data-act="setMode" data-mode="lesson">📖 补课<br><small>看不懂的</small></button>
  </div>

  ${isL ? `
  <div class="card">
    <b>看不懂？</b>把看不懂的${isC ? '<b>教科书・讲义・过去问的解说</b>（概念、反应、计算方法）' : '<b>语法、长难句、过去问的长文或解说、写作范文</b>'}拍进来，AI 会像一对一补课一样从零讲起，一节一节讲到你懂，最后自动做成闪卡。
    <div class="muted small">💡 一次拍一个主题（2–4 张）效果最好。</div>
  </div>` : isW ? `
  <div class="card">
    <b>把不会的词做成单词卡</b>：在単熟語EX（或过去问）上把<b>不会的词打勾或划线</b>，再拍下这一页。AI 只做有记号的词，并附上大問1 形式的 4 选 1 练习。
    <div class="muted small">💡 例句和解释由 AI 原创，不会照抄书上的内容。一次 1–2 页最好。</div>
  </div>` : !isP ? `
  <div class="card">
    ${isC ? '<b>资料 → 闪卡</b>：教科书、学校讲义、图录、笔记……AI 会挑出共通テスト要背的知识（物质的性质・颜色・反应式・定义・实验操作），能出选择题的卡还会附 4 选 1。'
      : '<b>资料 → 闪卡</b>：笔记、参考书、过去问的解说、写作范文……AI 会挑出值得背的单词、搭配和能直接套用的表达。'}
    ${draft.subject === 'write' ? '<button class="btn block" data-act="nav" data-to="writing" style="margin-top:8px">✍️ 去英作文练习（写作并批改）</button>' : ''}
  </div>` : `
  <div class="card">
    <label class="lbl">题号（可选）</label>
    <input data-bind="ref" placeholder="${isC ? '例：2026 共通テスト 化学基礎 第1問 問3' : '例：2025年度第1回 大問1 (5)'}" value="${esc(draft.ref)}">
    <label class="lbl">错因（可多选）</label>
    <div class="chips">${reasonsFor(draft.subject).map(r => `<button class="chip ${draft.reason.includes(r) ? 'on' : ''}" data-act="toggleReason" data-r="${r}">${r}</button>`).join('')}</div>
  </div>`}

  <div class="card">
    <div class="lbl">${isP ? '① 题目照片' : isL ? '看不懂的内容的照片' : isW ? '单词书页面的照片（不会的词做好记号）' : '资料照片'}</div>
    <div class="photos">${photoList(draft.photos, 'photos')}</div>
    <div class="row">
      <label class="btn"><input type="file" accept="image/*" capture="environment" data-file="photos" hidden>📷 拍照</label>
      <label class="btn"><input type="file" accept="image/*" multiple data-file="photos" hidden>🖼 相册</label>
    </div>
    ${isP ? `
    <div class="lbl" style="margin-top:14px">② 解答・解说页照片（推荐，AI 会按官方解答讲${draft.subject === 'listen' ? '；听力请拍スクリプト' : ''}）</div>
    <div class="photos">${photoList(draft.solPhotos, 'solPhotos')}</div>
    <div class="row">
      <label class="btn"><input type="file" accept="image/*" capture="environment" data-file="solPhotos" hidden>📷 拍照</label>
      <label class="btn"><input type="file" accept="image/*" multiple data-file="solPhotos" hidden>🖼 相册</label>
    </div>` : ''}
    <label class="lbl">${isP ? '卡在哪里？（可选）' : isL ? '哪里不懂？（可选，例：“这句话的结构看不懂”）' : isW ? '备注（可选，例：“只做打勾的词”）' : '备注（可选）'}</label>
    <textarea data-bind="note" rows="2">${esc(draft.note)}</textarea>
  </div>

  <div class="stack">
    <button class="btn primary block" data-act="runAI" ${draft.photos.length ? '' : 'disabled'}>🤖 AI ${isP ? '解析这道题' : isL ? '开始补课' : isW ? '做成单词卡' : '生成闪卡'}</button>
    <button class="btn block" data-act="manualAI" ${draft.photos.length ? '' : 'disabled'}>🆓 免费：复制提示词到 Claude/ChatGPT App</button>
    ${isP ? `<button class="btn ghost block" data-act="saveRawProblem" ${draft.photos.length ? '' : 'disabled'}>只保存照片（以后再解析）</button>`
          : isL ? '' : `<button class="btn ghost block" data-act="manualCard">✍️ 手动添加一张卡</button>`}
  </div>
  `);
}

async function addPhotos(key, files) {
  for (const f of files) {
    try {
      const blob = await resizeImage(f);
      draft[key].push({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      toast('有一张图片读取失败');
    }
  }
  viewAdd();
}

function aiOverlay(msg) {
  const el = document.getElementById('overlay');
  const t0 = Date.now();
  el.innerHTML = `<div class="spinner"></div><div>${esc(msg)}</div><div class="muted small" id="ov-t">0 秒</div><div class="muted small">照片越多越慢，一般 20–90 秒</div>`;
  el.classList.add('show');
  const h = setInterval(() => {
    const t = document.getElementById('ov-t');
    if (t) t.textContent = Math.round((Date.now() - t0) / 1000) + ' 秒';
  }, 1000);
  return () => { clearInterval(h); el.classList.remove('show'); };
}

const cardsSchema = () => ({ vocab: 'words', chemb: 'chemcards' }[draft.subject] || 'cards');

function draftPrompt() {
  const subject = SUBJ[draft.subject];
  if (draft.mode === 'problem') {
    return AI.problemPrompt({ subject, ref: draft.ref, note: draft.note, reason: draft.reason.join('、'),
      hasSolution: draft.solPhotos.length > 0, settings: S.settings });
  }
  if (draft.mode === 'lesson') return AI.lessonPrompt({ subject, note: draft.note, settings: S.settings });
  if (draft.subject === 'vocab') return AI.wordsPrompt({ note: draft.note, settings: S.settings });
  return AI.cardsPrompt({ subject, sourceKind: draft.sourceKind, note: draft.note, settings: S.settings });
}

async function runAI() {
  if (busy) return;
  busy = true;
  const done = aiOverlay({ problem: 'AI 正在分析这道题…', lesson: '老师正在备课…（补课内容比较多，可能要 1–2 分钟）' }[draft.mode]
    || (draft.subject === 'vocab' ? 'AI 正在做单词卡和 4 选 1 练习…' : 'AI 正在找重点、做闪卡…'));
  try {
    const imgs = [];
    for (const p of draft.photos) imgs.push(await blobToBase64(p.blob));
    const sol = [];
    for (const p of draft.solPhotos) sol.push(await blobToBase64(p.blob));
    const prompt = draftPrompt();
    let result;
    if (draft.mode === 'problem') {
      if (sol.length) prompt.user = `（共 ${imgs.length} 张题目图片，之后 ${sol.length} 张是【解答】图片）\n` + prompt.user;
      result = await AI.generateJSON(S.settings, prompt, [...imgs, ...sol], 'problem', 'high');
    } else if (draft.mode === 'lesson') {
      const lesson = await AI.generateJSON(S.settings, prompt, imgs, 'lesson', lessonEffort(draft.subject), 20000);
      await saveLesson(lesson);
      return;
    } else {
      const schema = cardsSchema();
      result = await AI.generateJSON(S.settings, prompt, imgs, schema, 'medium', schema === 'words' ? 20000 : 16000);
    }
    draft.preview = result;
    go('add');
  } catch (e) {
    alertBox('出错了', e.message || String(e));
  } finally {
    done();
    busy = false;
  }
}

function manualAI() {
  const schema = { problem: 'problem', lesson: 'lesson' }[draft.mode] || cardsSchema();
  const prompt = draftPrompt();
  if (draft.mode === 'problem' && draft.solPhotos.length) {
    prompt.user = `（前 ${draft.photos.length} 张是题目图片，后 ${draft.solPhotos.length} 张是【解答】图片）\n` + prompt.user;
  }
  const text = AI.manualPrompt(prompt, schema);
  modalData.existingProblem = null;
  modal(`
    <h3>🆓 免费方式（用 Claude / ChatGPT App）</h3>
    <ol class="small">
      <li>点“复制提示词”。</li>
      <li>打开 Claude App（或 ChatGPT），新建对话，<b>添加刚才那 ${draft.photos.length + draft.solPhotos.length} 张照片</b>（相册里选），粘贴提示词发送。</li>
      <li>等 AI 回复完，长按复制它的<b>完整回复</b>，回到这里粘贴到下面，点“导入”。</li>
    </ol>
    <div class="muted small">提示：这种方式需要照片在相册里，建议先用系统相机拍，再在这里从“相册”选。</div>
    <button class="btn primary block" data-act="copyPrompt">📋 复制提示词</button>
    <textarea id="manual-json" rows="6" placeholder="把 AI 的回复粘贴到这里"></textarea>
    <button class="btn primary block" data-act="importManual" data-schema="${schema}">导入</button>
  `);
  modalData.prompt = text;
}

function viewPreview() {
  const r = draft.preview;
  const s = SUBJ[draft.subject];
  if (draft.mode === 'problem') {
    setView(`
      <h2>✅ 解析完成</h2>
      <div class="muted small">${s.name} · 先确认一下，有错可以保存后在详情页编辑</div>
      ${problemBody(r, true)}
      <div class="stack sticky-bottom">
        <button class="btn primary block" data-act="savePreview">💾 保存（会自动生成解法闪卡）</button>
        <button class="btn ghost block" data-act="discardPreview">放弃</button>
      </div>`);
    return;
  }
  if (r.words) {
    const words = r.words;
    setView(`
      <h2>✅ 做了 ${words.length} 个单词</h2>
      <div class="card"><b>${esc(r.title || '')}</b><div class="summary">${md(r.summary || '')}</div></div>
      <div class="muted small">点 × 删除已经会的词。</div>
      ${words.map((w, i) => `
        <div class="card pv ${w._del ? 'del' : ''}">
          <div class="pv-top"><b class="w-word sm">${esc(w.word)}</b><span class="w-pos">${esc(w.pos)}</span><span class="stars">${'★'.repeat(w.importance || 2)}</span>
            <button class="x" data-act="pvDel" data-i="${i}">${w._del ? '↺' : '×'}</button></div>
          <div class="pv-b">${esc(w.ja)}${w.zh ? ` ／ ${esc(w.zh)}` : ''}</div>
          <div class="small">${md(highlightWord(w.ex, w.form || w.word))}</div>
        </div>`).join('')}
      <div class="stack sticky-bottom">
        <button class="btn primary block" data-act="savePreview">💾 保存 ${words.filter(w => !w._del).length} 个单词</button>
        <button class="btn ghost block" data-act="discardPreview">放弃</button>
      </div>`);
    return;
  }
  const cards = r.cards || [];
  setView(`
    <h2>✅ 生成了 ${cards.length} 张卡</h2>
    <div class="card"><b>${esc(r.title || '')}</b><div class="summary">${md(r.summary || '')}</div></div>
    <div class="muted small">点 × 删除不需要的卡。保存后可在“题库”里编辑。</div>
    ${cards.map((c, i) => `
      <div class="card pv ${c._del ? 'del' : ''}">
        <div class="pv-top"><span class="tag">${c.type === 'cloze' ? '填空' : '问答'}${cardDistractors(c) ? '・4択' : ''}</span><span class="stars">${'★'.repeat(c.importance || 2)}</span>
          <button class="x" data-act="pvDel" data-i="${i}">${c._del ? '↺' : '×'}</button></div>
        <div class="pv-f">${md(c.front)}</div>
        <div class="pv-b">${md(c.back)}</div>
        ${c.note ? `<div class="note">${md(c.note)}</div>` : ''}
      </div>`).join('')}
    <div class="stack sticky-bottom">
      <button class="btn primary block" data-act="savePreview">💾 保存 ${cards.filter(c => !c._del).length} 张卡</button>
      <button class="btn ghost block" data-act="discardPreview">放弃</button>
    </div>`);
}

function methodCardFor(p) {
  const a = p.analysis;
  if (!a) return null;
  const existing = S.cards.find(c => c.problemId === p.id);
  return {
    ...(existing || { id: uid(), srs: newSrs(), created: Date.now() }),
    subject: p.subject,
    type: 'method',
    problemId: p.id,
    front: a.recallFront || a.problemText,
    back: `**${a.pattern}**\n👣 ${a.firstStep}`,
    note: a.trigger || '',
    importance: 3,
  };
}

async function savePreview() {
  const r = draft.preview;
  const created = Date.now();
  if (draft.mode === 'problem') {
    const imageIds = await saveImages(draft.photos.map(p => p.blob));
    const solutionImageIds = await saveImages(draft.solPhotos.map(p => p.blob));
    const p = {
      id: uid(), subject: draft.subject, ref: draft.ref || r.ref || '', title: r.title || draft.ref || '错题',
      imageIds, solutionImageIds, reason: draft.reason, note: draft.note, analysis: r,
      srs: newSrs(), chat: [], variants: [], created,
    };
    await putProblem(p);
    await putCard(methodCardFor(p));
    addXP(10);
    toast('+10 XP 已保存错题');
    draft = newDraft(p.subject);
    go('problem/' + p.id);
    return;
  }
  const imageIds = await saveImages(draft.photos.map(p => p.blob));
  const src = { id: uid(), subject: draft.subject, kind: draft.sourceKind, title: r.title || '资料', summary: r.summary || '', imageIds, created };
  const raw = r.words ? r.words.map(w => ({ ...w, type: 'word' })) : (r.cards || []);
  const cards = await addSourceWithCards(src, raw.filter(c => !c._del));
  addXP(Math.min(30, cards.length));
  toast(`已保存 ${cards.length} 张卡`);
  const sid = draft.subject;
  draft = newDraft(sid);
  go('source/' + src.id);
}

// Turns a raw card from the AI or a pack into a deck card. Word cards keep
// all their fields for the 4択 / reverse review formats.
function makeCard(c, src, i) {
  const base = { id: uid(), subject: src.subject, note: c.note || '', importance: c.importance || 2, sourceId: src.id, srs: newSrs(), created: src.created + i };
  if (c.type === 'word' || c.word) {
    const form = c.form || c.word;
    return {
      ...base, type: 'word', front: c.word, back: c.ja || '', word: c.word, pos: c.pos || '', ja: c.ja || '', zh: c.zh || '',
      ex: c.ex || '', exTr: c.exTr || '', form, cloze: c.cloze || '', distractors: c.distractors || [], colloc: c.colloc || '', syn: c.syn || '',
    };
  }
  const card = { ...base, type: c.type === 'cloze' ? 'cloze' : 'qa', front: c.front, back: c.back };
  const d = cardDistractors(c);
  if (d) card.distractors = d;
  if (d && c.quiz) card.quiz = true; // "which of these…" cards are always shown with their options
  return card;
}

// 3 wrong answers that turn a flashcard into a 4択 question (共通テスト style)
function cardDistractors(c) {
  const d = (c.distractors || []).map(x => String(x || '').trim()).filter(x => x && x !== String(c.back).trim());
  return new Set(d).size >= 3 ? [...new Set(d)].slice(0, 3) : null;
}

// Saves a 资料/补课 source and turns its raw cards into deck cards.
async function addSourceWithCards(src, rawCards) {
  await putSource(src);
  const cards = rawCards.map((c, i) => makeCard(c, src, i));
  await db.putMany('cards', cards);
  S.cards.push(...cards);
  return cards;
}

async function saveRawProblem() {
  const imageIds = await saveImages(draft.photos.map(p => p.blob));
  const solutionImageIds = await saveImages(draft.solPhotos.map(p => p.blob));
  const p = {
    id: uid(), subject: draft.subject, ref: draft.ref, title: draft.ref || '错题（未解析）',
    imageIds, solutionImageIds, reason: draft.reason, note: draft.note, analysis: null,
    srs: newSrs(), chat: [], variants: [], created: Date.now(),
  };
  await putProblem(p);
  addXP(5);
  draft = newDraft(p.subject);
  go('problem/' + p.id);
}

// ====================================================================
// REVIEW menu + session
// ====================================================================

async function viewReview() {
  const plan = todayPlan();
  setView(`
  <h2>🔁 复习</h2>
  <button class="big-btn primary" data-act="startToday">
    <b>▶ 今日任务</b><span>闪卡 ${plan.dueCards.length + plan.newCards.length} · 错题 ${plan.dueProblems.length}</span></button>
  <div class="grid2">
    <button class="big-btn" data-act="startMode" data-mode="cards"><b>🃏 只刷闪卡</b><span>到期 + 新卡</span></button>
    <button class="big-btn" data-act="startMode" data-mode="method"><b>🧠 解法闪卡</b><span>看题说出第一步</span></button>
    <button class="big-btn" data-act="startMode" data-mode="problems"><b>✏️ 错题重做</b><span>先想 60 秒再看提示</span></button>
    <button class="big-btn danger" data-act="startMode" data-mode="cram"><b>🔥 考前冲刺</b><span>不管到期，专刷弱项</span></button>
  </div>
  <button class="big-btn write-entry" data-act="nav" data-to="writing"><b>✍️ 英作文（要約・意見論述）</b><span>写作 → 按英検 4 个观点评分 → 范文和表达变成闪卡</span></button>
  <button class="big-btn chem-entry" data-act="nav" data-to="ptable"><b>🧪 周期表练习（化学基礎）</b><span>看表记位置 → 点出元素在哪里 → 看位置认元素</span></button>
  <button class="big-btn fey" data-act="nav" data-to="feynman"><b>🗣 费曼模式：讲给 AI 听</b><span>用自己的话讲出来 → AI 追问 → 评分 → 漏洞自动变成闪卡${S.feynman.filter(f => f.result).length ? ` · 已讲 ${S.feynman.filter(f => f.result).length} 次` : ''}</span></button>
  <h3 class="sec">按科目</h3>
  <div class="list">
    ${SUBJECTS.map(s => {
      const p = todayPlan(s.id);
      return `<button class="li" data-act="subjectMenu" data-sid="${s.id}" style="--c:${s.color}">
        <span class="dot"></span><span class="li-t">${s.icon} ${s.name}</span>
        <span class="muted small">卡 ${p.dueCards.length}+${p.newCards.length}新 · 题 ${p.dueProblems.length}</span></button>`;
    }).join('')}
  </div>
  <div class="card muted small">
    <b>为什么这样复习有效？</b><br>
    · 间隔重复：快忘的时候再出现，记得最牢。系统会保证考试前每张卡至少再出现两次。<br>
    · 主动回忆：先自己想，再看答案，比看10遍书都有用。<br>
    · 解法闪卡：数学/物理拿分的关键是“看到题就知道第一步”。这个练的就是它。
  </div>`);
}

function subjectMenu(sid) {
  const s = SUBJ[sid];
  const p = todayPlan(sid);
  modal(`
    <h3>${s.icon} ${s.name}</h3>
    <div class="stack">
      <button class="btn primary block" data-act="startMode" data-mode="today" data-sid="${sid}">▶ 今日任务（卡 ${p.dueCards.length + p.newCards.length} · 题 ${p.dueProblems.length}）</button>
      <button class="btn block" data-act="startMode" data-mode="cards" data-sid="${sid}">🃏 只刷闪卡</button>
      ${sid === 'chemb' ? '<button class="btn block" data-act="nav" data-to="ptable">🧪 周期表练习</button>' : ''}
      <button class="btn block" data-act="startMode" data-mode="method" data-sid="${sid}">🧠 解法闪卡</button>
      <button class="btn block" data-act="startMode" data-mode="problems" data-sid="${sid}">✏️ 错题重做</button>
      <button class="btn block danger" data-act="startMode" data-mode="cram" data-sid="${sid}">🔥 考前冲刺（弱项 50）</button>
      <button class="btn ghost block" data-act="libSubject" data-sid="${sid}">📚 查看题库</button>
      <button class="btn ghost block" data-act="addFor" data-sid="${sid}">📷 导入新内容</button>
    </div>`);
}

function buildSession(mode, sid) {
  const plan = todayPlan(sid);
  const inSub = x => !sid || x.subject === sid;
  const card = c => ({ kind: 'card', id: c.id });
  const prob = p => ({ kind: 'problem', id: p.id });
  let items = [];
  let title = '';
  if (mode === 'today') {
    title = '今日任务';
    // problems sprinkled between cards keeps it from getting boring
    const cards = shuffle([...plan.dueCards, ...plan.newCards]).map(card);
    const probs = shuffle(plan.dueProblems).map(prob);
    const gap = probs.length ? Math.max(3, Math.floor(cards.length / (probs.length + 1))) : 0;
    let pi = 0;
    cards.forEach((c, i) => {
      items.push(c);
      if (gap && (i + 1) % gap === 0 && pi < probs.length) items.push(probs[pi++]);
    });
    items.push(...probs.slice(pi));
  } else if (mode === 'cards') {
    title = '闪卡';
    items = shuffle([...plan.dueCards, ...plan.newCards]).map(card);
  } else if (mode === 'method') {
    title = '解法闪卡';
    const ms = S.cards.filter(c => c.type === 'method' && inSub(c));
    const due = ms.filter(c => !c.srs || c.srs.isNew || isDue(c.srs));
    items = shuffle(due.length ? due : ms).map(card);
  } else if (mode === 'problems') {
    title = '错题重做';
    const ps = S.problems.filter(inSub);
    items = (plan.dueProblems.length ? shuffle(plan.dueProblems) : [...ps].sort((a, b) => weakness(b.srs) - weakness(a.srs))).map(prob);
  } else if (mode === 'cram') {
    title = '考前冲刺';
    const all = [
      ...S.cards.filter(inSub).map(c => ({ w: weakness(c.srs) + (c.importance || 2) * 0.5, it: card(c) })),
      ...S.problems.filter(inSub).map(p => ({ w: weakness(p.srs) + 1, it: prob(p) })),
    ];
    items = all.sort((a, b) => b.w - a.w).slice(0, 50).map(x => x.it);
    items = shuffle(items);
  }
  return { mode, sid, title, items, idx: 0, flipped: false, hint: 0, phase: 'think', requeued: {}, results: [], combo: 0, bestCombo: 0, xp: 0, startedAt: Date.now(), t0: Date.now() };
}

function startSession(mode, sid) {
  const s = buildSession(mode, sid);
  if (!s.items.length) {
    toast(mode === 'method' ? '还没有解法闪卡（导入错题后自动生成）' : '这里没有需要复习的内容 🎉');
    return;
  }
  closeModal();
  session = s;
  go('session');
}

function curItem() {
  const it = session.items[session.idx];
  if (!it) return null;
  const obj = it.kind === 'card' ? S.cards.find(c => c.id === it.id) : S.problems.find(p => p.id === it.id);
  return obj ? { ...it, obj } : null;
}

async function viewSession() {
  if (!session) return go('review');
  while (session.idx < session.items.length && !curItem()) session.idx++;
  const it = curItem();
  if (!it) return sessionDone();
  const prog = `<div class="sess-top">
      <button class="icon" data-act="endSession">✕</button>
      <div class="prog"><i style="width:${session.idx / session.items.length * 100}%"></i></div>
      <span class="small">${session.idx + 1}/${session.items.length}</span>
      ${session.combo >= 3 ? `<span class="combo">🔥x${session.combo}</span>` : ''}
    </div>`;
  if (it.kind === 'card') return it.obj.type === 'word' ? renderWordItem(prog, it.obj) : renderCardItem(prog, it.obj);
  return renderProblemItem(prog, it.obj);
}

function renderCardItem(prog, c) {
  const s = SUBJ[c.subject];
  const typeName = { qa: '问答', cloze: '填空', method: '解法闪卡' }[c.type] || '';
  const isNew = !c.srs || c.srs.isNew;
  // cards with distractors: learn by flipping first, later half the time as 4択
  if (!session.wmode) {
    const canQuiz = c.distractors?.length >= 3;
    session.wmode = canQuiz && (c.quiz || (!isNew && Math.random() < 0.5)) ? 'quiz' : 'flip';
  }
  if (session.wmode === 'quiz') return renderCardQuiz(prog, c, s, typeName);
  const f = session.flipped;
  setView(`${prog}
    <div class="flash ${f ? 'flipped' : ''} ${c.type === 'method' ? 'method' : ''}" data-act="${f ? '' : 'flip'}" style="--c:${s.color}">
      <div class="flash-meta"><span>${s.icon} ${s.name}</span><span>${typeName}${isNew ? ' · 🆕' : ''}</span></div>
      ${c.type === 'method' ? '<div class="muted small">看到这道题，第一步做什么？用什么解法？先在脑中说出来。</div>' : ''}
      <div class="flash-front">${md(c.front)}</div>
      ${f ? `<div class="flash-sep"></div><div class="flash-back">${md(c.back)}</div>${c.note ? `<div class="note">${md(c.note)}</div>` : ''}
        <div class="row wrap">${c.type === 'method' && c.problemId ? `<button class="btn ghost small" data-act="openProblemFromSession" data-id="${c.problemId}">看完整解法 →</button>` : ''}
        <button class="btn ghost small" data-act="feyStart" data-kind="card" data-id="${c.id}">🗣 讲给 AI 听</button></div>` : '<div class="tap-hint">点卡片看答案</div>'}
    </div>
    ${f ? gradeBar(['忘了', '模糊', '记得', '秒答']) : `<button class="btn primary block big" data-act="flip">显示答案</button>`}
  `);
}

function renderCardQuiz(prog, c, s, typeName) {
  if (!session.quiz) session.quiz = { choices: shuffle([c.back, ...c.distractors.slice(0, 3)]), picked: null, t0: Date.now() };
  const q = session.quiz;
  const done = q.picked != null;
  const ok = done && q.picked === c.back;
  const g = ok ? (q.ms < 10000 ? 3 : 2) : 0;
  setView(`${prog}
    <div class="flash quiz" style="--c:${s.color}">
      <div class="flash-meta"><span>${s.icon} ${s.name}</span><span>4択・${typeName}</span></div>
      <div class="flash-front">${md(c.front)}</div>
      <div class="choices">${q.choices.map((ch, i) => `<button class="choice ${done ? (ch === c.back ? 'ok' : ch === q.picked ? 'ng' : 'dim') : ''}" data-act="quizPick" data-i="${i}" ${done ? 'disabled' : ''}><b>${i + 1}</b><span>${md(ch)}</span></button>`).join('')}</div>
      ${done && c.note ? `<div class="note">${md(c.note)}</div>` : ''}
    </div>
    ${done ? `<button class="btn primary block big" data-act="grade" data-g="${g}">${ok ? (g === 3 ? '⚡ 秒答！继续' : '⭕ 正确！继续') : '❌ 记住了，继续'}</button>` : ''}`);
}

function gradeBar(labels) {
  return `<div class="grades">${labels.map((l, g) => `<button class="g g${g}" data-act="grade" data-g="${g}">${l}</button>`).join('')}</div>`;
}

async function renderProblemItem(prog, p) {
  const s = SUBJ[p.subject];
  const a = p.analysis;
  const imgs = await imgsHTML(p.imageIds, 'thumbs big');
  if (session.phase === 'think') {
    setView(`${prog}
      <div class="card prob" style="--c:${s.color}">
        <div class="flash-meta"><span>${s.icon} ${s.name} · ✏️ 错题重做</span><span>${esc(p.ref || '')}</span></div>
        ${imgs}
        ${a?.problemText ? `<details><summary>文字版题目</summary><div>${md(a.problemText)}</div></details>` : ''}
        <div class="think"><span>先自己想：解法の型是什么？第一步写什么？</span><b id="timer">60</b></div>
        ${a && session.hint > 0 ? `<div class="hints">${a.hints.slice(0, session.hint).map((h, i) => `<div class="hint">💡${i + 1} ${md(h)}</div>`).join('')}</div>` : ''}
      </div>
      <div class="stack">
        <button class="btn primary block" data-act="probReveal">💡 我有思路了 → 对答案</button>
        ${a && session.hint < (a.hints?.length || 0) ? `<button class="btn block" data-act="probHint">🆘 没思路，给提示 ${session.hint + 1}/${a.hints.length}</button>` : ''}
        ${S.settings.apiKey ? `<button class="btn ghost block" data-act="tutorFromSession" data-id="${p.id}">🎓 让 AI 一步步带我做</button>` : ''}
      </div>`);
    startTimer();
    return;
  }
  const sol = await imgsHTML(p.solutionImageIds, 'thumbs');
  setView(`${prog}
    <div class="card prob" style="--c:${s.color}">
      <div class="flash-meta"><span>${s.icon} ${s.name} · ✏️ 错题重做</span><span>${esc(p.ref || '')}</span></div>
      ${imgs}
      ${a ? `
      <div class="kp"><span>🔍 识别信号</span>${md(a.trigger)}</div>
      <div class="kp"><span>🧠 解法の型</span><b>${md(a.pattern)}</b></div>
      <div class="kp"><span>👣 第一步</span>${md(a.firstStep)}</div>
      <details><summary>📝 完整步骤</summary>${stepsHTML(a.steps)}</details>
      <details><summary>✅ 答案</summary>${md(a.answer)}</details>` : ''}
      ${sol ? `<details ${a ? '' : 'open'}><summary>📖 解答页</summary>${sol}</details>` : ''}
    </div>
    <div class="muted small center">自己评一下：这道题现在能独立做出来吗？</div>
    ${gradeBar(['不会', '半会', '会了', '秒杀'])}
  `);
}

function startTimer() {
  clearInterval(timerHandle);
  const t0 = session.t0;
  timerHandle = setInterval(() => {
    const el = document.getElementById('timer');
    if (!el) return clearInterval(timerHandle);
    const left = 60 - Math.floor((Date.now() - t0) / 1000);
    el.textContent = left > 0 ? left : '⏰';
    el.classList.toggle('late', left <= 0);
  }, 500);
}

function stepsHTML(steps) {
  return `<ol class="steps">${(steps || []).map(st => `<li><b>${md(st.title)}</b>${md(st.detail)}</li>`).join('')}</ol>`;
}

async function grade(g) {
  const it = curItem();
  if (!it) return;
  const o = it.obj;
  const d = daysTo(o.subject);
  const wasNew = !o.srs || o.srs.isNew;
  o.srs = schedule(o.srs, g, d);
  if (wasNew) o.srs.firstSeen = todayKey();
  if (it.kind === 'card') await putCard(o); else {
    o.attempts = [...(o.attempts || []), { at: Date.now(), g }];
    await putProblem(o);
  }
  const good = g >= 2;
  session.combo = good ? session.combo + 1 : 0;
  session.bestCombo = Math.max(session.bestCombo, session.combo);
  const base = it.kind === 'card' ? [1, 2, 3, 4][g] : [4, 7, 12, 15][g];
  const bonus = session.combo && session.combo % 5 === 0 ? 5 : 0;
  session.xp += base + bonus;
  addXP(base + bonus, { review: true, correct: good, problem: it.kind === 'problem' });
  if (bonus) toast(`🔥 ${session.combo} 连击！+${bonus} XP`);
  session.results.push({ kind: it.kind, g });
  // forgotten → see it again a few items later (max twice)
  if (g === 0 && (session.requeued[o.id] || 0) < 2) {
    session.requeued[o.id] = (session.requeued[o.id] || 0) + 1;
    const pos = Math.min(session.items.length, session.idx + 4);
    session.items.splice(pos, 0, { kind: it.kind, id: o.id });
  }
  session.idx++;
  session.flipped = false;
  session.wmode = null;
  session.quiz = null;
  session.hint = 0;
  session.phase = 'think';
  session.t0 = Date.now();
  header();
  viewSession();
}

function sessionDone() {
  const r = session.results;
  const good = r.filter(x => x.g >= 2).length;
  const acc = r.length ? Math.round(good / r.length * 100) : 0;
  const mins = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
  const t = today();
  const msg = acc >= 90 ? '太强了！考试稳了 💯' : acc >= 70 ? '很好！再刷一轮就更稳 💪' : '忘了的卡系统会很快再给你，这正是在进步 📈';
  setView(`
    <div class="done">
      <div class="confetti">${Array.from('🎉⭐✨🔥📚').map((e, i) => `<span style="--i:${i}">${e}</span>`).join('')}</div>
      <h2>${esc(session.title)} 完成！</h2>
      <div class="done-grid">
        <div><b>${r.length}</b><small>题/卡</small></div>
        <div><b>${acc}%</b><small>正确率</small></div>
        <div><b>+${session.xp}</b><small>XP</small></div>
        <div><b>${session.bestCombo}</b><small>最高连击</small></div>
        <div><b>${mins}</b><small>分钟</small></div>
        <div><b>${t.reviews}/${S.settings.dailyGoal}</b><small>今日目标</small></div>
      </div>
      <p>${msg}</p>
      <div class="stack">
        <button class="btn primary block" data-act="nav" data-to="home">回首页</button>
        <button class="btn block" data-act="startMode" data-mode="${session.mode}" ${session.sid ? `data-sid="${session.sid}"` : ''}>再来一轮</button>
      </div>
    </div>`);
  session = null;
}

// ====================================================================
// WORD cards (語彙): flip / reverse / 4択 like 大問1
// ====================================================================

function speak(text) {
  try {
    if (!text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    const v = speechSynthesis.getVoices().find(x => /^en[-_]US/i.test(x.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* no speech on this device */ }
}

const sayBtn = t => `<button class="say" data-act="say" data-t="${esc(t)}" aria-label="发音">🔊</button>`;

function highlightWord(ex, form) {
  if (!ex || !form) return ex || '';
  const re = new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return ex.replace(re, m => `**${m}**`);
}

function wordDetails(c) {
  return `
    <div class="w-mean">${esc(c.ja)}${c.zh ? `<span class="w-zh">${esc(c.zh)}</span>` : ''}</div>
    ${c.ex ? `<div class="w-ex">${md(highlightWord(c.ex, c.form || c.word))} ${sayBtn(c.ex)}</div>` : ''}
    ${c.exTr ? `<div class="w-tr">${esc(c.exTr)}</div>` : ''}
    ${c.colloc ? `<div class="w-kv"><span>搭配</span>${esc(c.colloc)}</div>` : ''}
    ${c.syn ? `<div class="w-kv"><span>近义</span>${esc(c.syn)}</div>` : ''}
    ${c.note ? `<div class="note">${md(c.note)}</div>` : ''}`;
}

// New words are learned by flipping; known words rotate through 4択 (the
// exam format), plain flip, and meaning → English recall.
function pickWordMode(c) {
  if (!c.srs || c.srs.isNew) return 'flip';
  const r = Math.random();
  if (c.cloze && r < 0.5) return 'quiz';
  return r < 0.8 ? 'flip' : 'reverse';
}

function wordChoices(c) {
  const correct = c.form || c.word;
  const same = x => x.toLowerCase() === correct.toLowerCase();
  const others = (c.distractors || []).filter(x => x && !same(x)).slice(0, 3);
  if (others.length < 3) {
    const pool = shuffle(S.cards.filter(x => x.type === 'word' && x.id !== c.id));
    for (const x of [...pool.filter(x => x.pos === c.pos), ...pool]) {
      const w = x.form || x.word;
      if (others.length >= 3) break;
      if (w && !same(w) && !others.includes(w)) others.push(w);
    }
  }
  return shuffle([correct, ...others]);
}

function renderWordItem(prog, c) {
  const s = SUBJ[c.subject];
  if (!session.wmode) session.wmode = pickWordMode(c);
  const mode = session.wmode;
  const isNew = !c.srs || c.srs.isNew;
  const meta = label => `<div class="flash-meta"><span>${s.icon} ${s.name}</span><span>${label}${isNew ? ' · 🆕' : ''}</span></div>`;
  const pos = c.pos ? `<span class="w-pos">${esc(c.pos)}</span>` : '';
  const f = session.flipped;

  if (mode === 'quiz') {
    if (!session.quiz) session.quiz = { choices: wordChoices(c), picked: null, t0: Date.now() };
    const q = session.quiz;
    const correct = c.form || c.word;
    const done = q.picked != null;
    const ok = done && q.picked === correct;
    const g = ok ? (q.ms < 8000 ? 3 : 2) : 0;
    setView(`${prog}
      <div class="flash quiz" style="--c:${s.color}">
        ${meta('4択・大問1 形式')}
        <div class="w-cloze">${md(c.cloze)}</div>
        <div class="choices">${q.choices.map((ch, i) => `<button class="choice ${done ? (ch === correct ? 'ok' : ch === q.picked ? 'ng' : 'dim') : ''}" data-act="quizPick" data-i="${i}" ${done ? 'disabled' : ''}><b>${i + 1}</b>${esc(ch)}</button>`).join('')}</div>
        ${done ? `<div class="flash-sep"></div><div class="w-word">${esc(c.word)} ${pos} ${sayBtn(c.word)}</div>${wordDetails(c)}` : ''}
      </div>
      ${done ? `<button class="btn primary block big" data-act="grade" data-g="${g}">${ok ? (g === 3 ? '⚡ 秒答！继续' : '⭕ 正确！继续') : '❌ 记住了，继续'}</button>` : ''}`);
    return;
  }

  if (mode === 'reverse') {
    setView(`${prog}
      <div class="flash" data-act="${f ? '' : 'flip'}" style="--c:${s.color}">
        ${meta('意思 → 英语')}
        <div class="muted small">看意思，说出（或写出）这个英文单词</div>
        <div class="w-mean big">${esc(c.ja)}${c.zh ? `<span class="w-zh">${esc(c.zh)}</span>` : ''}</div>
        ${f ? `<div class="flash-sep"></div><div class="w-word">${esc(c.word)} ${pos} ${sayBtn(c.word)}</div>
          ${c.ex ? `<div class="w-ex">${md(highlightWord(c.ex, c.form || c.word))}</div>` : ''}` : '<div class="tap-hint">点卡片看答案</div>'}
      </div>
      ${f ? gradeBar(['忘了', '模糊', '记得', '秒答']) : '<button class="btn primary block big" data-act="flip">显示答案</button>'}`);
    if (f && S.settings.autoSpeak) speak(c.word);
    return;
  }

  setView(`${prog}
    <div class="flash" data-act="${f ? '' : 'flip'}" style="--c:${s.color}">
      ${meta('单词')}
      <div class="w-word big">${esc(c.word)} ${pos} ${sayBtn(c.word)}</div>
      ${f ? `<div class="flash-sep"></div>${wordDetails(c)}` : '<div class="tap-hint">先想意思，再点卡片看答案</div>'}
    </div>
    ${f ? gradeBar(['忘了', '模糊', '记得', '秒答']) : '<button class="btn primary block big" data-act="flip">显示答案</button>'}`);
  if (!f && S.settings.autoSpeak) speak(c.word);
}

// ====================================================================
// LIBRARY
// ====================================================================

async function viewLib() {
  const sub = lib.subject;
  const inSub = x => sub === 'all' || x.subject === sub;
  const q = lib.q.trim().toLowerCase();
  const match = (...xs) => !q || xs.some(x => String(x || '').toLowerCase().includes(q));
  let list = '';
  if (lib.tab === 'problems') {
    const ps = S.problems.filter(inSub).filter(p => match(p.title, p.ref, p.analysis?.pattern, p.analysis?.topic))
      .sort((a, b) => b.created - a.created);
    list = ps.length ? ps.map(p => `<button class="li" data-act="nav" data-to="problem/${p.id}" style="--c:${SUBJ[p.subject].color}">
        <span class="dot"></span><span class="li-t">${esc(p.title)}<br><small class="muted">${esc(p.analysis?.pattern || '未解析')}</small></span>
        <span class="mini-m">${Math.round(mastery(p.srs) * 100)}%</span></button>`).join('')
      : '<div class="empty">还没有错题。做完问题集后，把错题拍进来吧。</div>';
  } else if (lib.tab === 'sources') {
    const ss = S.sources.filter(inSub).filter(s => match(s.title, s.summary)).sort((a, b) => b.created - a.created);
    list = ss.length ? ss.map(s => `<button class="li" data-act="nav" data-to="source/${s.id}" style="--c:${SUBJ[s.subject].color}">
        <span class="dot"></span><span class="li-t">${s.kind === 'lesson' ? `📖 ${esc(s.title)}<br><small class="muted">补课 ${Math.min(s.step || 0, s.lesson.sections.length)}/${s.lesson.sections.length} 节</small>` : esc(s.title)}</span>
        <span class="muted small">${S.cards.filter(c => c.sourceId === s.id).length} 张</span></button>`).join('')
      : '<div class="empty">还没有资料。</div>';
  } else {
    const cs = S.cards.filter(inSub).filter(c => match(c.front, c.back, c.note)).sort((a, b) => b.created - a.created).slice(0, 300);
    list = cs.length ? cs.map(c => cardRow(c)).join('') : '<div class="empty">还没有闪卡。</div>';
  }
  setView(`
    <h2>📚 题库</h2>
    <div class="chips"><button class="chip ${sub === 'all' ? 'on' : ''}" data-act="libSubject" data-sid="all">全部</button>${SUBJECTS.map(s => subjChip(s.id, sub === s.id, 'libSubject')).join('')}</div>
    <div class="seg">
      <button class="${lib.tab === 'problems' ? 'on' : ''}" data-act="libTab" data-tab="problems">✏️ 错题</button>
      <button class="${lib.tab === 'cards' ? 'on' : ''}" data-act="libTab" data-tab="cards">🃏 闪卡</button>
      <button class="${lib.tab === 'sources' ? 'on' : ''}" data-act="libTab" data-tab="sources">📄 资料</button>
    </div>
    <input class="search" data-bind-lib="q" placeholder="🔍 搜索" value="${esc(lib.q)}">
    <div class="list">${list}</div>
  `);
}

function cardRow(c) {
  if (c.type === 'word') {
    return `<button class="li card-li" data-act="editCard" data-id="${c.id}" style="--c:${SUBJ[c.subject].color}">
    <span class="dot"></span><span class="li-t"><b>${esc(c.word)}</b> <span class="w-pos">${esc(c.pos)}</span><small class="muted">${esc(c.ja)}${c.zh ? ` ／ ${esc(c.zh)}` : ''}</small></span>
    <span class="mini-m">${c.srs?.isNew ? '新' : Math.round(mastery(c.srs) * 100) + '%'}</span></button>`;
  }
  return `<button class="li card-li" data-act="editCard" data-id="${c.id}" style="--c:${SUBJ[c.subject].color}">
    <span class="dot"></span><span class="li-t">${md(c.front)}<small class="muted">${md(c.back)}</small></span>
    <span class="mini-m">${c.srs?.isNew ? '新' : Math.round(mastery(c.srs) * 100) + '%'}</span></button>`;
}

async function viewSource(id) {
  const src = S.sources.find(s => s.id === id);
  if (!src) return go('lib');
  if (src.lesson) return viewLesson(src);
  const cards = S.cards.filter(c => c.sourceId === id);
  setView(`
    <button class="back" data-act="back">‹ 返回</button>
    <h2>${esc(src.title)}</h2>
    <div class="muted small">${SUBJ[src.subject].name} · ${cards.length} 张卡</div>
    <div class="card"><h4>📌 考前一页纸</h4><div class="summary">${md(src.summary)}</div></div>
    ${await imgsHTML(src.imageIds)}
    <div class="row"><button class="btn primary" data-act="studySource" data-id="${id}">▶ 只刷这份资料</button>
      <button class="btn" data-act="feyStart" data-kind="source" data-id="${id}">🗣 讲给 AI 听</button>
      <button class="btn danger ghost" data-act="delSource" data-id="${id}">删除</button></div>
    <div class="list">${cards.map(cardRow).join('')}</div>
  `);
}

function editCard(id) {
  const c = S.cards.find(x => x.id === id) || { id: null, subject: lib.subject !== 'all' ? lib.subject : (draft?.subject || 'vocab'), type: 'qa', front: '', back: '', note: '', importance: 2 };
  modal(`
    <h3>${c.id ? '编辑卡片' : '新卡片'}</h3>
    <label class="lbl">科目</label>
    <select id="ec-sub">${SUBJECTS.map(s => `<option value="${s.id}" ${s.id === c.subject ? 'selected' : ''}>${s.name}</option>`).join('')}</select>
    <label class="lbl">正面（问题）</label><textarea id="ec-f" rows="3">${esc(c.front)}</textarea>
    <label class="lbl">背面（答案）</label><textarea id="ec-b" rows="3">${esc(c.back)}</textarea>
    <label class="lbl">备注</label><textarea id="ec-n" rows="2">${esc(c.note)}</textarea>
    <div class="muted small">数式可以用 $x^2$，化学式 $\\ce{H2O}$</div>
    <div class="stack">
      <button class="btn primary block" data-act="saveCard" data-id="${c.id || ''}">保存</button>
      ${c.id ? `<button class="btn block" data-act="feyStart" data-kind="card" data-id="${c.id}">🗣 讲给 AI 听（费曼模式）</button>
      <button class="btn block" data-act="resetCard" data-id="${c.id}">重置进度（当新卡）</button>
      <button class="btn danger ghost block" data-act="delCard" data-id="${c.id}">删除</button>` : ''}
    </div>`);
}

// ====================================================================
// PROBLEM detail
// ====================================================================

function problemBody(a, open = false) {
  if (!a) return '';
  return `
    <div class="card">
      <div class="muted small">${esc(a.topic)}</div>
      <details ${open ? 'open' : ''}><summary>📄 题目</summary>${md(a.problemText)}</details>
    </div>
    <div class="card">
      <div class="kp"><span>🔍 识别信号</span>${md(a.trigger)}</div>
      <div class="kp"><span>🧠 解法の型</span><b>${md(a.pattern)}</b></div>
      <div class="kp"><span>💭 核心思路</span>${md(a.keyIdea)}</div>
      <div class="kp"><span>👣 第一步</span>${md(a.firstStep)}</div>
    </div>
    <div class="card">
      <h4>💡 提示（一个一个点开）</h4>
      ${(a.hints || []).map((h, i) => `<details><summary>提示 ${i + 1}</summary>${md(h)}</details>`).join('')}
    </div>
    <div class="card">
      <h4>📝 完整步骤</h4>
      ${(a.steps || []).map((st, i) => `<details ${open ? 'open' : ''}><summary>${i + 1}. ${esc(plain(st.title))}</summary>${md(st.detail)}</details>`).join('')}
      <details ${open ? 'open' : ''}><summary>✅ 答案</summary>${md(a.answer)}</details>
    </div>
    ${a.pitfalls?.length ? `<div class="card"><h4>⚠️ 易错点</h4>${md(a.pitfalls.map(x => '- ' + x).join('\n'))}</div>` : ''}
    ${a.formulas?.length ? `<div class="card"><h4>📐 用到的公式</h4>${md(a.formulas.map(x => '- ' + x).join('\n'))}</div>` : ''}`;
}

async function viewProblem(id) {
  const p = S.problems.find(x => x.id === id);
  if (!p) return go('lib');
  const s = SUBJ[p.subject];
  const hasKey = !!S.settings.apiKey;
  setView(`
    <button class="back" data-act="back">‹ 返回</button>
    <h2>${esc(p.title)}</h2>
    <div class="muted small">${s.icon} ${s.name} ${p.ref ? '· ' + esc(p.ref) : ''} · 掌握 ${Math.round(mastery(p.srs) * 100)}% ${(p.reason || []).map(r => `<span class="tag">${r}</span>`).join('')}</div>
    ${await imgsHTML(p.imageIds)}
    ${p.solutionImageIds?.length ? `<details class="card"><summary>📖 解答页照片</summary>${await imgsHTML(p.solutionImageIds)}</details>` : ''}
    ${p.note ? `<div class="card small">📝 ${md(p.note)}</div>` : ''}
    <div class="grid2">
      <button class="big-btn primary" data-act="nav" data-to="tutor/${p.id}" ${hasKey ? '' : 'disabled'}><b>🎓 AI 辅导</b><span>一步步引导，不直接给答案</span></button>
      <button class="big-btn" data-act="makeVariant" data-id="${p.id}" ${hasKey && p.analysis ? '' : 'disabled'}><b>🔁 出类题</b><span>同题型的新题</span></button>
    </div>
    ${p.analysis ? `<button class="big-btn fey" data-act="feyStart" data-kind="problem" data-id="${p.id}"><b>🗣 讲给 AI 听</b><span>把“为什么这样解”讲清楚，才算真的会了</span></button>` : ''}
    ${!hasKey ? '<div class="muted small">AI 辅导和类题需要 API Key（设置里填写）。</div>' : ''}
    ${p.analysis ? problemBody(p.analysis) : `
      <div class="card">还没有解析。
        <div class="stack"><button class="btn primary block" data-act="analyzeExisting" data-id="${p.id}" ${hasKey ? '' : 'disabled'}>🤖 AI 解析</button>
        <button class="btn block" data-act="manualExisting" data-id="${p.id}">🆓 免费：复制提示词</button></div></div>`}
    ${(p.variants || []).length ? `<h3 class="sec">🔁 类题</h3>${p.variants.map((v, i) => `
      <div class="card">
        <div class="muted small">类题 ${i + 1} · ${esc(v.changed)}</div>
        <div>${md(v.problem)}</div>
        <div class="muted small">先在纸上做完再看答案 ↓</div>
        <details><summary>✅ 答案</summary>${md(v.answer)}</details>
        <details><summary>📝 步骤</summary><ol class="steps">${v.steps.map(x => `<li>${md(x)}</li>`).join('')}</ol></details>
        <div class="row">
          ${hasKey ? `<button class="btn small" data-act="tutorVariant" data-id="${p.id}" data-i="${i}">🎓 让 AI 带我做/批改</button>` : ''}
          <button class="btn small" data-act="variantResult" data-id="${p.id}" data-ok="1">✅ 做对了</button>
          <button class="btn small" data-act="variantResult" data-id="${p.id}" data-ok="0">❌ 错了</button>
        </div>
      </div>`).join('')}` : ''}
    <div class="row wrap">
      <button class="btn ghost" data-act="editProblem" data-id="${p.id}">✏️ 编辑</button>
      <button class="btn ghost" data-act="resetProblem" data-id="${p.id}">重置进度</button>
      <button class="btn danger ghost" data-act="delProblem" data-id="${p.id}">🗑 删除</button>
    </div>
  `);
}

async function analyzeExisting(id) {
  const p = S.problems.find(x => x.id === id);
  if (busy || !p) return;
  busy = true;
  const done = aiOverlay('AI 正在拆解这道题…');
  try {
    const prompt = AI.problemPrompt({ subject: SUBJ[p.subject], ref: p.ref, note: p.note, reason: (p.reason || []).join('、'),
      hasSolution: !!p.solutionImageIds?.length, settings: S.settings });
    const imgs = await imagesB64(p.imageIds);
    const sol = await imagesB64(p.solutionImageIds);
    if (sol.length) prompt.user = `（共 ${imgs.length} 张题目图片，之后 ${sol.length} 张是【解答】图片）\n` + prompt.user;
    const a = await AI.generateJSON(S.settings, prompt, [...imgs, ...sol], 'problem', 'high');
    await applyAnalysis(p, a);
  } catch (e) {
    alertBox('出错了', e.message);
  } finally {
    done();
    busy = false;
  }
}

async function applyAnalysis(p, a) {
  p.analysis = a;
  if (!p.ref && a.ref) p.ref = a.ref;
  if (!p.title || p.title.includes('未解析')) p.title = a.title || p.title;
  await putProblem(p);
  await putCard(methodCardFor(p));
  route();
}

async function makeVariant(id) {
  const p = S.problems.find(x => x.id === id);
  if (busy || !p?.analysis) return;
  busy = true;
  const done = aiOverlay('AI 正在出类题并验算…');
  try {
    const prompt = AI.variantPrompt({ subject: SUBJ[p.subject], problem: p.analysis, settings: S.settings });
    const v = await AI.generateJSON(S.settings, prompt, [], 'variant', 'high');
    p.variants = [...(p.variants || []), { ...v, created: Date.now() }];
    await putProblem(p);
    addXP(3);
    route();
    setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 100);
  } catch (e) {
    alertBox('出错了', e.message);
  } finally {
    done();
    busy = false;
  }
}

function editProblem(id) {
  const p = S.problems.find(x => x.id === id);
  const a = p.analysis || {};
  const f = (k, label, rows = 2) => `<label class="lbl">${label}</label><textarea data-k="${k}" rows="${rows}">${esc(a[k] || '')}</textarea>`;
  modal(`
    <h3>编辑错题</h3>
    <label class="lbl">标题</label><input id="ep-title" value="${esc(p.title)}">
    <label class="lbl">题号</label><input id="ep-ref" value="${esc(p.ref || '')}">
    ${p.analysis ? `${f('pattern', '解法の型')}${f('trigger', '识别信号')}${f('keyIdea', '核心思路', 3)}${f('firstStep', '第一步')}${f('answer', '答案')}${f('recallFront', '解法闪卡正面', 3)}` : ''}
    <div class="muted small">完整步骤和提示如果有错，可以在 AI 辅导里问，或重新解析。</div>
    <div class="stack"><button class="btn primary block" data-act="saveProblemEdit" data-id="${id}">保存</button>
      ${p.analysis && S.settings.apiKey ? `<button class="btn block" data-act="reanalyze" data-id="${id}">🤖 重新解析</button>` : ''}</div>
  `);
}

// ====================================================================
// TUTOR (Socratic chat)
// ====================================================================

let tutorAttach = null;

async function viewTutor(id) {
  const p = S.problems.find(x => x.id === id);
  if (!p) return go('lib');
  const s = SUBJ[p.subject];
  const msgs = p.chat || [];
  const bubbles = await Promise.all(msgs.map(async m => {
    const img = m.imageId ? await imgsHTML([m.imageId], 'chat-img') : '';
    return `<div class="bubble ${m.role}">${img}${md(m.display ?? m.text)}</div>`;
  }));
  setView(`
    <div class="tutor-top"><button class="back" data-act="nav" data-to="problem/${p.id}">‹ ${esc(p.title)}</button>
      <button class="btn ghost small" data-act="clearChat" data-id="${p.id}">清空</button></div>
    <details class="card"><summary>${s.icon} 看题目</summary>${await imgsHTML(p.imageIds)}${p.analysis ? md(p.analysis.problemText) : ''}</details>
    <div class="chat" id="chat">
      ${msgs.length ? bubbles.join('') : `<div class="bubble assistant">我不会直接给你答案，而是一步步问你问题，让你自己想出来 💪<br>先告诉我：这道题在问什么？你打算从哪里下手？（不知道也可以直接说“没思路”）</div>`}
    </div>
    <div class="quick">
      ${['没思路', '给我一个提示', '我这样想对吗？', '检查我的答案', '给我完整解法'].map(q => `<button class="chip" data-act="quickSay" data-id="${p.id}" data-q="${q}">${q}</button>`).join('')}
    </div>
    <div class="composer">
      <label class="icon-btn"><input type="file" accept="image/*" data-file="tutor" hidden>📷</label>
      <textarea id="tutor-in" rows="1" placeholder="输入你的想法 / 拍下你的手写解答"></textarea>
      <button class="btn primary" data-act="tutorSend" data-id="${p.id}">发送</button>
    </div>
    <div id="attach-prev">${tutorAttach ? `<img src="${tutorAttach.url}"> <button class="chip" data-act="rmAttach">移除图片</button>` : ''}</div>
  `);
  const chatEl = document.getElementById('chat');
  chatEl.lastElementChild?.scrollIntoView({ block: 'end' });
}

async function tutorSend(id, textOverride, display) {
  const p = S.problems.find(x => x.id === id);
  if (!p || busy) return;
  const input = document.getElementById('tutor-in');
  const text = (textOverride ?? input?.value ?? '').trim();
  if (!text && !tutorAttach) return;
  busy = true;
  const msg = { role: 'user', text: text || '这是我的解答，帮我检查。' };
  if (display) msg.display = display;
  if (tutorAttach) {
    [msg.imageId] = await saveImages([tutorAttach.blob]);
    tutorAttach = null;
  }
  p.chat = [...(p.chat || []), msg];
  await putProblem(p);
  await viewTutor(id);
  const chatEl = document.getElementById('chat');
  chatEl.insertAdjacentHTML('beforeend', '<div class="bubble assistant typing"><i></i><i></i><i></i></div>');
  chatEl.lastElementChild.scrollIntoView({ block: 'end' });
  try {
    const messages = await buildTutorMessages(p);
    const reply = await AI.chat(S.settings, AI.tutorSystem({ subject: SUBJ[p.subject], problem: p.analysis || {}, settings: S.settings }), messages);
    p.chat.push({ role: 'assistant', text: reply });
    await putProblem(p);
    addXP(2);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    busy = false;
  }
  if (location.hash === '#/tutor/' + id) viewTutor(id);
}

async function buildTutorMessages(p) {
  const out = [];
  const probImgs = await imagesB64(p.imageIds);
  for (let i = 0; i < p.chat.length; i++) {
    const m = p.chat[i];
    const content = [];
    if (i === 0) {
      probImgs.forEach(b => content.push(AI.imageBlock(b)));
      content.push({ type: 'text', text: '（以上是题目图片）' });
    }
    if (m.imageId) {
      const b = await getImage(m.imageId);
      if (b) content.push(AI.imageBlock(await blobToBase64(b)));
    }
    content.push({ type: 'text', text: m.text });
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...content);
    else out.push({ role: m.role, content });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '开始' }] });
  return out;
}

// ====================================================================
// PACKS (卡包): cards / problems / lessons Claude made in the chat,
// published as JSON under packs/ in the repo and imported with one tap.
// ====================================================================

const PACK_INDEX = 'packs/index.json';

async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`下载失败（${r.status}）`);
  return r.json();
}

async function fetchImages(urls) {
  const blobs = [];
  for (const u of urls || []) {
    try {
      const r = await fetch(u, { cache: 'no-store' });
      if (r.ok) blobs.push(await r.blob());
    } catch { /* skip a missing image */ }
  }
  return saveImages(blobs);
}

async function importPack(pack) {
  if (!SUBJ[pack.subject]) throw new Error(`未知科目：${pack.subject}`);
  const created = Date.now();
  if (pack.kind === 'cards') {
    await addSourceWithCards({
      id: uid(), subject: pack.subject, kind: pack.sourceKind || 'print', title: pack.title || '资料',
      summary: pack.summary || '', imageIds: await fetchImages(pack.images), created, packId: pack.id,
    }, pack.cards || []);
  } else if (pack.kind === 'problem') {
    const a = pack.analysis;
    const p = {
      id: uid(), subject: pack.subject, ref: pack.ref || a?.ref || '', title: pack.title || a?.title || '错题',
      imageIds: await fetchImages(pack.images), solutionImageIds: await fetchImages(pack.solutionImages),
      reason: pack.reason || [], note: pack.note || '', analysis: a || null,
      srs: newSrs(), chat: [], variants: pack.variants || [], created, packId: pack.id,
    };
    await putProblem(p);
    if (a) await putCard(methodCardFor(p));
  } else if (pack.kind === 'lesson') {
    const { src, cards } = buildLessonSource(pack.lesson, pack.subject, await fetchImages(pack.images));
    src.packId = pack.id;
    await addSourceWithCards(src, cards);
  } else {
    throw new Error(`未知卡包类型：${pack.kind}`);
  }
  const done = await db.getMeta('importedPacks', []);
  if (pack.id && !done.includes(pack.id)) await db.setMeta('importedPacks', [...done, pack.id]);
}

const PACK_ICON = { cards: '📄', problem: '✏️', lesson: '📖' };

async function viewPacks() {
  setView('<button class="back" data-act="nav" data-to="add">‹ 拍照导入</button><h2>📦 卡包</h2><div class="empty">正在检查新卡包…</div>');
  const imported = await db.getMeta('importedPacks', []);
  let list = [];
  let err = '';
  try {
    list = (await fetchJSON(PACK_INDEX)).packs || [];
  } catch (e) {
    err = e.message;
  }
  list.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  const fresh = list.filter(p => !imported.includes(p.id));
  setView(`
    <button class="back" data-act="nav" data-to="add">‹ 拍照导入</button>
    <h2>📦 卡包</h2>
    <div class="card small">在 Claude 聊天里发プリント或错题的照片，Claude 做好的闪卡和解法会出现在这里。点“导入”就进 App，<b>不花 API 费用</b>。</div>
    ${err ? `<div class="card warn small">没能读取卡包列表（${esc(err)}）。确认联网后再试，或者用下面的“粘贴卡包”。</div>` : ''}
    ${fresh.length > 1 ? `<button class="btn primary block" data-act="packImportAll">⬇️ 全部导入新的（${fresh.length}）</button>` : ''}
    <div class="list">
      ${list.length ? list.map(p => {
        const done = imported.includes(p.id);
        const s = SUBJ[p.subject];
        return `<div class="li" style="--c:${s?.color || '#888'}">
          <span class="dot"></span>
          <span class="li-t">${PACK_ICON[p.kind] || '📦'} ${esc(p.title)}<br><small class="muted">${s?.name || p.subject}${p.count ? ` · ${p.count} 张卡` : ''}${p.created ? ` · ${esc(p.created.slice(5, 10).replace('-', '/'))}` : ''}</small></span>
          ${done ? '<span class="muted small">✅ 已导入</span>' : `<button class="btn primary small" data-act="packImport" data-id="${esc(p.id)}">导入</button>`}
        </div>`;
      }).join('') : err ? '' : '<div class="empty">还没有卡包。在聊天里把照片发给 Claude 吧！</div>'}
    </div>
    <details class="card"><summary>📋 粘贴卡包（Claude 直接在聊天里给你的 JSON）</summary>
      <textarea id="pack-json" rows="5" placeholder='{"kind":"cards", ...}'></textarea>
      <button class="btn primary block" data-act="packPaste">导入</button>
    </details>
  `);
}

async function runPackImports(entries) {
  if (busy) return;
  busy = true;
  const done = aiOverlay('正在导入卡包…');
  let ok = 0;
  try {
    for (const e of entries) {
      const pack = e.file ? await fetchJSON('packs/' + e.file) : e;
      await importPack(pack);
      ok++;
    }
    if (ok) addXP(ok * 3);
    toast(`已导入 ${ok} 个卡包`);
  } catch (e) {
    alertBox('导入失败', `${ok ? `前 ${ok} 个已导入。` : ''}${e.message}`);
  } finally {
    done();
    busy = false;
  }
  header();
  if (location.hash === '#/packs') viewPacks();
}

// ====================================================================
// LESSON (补课): learn what you missed, section by section
// ====================================================================

const lessonEffort = sid => (sid === 'read' ? 'high' : 'medium');

function buildLessonSource(r, subject, imageIds) {
  if (!Array.isArray(r?.sections) || !r.sections.length) throw new Error('格式不对：没有 sections');
  for (const k of ['prerequisites', 'keyPoints', 'formulas', 'cards']) r[k] = Array.isArray(r[k]) ? r[k] : [];
  const { cards, ...lesson } = r;
  const src = {
    id: uid(), subject, kind: 'lesson', title: r.title || '补课', imageIds, created: Date.now(),
    summary: r.keyPoints.map(x => '- ' + x).join('\n'), lesson, step: 0,
  };
  return { src, cards };
}

async function saveLesson(r) {
  const { src, cards } = buildLessonSource(r, draft.subject, await saveImages(draft.photos.map(p => p.blob)));
  await addSourceWithCards(src, cards);
  addXP(10);
  draft = newDraft(src.subject);
  go('source/' + src.id);
}

function lessonSectionBody(sec) {
  return `<div>${md(sec.explain)}</div>
    ${sec.example ? `<div class="example"><h4>✍️ 例题</h4>${md(sec.example)}</div>` : ''}
    ${(sec.more || []).map(m => `<div class="more"><h4>🔄 换个讲法</h4>${md(m)}</div>`).join('')}`;
}

async function viewLesson(src) {
  const L = src.lesson;
  const n = L.sections.length;
  const step = Math.min(src.step || 0, n);
  const s = SUBJ[src.subject];
  const cards = S.cards.filter(c => c.sourceId === src.id);
  const hasKey = !!S.settings.apiKey;
  const cur = L.sections[step];
  setView(`
    <button class="back" data-act="back">‹ 返回</button>
    <h2>📖 ${esc(src.title)}</h2>
    <div class="muted small">${s.icon} ${s.name} · 补课 · 进度 ${step}/${n}</div>
    <div class="prog lesson-prog"><i style="width:${step / n * 100}%"></i></div>
    <div class="card"><h4>🎯 这一节在学什么</h4>${md(L.overview)}</div>
    ${L.prerequisites.length ? `<details class="card"><summary>🧱 需要先会的旧知识（${L.prerequisites.length}）</summary>${md(L.prerequisites.map(x => '- ' + x).join('\n'))}</details>` : ''}
    ${L.sections.slice(0, step).map((sec, i) => `<details class="card"><summary>✅ ${i + 1}. ${esc(plain(sec.heading))}</summary>${lessonSectionBody(sec)}</details>`).join('')}
    ${cur ? `
    <div class="card lesson-sec" id="cur-sec">
      <div class="muted small">第 ${step + 1} / ${n} 节</div>
      <h3>${md(cur.heading)}</h3>
      ${lessonSectionBody(cur)}
      <div class="check"><h4>🤔 检查一下</h4>${md(cur.checkQ)}<details><summary>先自己想，再看答案</summary>${md(cur.checkA)}</details></div>
      <div class="stack">
        <button class="btn primary block" data-act="lessonNext" data-id="${src.id}">✅ 懂了，${step + 1 < n ? '下一节' : '完成'}</button>
        ${hasKey ? `<button class="btn block" data-act="lessonMore" data-id="${src.id}">🤔 还是不懂，换个讲法</button>` : ''}
      </div>
    </div>` : `
    <div class="card lesson-done">
      <h3>🎉 这一节补完了！</h3>
      <h4>📌 考试要点</h4>${md(L.keyPoints.map(x => '- ' + x).join('\n'))}
      ${L.formulas.length ? `<h4>📐 公式</h4>${md(L.formulas.map(x => '- ' + x).join('\n'))}` : ''}
      <div class="muted small">已经自动做成 ${cards.length} 张闪卡，会按遗忘曲线出现在“今日任务”里。</div>
      <div class="stack">
        <button class="btn primary block" data-act="feyStart" data-kind="source" data-id="${src.id}">🗣 用费曼模式讲一遍（检验是不是真懂了）</button>
        <button class="btn block" data-act="studySource" data-id="${src.id}">▶ 马上刷这一节的闪卡</button>
        <button class="btn ghost block" data-act="lessonReset" data-id="${src.id}">从头再看一遍</button>
      </div>
    </div>`}
    ${src.imageIds?.length ? `<details class="card"><summary>📷 原始照片</summary>${await imgsHTML(src.imageIds)}</details>` : ''}
    <details class="card"><summary>🃏 这一节的闪卡（${cards.length}）</summary><div class="list">${cards.map(cardRow).join('')}</div></details>
    <div class="row"><button class="btn danger ghost" data-act="delSource" data-id="${src.id}">删除这节补课</button></div>
  `);
  if (step > 0 && cur) document.getElementById('cur-sec')?.scrollIntoView({ block: 'start' });
}

async function lessonMore(id) {
  const src = S.sources.find(s => s.id === id);
  if (!src || busy) return;
  const sec = src.lesson.sections[src.step || 0];
  if (!sec) return;
  busy = true;
  const done = aiOverlay('老师在想另一种讲法…');
  try {
    const prompt = AI.lessonMorePrompt({ subject: SUBJ[src.subject], lesson: src.lesson, section: sec, settings: S.settings });
    const text = await AI.chat(S.settings, prompt.system, [{ role: 'user', content: prompt.user }], 'medium');
    sec.more = [...(sec.more || []), text];
    await putSource(src);
  } catch (e) {
    alertBox('出错了', e.message);
  } finally {
    done();
    busy = false;
  }
  await viewLesson(src);
  const more = document.querySelectorAll('#cur-sec .more');
  more[more.length - 1]?.scrollIntoView({ block: 'start' });
}

// ====================================================================
// FEYNMAN mode (讲给 AI 听)
// Explain in your own words → "小明" asks about vague spots → score →
// gaps become flashcards that go into the spaced-repetition queue.
// ====================================================================

const plain = s => String(s || '').replace(/\*\*/g, '').trim();

function feynmanContext(ref) {
  if (ref.kind === 'source') {
    const src = S.sources.find(s => s.id === ref.id);
    if (!src) return null;
    const cards = S.cards.filter(c => c.sourceId === src.id).slice(0, 150);
    return {
      subject: src.subject,
      topic: src.title,
      reference: `【${src.title}】\n要点：\n${src.summary}\n\n${src.lesson ? `讲解：\n${src.lesson.sections.map(sec => `■ ${sec.heading}\n${sec.explain}`).join('\n\n')}\n\n` : ''}闪卡：\n${cards.map(c => `- ${c.front} → ${c.back}`).join('\n')}`,
    };
  }
  if (ref.kind === 'card') {
    const c = S.cards.find(x => x.id === ref.id);
    if (!c) return null;
    if (c.problemId) return feynmanContext({ kind: 'problem', id: c.problemId });
    if (c.type === 'word') {
      return {
        subject: c.subject,
        topic: `${c.word}（${c.ja}）的意思和用法`,
        reference: `${c.word}（${c.pos}）：${c.ja}／${c.zh}\n例句：${c.ex}\n搭配：${c.colloc}\n近义词：${c.syn}`,
      };
    }
    const src = c.sourceId && S.sources.find(s => s.id === c.sourceId);
    const back = plain(c.back);
    return {
      subject: c.subject,
      topic: back.length <= 30 ? back : plain(c.front),
      reference: `问：${c.front}\n答：${c.back}${c.note ? `\n备注：${c.note}` : ''}${src ? `\n\n所属资料「${src.title}」要点：\n${src.summary}` : ''}`,
    };
  }
  if (ref.kind === 'problem') {
    const p = S.problems.find(x => x.id === ref.id);
    if (!p) return null;
    const a = p.analysis;
    return {
      subject: p.subject,
      topic: a ? `${plain(a.pattern)}：为什么这样解` : p.title,
      reference: a ? [
        `题目：${a.problemText}`, `解法の型：${a.pattern}`, `识别信号：${a.trigger}`, `核心思路：${a.keyIdea}`,
        `第一步：${a.firstStep}`, `步骤：\n${(a.steps || []).map((st, i) => `${i + 1}. ${st.title}：${st.detail}`).join('\n')}`,
        `答案：${a.answer}`,
      ].join('\n') : '',
    };
  }
  return { subject: ref.subject, topic: ref.topic, reference: '' };
}

async function putFey(f) { await db.put('feynman', f); upsert(S.feynman, f); }

const sameRef = (a, b) => a.kind === b.kind && a.id && a.id === b.id;

function feyPrevBest(f) {
  const scores = S.feynman.filter(x => x.id !== f.id && x.result && (sameRef(x.ref, f.ref) || x.topic === f.topic)).map(x => x.result.score);
  return scores.length ? Math.max(...scores) : null;
}

async function startFeynman(ref, extra = {}) {
  const ctx = feynmanContext(ref);
  if (!ctx) return toast('找不到这个内容');
  const reuse = ref.kind !== 'free' && !extra.prevId && S.feynman.find(x => !x.result && !x.chat.length && sameRef(x.ref, ref));
  const f = reuse || {
    id: uid(), ref: { kind: ref.kind, id: ref.id || null }, subject: ctx.subject, topic: ctx.topic,
    reference: ctx.reference, chat: [], result: null, created: Date.now(), ...extra,
  };
  await putFey(f);
  closeModal();
  go('fey/' + f.id);
}

async function viewFeynmanList() {
  const hist = [...S.feynman].filter(f => f.result || f.chat.length).sort((a, b) => b.created - a.created);
  const srcs = [...S.sources].sort((a, b) => b.created - a.created).slice(0, 5);
  const probs = S.problems.filter(p => p.analysis).sort((a, b) => weakness(b.srs) - weakness(a.srs)).slice(0, 3);
  const scoreTag = f => f.result ? `<b class="fey-pill" style="--sc:${scoreColor(f.result.score)}">${f.result.score}</b>` : '<span class="muted small">未评分</span>';
  setView(`
    <button class="back" data-act="nav" data-to="review">‹ 复习</button>
    <h2>🗣 费曼模式</h2>
    <div class="card small">
      <b>能讲给别人听，才是真的懂了。</b><br>
      ① 合上资料，用自己的话讲给“小明”（AI 扮演的初中生）听<br>
      ② 小明会追问你讲不清楚的地方<br>
      ③ 评分，指出漏掉的、讲错的要点<br>
      ④ 漏洞自动做成闪卡，按遗忘曲线复习，然后再讲一遍
    </div>
    <button class="btn primary block" data-act="feyNew">＋ 自己定一个主题</button>
    ${srcs.length || probs.length ? `<h3 class="sec">推荐讲这些</h3><div class="list">
      ${srcs.map(s => `<button class="li" data-act="feyStart" data-kind="source" data-id="${s.id}" style="--c:${SUBJ[s.subject].color}">
        <span class="dot"></span><span class="li-t">${s.kind === 'lesson' ? '📖' : '📄'} ${esc(s.title)}</span><span class="muted small">讲 ›</span></button>`).join('')}
      ${probs.map(p => `<button class="li" data-act="feyStart" data-kind="problem" data-id="${p.id}" style="--c:${SUBJ[p.subject].color}">
        <span class="dot"></span><span class="li-t">✏️ ${esc(p.title)}<br><small class="muted">讲清楚为什么这样解</small></span><span class="muted small">讲 ›</span></button>`).join('')}
    </div>` : ''}
    <h3 class="sec">记录</h3>
    <div class="list">${hist.length ? hist.map(f => `<button class="li" data-act="nav" data-to="fey/${f.id}" style="--c:${SUBJ[f.subject].color}">
        <span class="dot"></span><span class="li-t">${esc(f.topic)}<br><small class="muted">${todayKey(f.created).slice(5)} · ${SUBJ[f.subject].name}</small></span>${scoreTag(f)}</button>`).join('')
      : '<div class="empty">还没有记录。挑一份资料讲讲看吧！</div>'}</div>
  `);
}

function scoreColor(n) {
  return n >= 80 ? 'var(--good)' : n >= 60 ? 'var(--warn)' : 'var(--bad)';
}

async function viewFey(id) {
  const f = S.feynman.find(x => x.id === id);
  if (!f) return go('feynman');
  if (f.result) return renderFeyResult(f);
  const s = SUBJ[f.subject];
  const hasKey = !!S.settings.apiKey;
  const empty = !f.chat.length;
  const prev = f.prevId && S.feynman.find(x => x.id === f.prevId);
  const best = feyPrevBest(f);
  setView(`
    <button class="back" data-act="nav" data-to="feynman">‹ 费曼模式</button>
    ${empty ? `
      <label class="lbl">${s.icon} ${s.name} · 要讲的主题（可以改得更具体）</label>
      <input data-fey-topic value="${esc(f.topic)}">
      ${hasKey ? `<label class="toggle"><input type="checkbox" data-fey-stretch ${feyStretch(f) ? 'checked' : ''}>
        <span>🔭 允许拓展问题<br><small class="muted">小明偶尔会问超出考试范围、但能加深理解的问题（标「🔭拓展」，不计分）。答不上来就点“直接告诉我”。</small></span></label>` : ''}` : `<h2>${esc(f.topic)}</h2><div class="muted small">${s.icon} ${s.name}${best != null ? ` · 之前最高 ${best} 分` : ''}</div>`}
    ${empty ? `<div class="card small">
      📕 <b>先合上资料。</b>用自己的话讲，就像讲给初中生听：<br>
      · 少用术语，用了就解释它是什么意思<br>
      · 讲“为什么”，不只是讲结论<br>
      · 最好举一个例子或打个比方<br>
      🎤 长段文字可以用键盘上的语音输入。
    </div>` : ''}
    ${prev?.result ? `<details class="card"><summary>🎯 上次 ${prev.result.score} 分，这次要补上的漏洞</summary>
      ${md([...prev.result.missing, ...prev.result.wrong.map(w => w.fix)].map(x => '- ' + x).join('\n'))}</details>` : ''}
    <div class="chat" id="chat">
      ${f.chat.map(feyBubble).join('')}
    </div>
    ${!empty && hasKey && f.chat.at(-1).role === 'assistant' && f.chat.at(-1).who !== 'teacher' ? `<div class="quick">
      <button class="chip hot" data-act="feyTeacher" data-id="${f.id}">🔍 我不知道，直接告诉我</button>
      ${['跳过这个问题', '这个超纲了 / プリント上没有'].map(q => `<button class="chip" data-act="feyQuick" data-id="${f.id}" data-q="${q}">${q}</button>`).join('')}</div>` : ''}
    <textarea id="fey-in" rows="${empty ? 7 : 3}" placeholder="${empty ? '开始讲吧：「○○是……，因为……，比如……」' : '回答小明的问题，或者继续讲'}"></textarea>
    <div class="stack">
      ${hasKey ? `<button class="btn primary block" data-act="feySend" data-id="${f.id}">${empty ? '🗣 讲给小明听' : '发送'}</button>
        ${empty ? '' : `<button class="btn block" data-act="feyEval" data-id="${f.id}">📝 结束并评分</button>`}`
      : `<button class="btn primary block" data-act="feyManual" data-id="${f.id}">🆓 免费评分（复制提示词到 ChatGPT 等）</button>
        <div class="muted small">没有 API Key 时，小明不能追问，但可以把你的讲解拿去免费评分。</div>`}
    </div>
  `);
  if (!empty) document.getElementById('chat').lastElementChild?.scrollIntoView({ block: 'end' });
}

const feyStretch = f => f.stretch ?? S.settings.feyStretch ?? true;

function feyBubble(m) {
  const who = m.role === 'user' ? '' : m.who === 'teacher' ? '<div class="who">👩‍🏫 老师</div>' : '<div class="who">🧒 小明</div>';
  return `<div class="bubble ${m.role} ${m.who || ''}">${who}${md(m.text)}</div>`;
}

function feyMessages(f) {
  const out = [];
  f.chat.forEach((m, i) => {
    let text = i === 0 ? `（我要给你讲「${f.topic}」）\n${m.text}` : m.text;
    if (m.who === 'teacher') text = `【老师的解说（不是小明说的）】\n${m.text}`;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + text;
    else out.push({ role: m.role, content: text });
  });
  return out;
}

const feyTranscript = f => f.chat.map(m => `${m.role === 'user' ? '讲解者' : m.who === 'teacher' ? '老师' : '小明'}：${m.text}`).join('\n\n');

// Takes what's typed into the box (and the edited topic on the first turn).
async function feyTakeInput(f) {
  const topicEl = document.querySelector('[data-fey-topic]');
  if (topicEl && topicEl.value.trim()) f.topic = topicEl.value.trim();
  const stretchEl = document.querySelector('[data-fey-stretch]');
  if (stretchEl) {
    f.stretch = stretchEl.checked;
    S.settings.feyStretch = stretchEl.checked;
    saveSettings();
  }
  const text = (document.getElementById('fey-in')?.value || '').trim();
  if (text) {
    f.chat.push({ role: 'user', text });
    addXP(5);
  }
  await putFey(f);
  return text;
}

async function feySend(id) {
  const f = S.feynman.find(x => x.id === id);
  if (!f || busy) return;
  if (!(document.getElementById('fey-in')?.value || '').trim()) return toast('先讲点什么吧');
  busy = true;
  await feyTakeInput(f);
  await viewFey(id);
  const chatEl = document.getElementById('chat');
  chatEl.insertAdjacentHTML('beforeend', '<div class="bubble assistant typing"><i></i><i></i><i></i></div>');
  chatEl.lastElementChild.scrollIntoView({ block: 'end' });
  try {
    const system = AI.feynmanStudentSystem({ subject: SUBJ[f.subject], topic: f.topic, reference: f.reference, stretch: feyStretch(f), settings: S.settings });
    const reply = await AI.chat(S.settings, system, feyMessages(f));
    f.chat.push({ role: 'assistant', text: reply });
    await putFey(f);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    busy = false;
  }
  header();
  if (location.hash === '#/fey/' + id) viewFey(id);
}

async function feyTeacher(id) {
  const f = S.feynman.find(x => x.id === id);
  if (!f || busy) return;
  busy = true;
  const chatEl = document.getElementById('chat');
  chatEl.insertAdjacentHTML('beforeend', '<div class="bubble assistant teacher typing"><i></i><i></i><i></i></div>');
  chatEl.lastElementChild.scrollIntoView({ block: 'end' });
  try {
    const { system, user } = AI.feynmanTeacherPrompt({ subject: SUBJ[f.subject], topic: f.topic, reference: f.reference, transcript: feyTranscript(f), settings: S.settings });
    const text = await AI.chat(S.settings, system, [{ role: 'user', content: user }], 'medium');
    f.chat.push({ role: 'assistant', who: 'teacher', text });
    await putFey(f);
    addXP(1);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    busy = false;
  }
  if (location.hash === '#/fey/' + id) viewFey(id);
}

function feyEvalPromptFor(f) {
  return AI.feynmanEvalPrompt({ subject: SUBJ[f.subject], topic: f.topic, reference: f.reference, transcript: feyTranscript(f), settings: S.settings });
}

async function feyEval(id) {
  const f = S.feynman.find(x => x.id === id);
  if (!f || busy) return;
  await feyTakeInput(f);
  if (!f.chat.some(m => m.role === 'user')) return toast('先讲点什么吧');
  busy = true;
  const done = aiOverlay('AI 正在评分、找漏洞…');
  try {
    const r = await AI.generateJSON(S.settings, feyEvalPromptFor(f), [], 'feynman', 'medium');
    await applyFeyResult(f, r);
  } catch (e) {
    alertBox('出错了', e.message);
  } finally {
    done();
    busy = false;
  }
}

async function feyManual(id) {
  const f = S.feynman.find(x => x.id === id);
  if (!f) return;
  await feyTakeInput(f);
  if (!f.chat.some(m => m.role === 'user')) return toast('先把你的讲解写在框里');
  modalData.prompt = AI.manualPrompt(feyEvalPromptFor(f), 'feynman');
  modal(`<h3>🆓 免费评分</h3>
    <ol class="small"><li>复制提示词（里面已经包含你的讲解）</li><li>打开 ChatGPT / Gemini / Claude App，新对话里粘贴发送（不用附照片）</li><li>复制 AI 的完整回复，粘贴到下面</li></ol>
    <button class="btn primary block" data-act="copyPrompt">📋 复制提示词</button>
    <textarea id="manual-json" rows="6" placeholder="把 AI 的回复粘贴到这里"></textarea>
    <button class="btn primary block" data-act="importFey" data-id="${f.id}">导入</button>`);
}

async function applyFeyResult(f, r) {
  if (typeof r.score !== 'number' || !Array.isArray(r.cards)) throw new Error('格式不对：没有 score / cards');
  r.score = Math.max(0, Math.min(100, Math.round(r.score)));
  for (const k of ['covered', 'missing', 'wrong']) r[k] = Array.isArray(r[k]) ? r[k] : [];
  f.result = r;
  f.evaluatedAt = Date.now();
  await putFey(f);
  const xp = 10 + Math.round(r.score / 10);
  addXP(xp);
  toast(`+${xp} XP 讲解完成`);
  if (location.hash === '#/fey/' + f.id) route(); else go('fey/' + f.id);
}

async function renderFeyResult(f) {
  const r = f.result;
  const s = SUBJ[f.subject];
  const prev = f.prevId && S.feynman.find(x => x.id === f.prevId)?.result;
  const list = (arr) => md(arr.map(x => '- ' + x).join('\n'));
  const on = r.cards.filter(c => !c._off).length;
  setView(`
    <button class="back" data-act="nav" data-to="feynman">‹ 费曼模式</button>
    <h2>${esc(f.topic)}</h2>
    <div class="muted small">${s.icon} ${s.name}</div>
    <div class="card fey-score">
      <div class="ring" style="--p:${r.score / 100}; --rc:${scoreColor(r.score)}"><div><b>${r.score}</b><small>分</small></div></div>
      <div>${prev ? `<div class="small muted">上次 ${prev.score} 分 → 这次 ${r.score} 分 ${r.score > prev.score ? '📈' : ''}</div>` : ''}${md(r.verdict)}</div>
    </div>
    ${r.covered.length ? `<div class="card"><h4>✅ 讲对了</h4>${list(r.covered)}</div>` : ''}
    ${r.missing.length ? `<div class="card"><h4>❌ 漏掉的要点</h4>${list(r.missing)}</div>` : ''}
    ${r.wrong.length ? `<div class="card"><h4>⚠️ 讲错的地方</h4>${r.wrong.map(w => `<div class="fey-wrong"><div class="muted">${md('✗ ' + w.point)}</div><div>${md('✓ ' + w.fix)}</div></div>`).join('')}</div>` : ''}
    ${r.simpler ? `<div class="card"><h4>💡 更简单的讲法</h4>${md(r.simpler)}</div>` : ''}
    ${r.cards.length ? `<div class="card"><h4>📌 补漏闪卡</h4>
      ${f.cardsAdded ? '<div class="small">✅ 已加入复习，会按遗忘曲线出现。</div>' : '<div class="muted small">点卡片可以取消勾选。</div>'}
      ${r.cards.map((c, i) => `<div class="fc ${c._off ? 'off' : ''}" ${f.cardsAdded ? '' : `data-act="feyToggleCard" data-id="${f.id}" data-i="${i}"`}>
        <span class="fc-box">${c._off ? '☐' : '☑'}</span><div><div class="pv-f">${md(c.front)}</div><div class="pv-b">${md(c.back)}</div>${c.note ? `<div class="muted small">${md(c.note)}</div>` : ''}</div></div>`).join('')}
      ${f.cardsAdded ? '' : `<button class="btn primary block" data-act="feyAddCards" data-id="${f.id}" ${on ? '' : 'disabled'}>加入复习（${on} 张）</button>`}
    </div>` : ''}
    <details class="card"><summary>💬 讲解记录</summary>${f.chat.map(feyBubble).join('')}</details>
    ${f.reference ? `<details class="card"><summary>📖 回去看资料（费曼第3步）</summary>${md(f.reference)}</details>` : ''}
    <div class="stack">
      <button class="btn primary block" data-act="feyAgain" data-id="${f.id}">🔁 再讲一遍（补上漏洞、讲得更简单）</button>
      <button class="btn danger ghost small" data-act="feyDel" data-id="${f.id}">删除这条记录</button>
    </div>
  `);
}

// ====================================================================
// WRITING (英作文：要約・意見論述)
// ====================================================================

const SCORE_LABELS = { content: '内容', structure: '構成', vocabulary: '語彙', grammar: '文法' };

async function allTasks() {
  return [...WRITING_TASKS, ...(await db.getMeta('customTasks', []))];
}

async function findTask(id) {
  return (await allTasks()).find(t => t.id === id);
}

function essayBest(taskId) {
  const xs = S.essays.filter(e => e.taskId === taskId && e.result);
  return xs.length ? Math.max(...xs.map(e => e.result.total)) : null;
}

function taskPromptText(task) {
  return task.type === 'summary' ? task.passage : `TOPIC: ${task.topic}\nPOINTS: ${task.points.join(' / ')}`;
}

async function viewWriting() {
  const tasks = await allTasks();
  const row = t => {
    const best = essayBest(t.id);
    return `<button class="li" data-act="nav" data-to="essay/${t.id}" style="--c:${SUBJ.write.color}">
      <span class="dot"></span><span class="li-t">${esc(t.title)}${t.custom ? ' <span class="tag">自己添加</span>' : ''}<br><small class="muted">${esc(t.type === 'summary' ? '要約 · 60〜70 词' : t.topic)}</small></span>
      ${best != null ? `<b class="fey-pill" style="--sc:${scoreColor(best / 16 * 100)}">${best}/16</b>` : '<span class="muted small">未写</span>'}</button>`;
  };
  setView(`
    <button class="back" data-act="nav" data-to="review">‹ 复习</button>
    <h2>✍️ 英作文</h2>
    <div class="card small">
      <b>写作大约占一次考试分数的 1/3</b>，也是最容易靠练习提分的部分。<br>
      · <b>要約</b>：把约 200 词的文章用自己的话缩写成 <b>60〜70 词</b><br>
      · <b>意見論述</b>：就 TOPIC 写 <b>120〜150 词</b>，从 POINTS 里选 <b>2 个</b>作为理由<br>
      · 评分：内容・構成・語彙・文法，各 4 分<br>
      写完可以让 AI 批改（需要 API Key），也可以复制后发到 Claude 聊天里批改。题目都是原创的；过去问的题目可以自己添加。
    </div>
    <h3 class="sec">要約</h3><div class="list">${tasks.filter(t => t.type === 'summary').map(row).join('')}</div>
    <h3 class="sec">意見論述</h3><div class="list">${tasks.filter(t => t.type === 'opinion').map(row).join('')}</div>
    <button class="btn block" data-act="taskNew">＋ 添加过去问或其他题目</button>
  `);
}

async function viewEssay(taskId) {
  const task = await findTask(taskId);
  if (!task) return go('writing');
  const R = WRITING_RULES[task.type];
  const draftE = S.essays.find(e => e.taskId === task.id && !e.result);
  const hist = S.essays.filter(e => e.taskId === task.id && e.result).sort((a, b) => b.created - a.created);
  const hasKey = !!S.settings.apiKey;
  setView(`
    <button class="back" data-act="nav" data-to="writing">‹ 英作文</button>
    <h2>${esc(task.title)}</h2>
    <div class="muted small">${R.label} · ${R.min}〜${R.max} 词 · 建议用时 ${R.minutes} 分钟</div>
    <div class="card essay-task">
      <div class="small muted">${esc(R.instruction)}</div>
      ${task.type === 'summary'
        ? `<div class="passage">${md(task.passage)}</div>`
        : `<div class="kp"><span>TOPIC</span><b>${esc(task.topic)}</b></div>
           <div class="kp"><span>POINTS</span><div class="tags">${task.points.map(p => `<span class="tag">${esc(p)}</span>`).join('')}</div></div>`}
    </div>
    <div class="essay-bar"><span id="wc" class="wc">0 词</span>
      <button class="btn small" data-act="essayTimer" data-min="${R.minutes}">⏱ <span id="etimer">开始计时</span></button></div>
    <textarea id="essay-in" rows="12" placeholder="在这里用英文写…" data-task="${task.id}" data-min="${R.min}" data-max="${R.max}"
      autocapitalize="sentences" spellcheck="false">${esc(draftE?.text || '')}</textarea>
    <div class="stack">
      ${hasKey ? `<button class="btn primary block" data-act="essayGrade" data-id="${task.id}">🤖 AI 批改</button>` : ''}
      <button class="btn block" data-act="essayManual" data-id="${task.id}">🆓 复制批改提示词（ChatGPT 等）</button>
      <button class="btn ghost block" data-act="essayCopy" data-id="${task.id}">📋 复制题目和作文（发到 Claude 聊天里批改）</button>
    </div>
    ${hist.length ? `<h3 class="sec">批改记录</h3><div class="list">${hist.map(e => `
      <button class="li" data-act="nav" data-to="essayr/${e.id}" style="--c:${SUBJ.write.color}">
        <span class="dot"></span><span class="li-t">${todayKey(e.gradedAt || e.created).slice(5).replace('-', '/')} · ${e.wc} 词<br><small class="muted">${esc(e.result.verdict)}</small></span>
        <b class="fey-pill" style="--sc:${scoreColor(e.result.total / 16 * 100)}">${e.result.total}/16</b></button>`).join('')}</div>` : ''}
    ${task.custom ? `<button class="btn danger ghost small" data-act="taskDel" data-id="${task.id}">删除这道题</button>` : ''}
  `);
  updateWordCount();
}

function updateWordCount() {
  const t = document.getElementById('essay-in');
  const el = document.getElementById('wc');
  if (!t || !el) return;
  const n = countWords(t.value);
  const min = +t.dataset.min;
  const max = +t.dataset.max;
  el.textContent = `${n} 词（${min}〜${max}）`;
  el.className = 'wc ' + (n === 0 ? '' : n < min ? 'low' : n > max ? 'high' : 'ok');
}

async function saveEssayDraft(taskId, text) {
  let e = S.essays.find(x => x.taskId === taskId && !x.result);
  if (!e) e = { id: uid(), taskId, text: '', result: null, created: Date.now() };
  e.text = text;
  e.updated = Date.now();
  await putEssay(e);
  return e;
}

function essayInput(taskId) {
  const text = (document.getElementById('essay-in')?.value || '').trim();
  return { text, wc: countWords(text) };
}

async function essayGrade(taskId) {
  if (busy) return;
  const task = await findTask(taskId);
  const { text, wc } = essayInput(taskId);
  if (wc < 20) return toast('至少写 20 个词再批改吧');
  busy = true;
  const done = aiOverlay('阅卷老师正在批改…');
  try {
    const r = await AI.generateJSON(S.settings, AI.essayPrompt({ task, text, wordCount: wc, settings: S.settings }), [], 'essay', 'medium');
    await applyEssayResult(task, text, wc, r);
  } catch (e) {
    alertBox('出错了', e.message);
  } finally {
    done();
    busy = false;
  }
}

async function applyEssayResult(task, text, wc, r) {
  clearTimeout(document.getElementById('essay-in')?._deb); // don't let a pending autosave recreate the draft
  const sc = r?.scores;
  if (!sc || !['content', 'structure', 'vocabulary', 'grammar'].every(k => typeof sc[k] === 'number')) throw new Error('格式不对：没有 scores');
  for (const k of Object.keys(SCORE_LABELS)) sc[k] = Math.max(0, Math.min(4, Math.round(sc[k])));
  r.total = sc.content + sc.structure + sc.vocabulary + sc.grammar;
  for (const k of ['good', 'issues', 'phrases']) r[k] = Array.isArray(r[k]) ? r[k] : [];
  const e = await saveEssayDraft(task.id, text);
  Object.assign(e, { result: r, wc, type: task.type, title: task.title, gradedAt: Date.now() });
  await putEssay(e);
  addXP(10 + r.total);
  toast(`+${10 + r.total} XP 批改完成`);
  go('essayr/' + e.id);
}

async function viewEssayResult(id) {
  const e = S.essays.find(x => x.id === id);
  if (!e?.result) return go('writing');
  const r = e.result;
  const R = WRITING_RULES[e.type] || WRITING_RULES.opinion;
  setView(`
    <button class="back" data-act="nav" data-to="essay/${e.taskId}">‹ ${esc(e.title || '英作文')}</button>
    <h2>${esc(e.title || '英作文')}</h2>
    <div class="muted small">${R.label} · ${e.wc} 词（${R.min}〜${R.max}）· ${todayKey(e.gradedAt).slice(5).replace('-', '/')}</div>
    <div class="card fey-score">
      <div class="ring" style="--p:${r.total / 16}; --rc:${scoreColor(r.total / 16 * 100)}"><div><b>${r.total}</b><small>/16</small></div></div>
      <div>${md(r.verdict)}</div>
    </div>
    <div class="card">
      ${Object.entries(SCORE_LABELS).map(([k, label]) => `<div class="hbar score"><span>${label}</span><div><i style="width:${r.scores[k] / 4 * 100}%"></i></div><b>${r.scores[k]}/4</b></div>`).join('')}
    </div>
    ${r.good.length ? `<div class="card"><h4>👍 做得好的地方</h4>${md(r.good.map(x => '- ' + x).join('\n'))}</div>` : ''}
    ${r.issues.length ? `<div class="card"><h4>🛠 要改的地方</h4>${r.issues.map(x => `
      <div class="fey-wrong"><span class="tag">${esc(x.category)}</span>
        <div class="muted">✗ ${esc(x.original)}</div><div>✓ ${esc(x.fixed)}</div><div class="small">${md(x.why)}</div></div>`).join('')}</div>` : ''}
    <div class="card"><h4>📝 修改后的范文 ${sayBtn(r.improved)}</h4><div class="passage">${md(r.improved)}</div>
      <div class="muted small">${countWords(r.improved)} 词</div></div>
    ${r.phrases.length ? `<div class="card"><h4>📌 值得背的表达</h4>
      ${r.phrases.map(p => `<div class="w-kv"><span>${esc(p.ja)}</span><b>${esc(p.en)}</b></div>`).join('')}
      ${e.phrasesAdded ? '<div class="small">✅ 已加入闪卡</div>' : `<button class="btn primary block" data-act="essayPhrases" data-id="${e.id}">加入闪卡（${r.phrases.length} 张）</button>`}
    </div>` : ''}
    <details class="card"><summary>我的原文</summary><div class="passage">${md(e.text)}</div></details>
    <div class="stack">
      <button class="btn primary block" data-act="nav" data-to="essay/${e.taskId}">✍️ 参考范文，再写一遍</button>
    </div>
  `);
}

// ====================================================================
// SHEETS (纸上问题): questions the student writes and answers on paper.
// The app only keeps the schedule: how many times, when next, what's due.
// ====================================================================

const DEFAULT_STEPS = [1, 7, 14, 30, 60];
const RESULT = { ok: { mark: '○', label: '全对' }, half: { mark: '△', label: '有错' }, bad: { mark: '×', label: '大部分错' } };
const sheetsUI = { tab: 'today', tag: 'all', undo: null };

const sheetSteps = () => (Array.isArray(S.settings.sheetSteps) && S.settings.sheetSteps.length ? S.settings.sheetSteps : DEFAULT_STEPS);
const sheetAttempts = x => (x.history || []).length;
const shortDate = key => key.slice(5).split('-').map(Number).join('/');

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return todayKey(new Date(y, m - 1, d + n).getTime());
}

async function putSheet(x) { await db.put('sheets', x); upsert(S.sheets, x); }

// Next date for an interval; with an exam date set, nothing is pushed past
// the day before the exam, so every sheet gets one last pass in time.
function nextDue(fromKey, days) {
  let due = addDays(fromKey, days);
  const exam = S.settings.sheetExam;
  if (exam) {
    const last = addDays(exam, -1);
    if (fromKey < last && due > last) due = last;
  }
  return due;
}

// ○ moves to the next (longer) interval, △ repeats the same interval,
// × starts again from the first one. Passing the last interval = mastered.
function recordSheet(x, result) {
  const t = todayKey();
  x.history = [...(x.history || []), { date: t, result }];
  if (result === 'ok') x.stage = (x.stage || 0) + 1;
  else if (result === 'bad') x.stage = 0;
  const days = sheetSteps()[x.stage || 0];
  x.done = days == null;
  x.due = x.done ? null : nextDue(t, days);
}

function dueLabel(x) {
  if (x.done) return '<span class="due done">✅ 已掌握</span>';
  const d = daysUntil(x.due);
  if (d < 0) return `<span class="due late">逾期 ${-d} 天</span>`;
  if (d === 0) return '<span class="due today">今天</span>';
  if (d === 1) return '<span class="due">明天</span>';
  return `<span class="due">${shortDate(x.due)}（${d} 天后）</span>`;
}

const historyDots = x => (x.history || []).slice(-8).map(h => `<i class="hd ${h.result}">${RESULT[h.result].mark}</i>`).join('');

function sheetRow(x, withButtons) {
  return `<div class="sheet-row">
    <button class="sheet-main" data-act="sheetOpen" data-id="${x.id}">
      <b>${esc(x.title)}</b>${x.tag ? ` <span class="tag">${esc(x.tag)}</span>` : ''}
      <small>${x.done ? '' : `第 ${sheetAttempts(x) + 1} 次 · `}${dueLabel(x)} ${historyDots(x)}</small>
    </button>
    ${withButtons ? `<div class="sheet-btns">${Object.entries(RESULT).map(([r, v]) => `<button class="sb ${r}" data-act="sheetRec" data-id="${x.id}" data-r="${r}" aria-label="${v.label}">${v.mark}</button>`).join('')}</div>` : ''}
  </div>`;
}

function sheetForecast(active) {
  const t = todayKey();
  const days = [];
  for (let i = 0; i < 14; i++) {
    const k = addDays(t, i);
    const n = active.filter(x => !x.done && x.due && (i === 0 ? x.due <= k : x.due === k)).length;
    days.push({ k, n });
  }
  const max = Math.max(5, ...days.map(d => d.n));
  return `<div class="card week">${days.map((d, i) => `<div class="wk"><div class="wk-bar"><i style="height:${d.n / max * 100}%"></i></div><small>${i === 0 ? '今' : Number(d.k.slice(8))}</small><small class="muted">${d.n || ''}</small></div>`).join('')}</div>`;
}

async function viewSheets() {
  const t = todayKey();
  const all = S.sheets.filter(x => !x.archived);
  const tags = [...new Set(all.map(x => x.tag).filter(Boolean))].sort();
  if (sheetsUI.tag !== 'all' && !tags.includes(sheetsUI.tag)) sheetsUI.tag = 'all';
  const active = all.filter(x => sheetsUI.tag === 'all' || x.tag === sheetsUI.tag);
  const due = active.filter(x => !x.done && x.due <= t).sort((a, b) => a.due.localeCompare(b.due));
  const late = due.filter(x => x.due < t).length;
  const doneToday = all.filter(x => (x.history || []).some(h => h.date === t)).length;
  const u = sheetsUI.undo;
  let list = '';
  if (sheetsUI.tab === 'today') {
    list = due.length ? due.map(x => sheetRow(x, true)).join('')
      : `<div class="empty">${all.length ? '🎉 今天的纸上问题都做完了！' : '还没有登记。做好一张题目纸，就点上面的“＋ 登记”。'}</div>`;
  } else if (sheetsUI.tab === 'all') {
    const xs = active.filter(x => !x.done).sort((a, b) => a.due.localeCompare(b.due));
    list = xs.length ? xs.map(x => sheetRow(x, false)).join('') : '<div class="empty">没有进行中的题目。</div>';
  } else {
    const xs = active.filter(x => x.done);
    list = xs.length ? xs.map(x => sheetRow(x, false)).join('') : '<div class="empty">还没有“已掌握”的题目。最后一个间隔也全对，就会到这里。</div>';
  }
  const steps = sheetSteps();
  setView(`
    <div class="sheets-head"><h2>📝 纸上问题</h2><button class="btn primary small" data-act="sheetNew">＋ 登记</button></div>
    <div class="muted small">题目和答案写在纸上，App 帮你记住每张做了几次、下次哪天做。今天已经做了 ${doneToday} 张。</div>
    ${u ? `<div class="card undo-bar"><span>${u.msg}</span><button class="btn small" data-act="sheetUndo">撤销</button></div>` : ''}
    ${tags.length ? `<div class="chips"><button class="chip ${sheetsUI.tag === 'all' ? 'on' : ''}" data-act="sheetTag" data-tag="all">全部</button>${tags.map(g => `<button class="chip ${sheetsUI.tag === g ? 'on' : ''}" data-act="sheetTag" data-tag="${esc(g)}">${esc(g)}</button>`).join('')}</div>` : ''}
    <div class="seg">
      <button class="${sheetsUI.tab === 'today' ? 'on' : ''}" data-act="sheetTab" data-tab="today">今天要做（${due.length}）</button>
      <button class="${sheetsUI.tab === 'all' ? 'on' : ''}" data-act="sheetTab" data-tab="all">进行中</button>
      <button class="${sheetsUI.tab === 'done' ? 'on' : ''}" data-act="sheetTab" data-tab="done">已掌握</button>
    </div>
    ${sheetsUI.tab === 'today' && late ? `<div class="muted small">⚠️ 有 ${late} 张逾期了，排在最前面，先做它们。</div>` : ''}
    ${sheetsUI.tab === 'today' && due.length ? '<div class="muted small">做完一张，按结果点：<b>○ 全对</b>（进入下一个更长的间隔）／<b>△ 有错</b>（同样的间隔再来一次）／<b>× 大部分错</b>（1 天后重新开始）</div>' : ''}
    <div class="sheet-list">${list}</div>
    ${all.length ? `<h3 class="sec">接下来 14 天要做的张数</h3>${sheetForecast(all)}` : ''}
    <details class="card"><summary>⚙️ 间隔设置</summary>
      <label class="lbl">复习间隔（天，用逗号分隔）</label>
      <input id="ss-steps" value="${steps.join(', ')}" inputmode="numeric">
      <div class="muted small">现在：做好题目后 ${steps[0]} 天第一次做，之后全对就依次隔 ${steps.slice(1).join('、')} 天，最后一次也全对就算“已掌握”。你以前的做法是 1, 7, 14。</div>
      <label class="lbl">考试日期（可选）</label>
      <input id="ss-exam" type="date" value="${esc(S.settings.sheetExam || '')}">
      <div class="muted small">设了考试日期后，原本会排到考试之后的题，会提前到考试前一天，保证考前每张都再做一遍。</div>
      <button class="btn block" data-act="sheetSettings">保存设置</button>
    </details>
  `);
}

async function sheetDetail(id) {
  const x = S.sheets.find(s => s.id === id);
  if (!x) return;
  const steps = sheetSteps();
  const nextGap = x.done ? null : steps[x.stage || 0];
  modal(`
    <h3>${esc(x.title)}</h3>
    <div class="muted small">${x.tag ? `${esc(x.tag)} · ` : ''}登记于 ${shortDate(todayKey(x.created))} · 做过 ${sheetAttempts(x)} 次</div>
    ${x.photoId ? await imgsHTML([x.photoId]) : ''}
    ${x.note ? `<div class="note">${md(x.note)}</div>` : ''}
    <div class="card small">${x.done ? '✅ 已掌握，不会再出现。想继续练就点下面的“重新开始”。' : `下次：${dueLabel(x)}（第 ${(x.stage || 0) + 1} 个间隔：${nextGap} 天）`}</div>
    ${(x.history || []).length ? `<h4>做题记录</h4><div class="hist">${x.history.map((h, i) => `<div class="kv"><span>第 ${i + 1} 次 · ${shortDate(h.date)}</span><b class="hd ${h.result}">${RESULT[h.result].mark} ${RESULT[h.result].label}</b></div>`).join('')}</div>` : ''}
    <h4>${x.done ? '' : '记录这次的结果'}</h4>
    ${x.done ? '' : `<div class="sheet-btns big">${Object.entries(RESULT).map(([r, v]) => `<button class="sb ${r}" data-act="sheetRec" data-id="${x.id}" data-r="${r}">${v.mark} ${v.label}</button>`).join('')}</div>
    <div class="muted small">没到日子提前做了也可以记录。</div>`}
    <label class="lbl">标题</label><input id="sd-title" value="${esc(x.title)}">
    <label class="lbl">分类</label><input id="sd-tag" value="${esc(x.tag || '')}" list="sheet-tags">${tagDatalist()}
    <label class="lbl">备注</label><textarea id="sd-note" rows="2">${esc(x.note || '')}</textarea>
    ${x.done ? '' : `<label class="lbl">手动改下次日期</label><input id="sd-due" type="date" value="${x.due}">`}
    <div class="stack">
      <button class="btn primary block" data-act="sheetSave" data-id="${x.id}">保存修改</button>
      <button class="btn block" data-act="sheetRestart" data-id="${x.id}">重新开始（从第 1 个间隔）</button>
      <button class="btn danger ghost block" data-act="sheetDel" data-id="${x.id}">删除</button>
    </div>`);
}

function tagDatalist() {
  const tags = [...new Set(S.sheets.map(x => x.tag).filter(Boolean))];
  return `<datalist id="sheet-tags">${tags.map(t => `<option value="${esc(t)}">`).join('')}</datalist>`;
}

function sheetNewModal() {
  modalData.sheetPhoto = null;
  const steps = sheetSteps();
  modal(`
    <h3>＋ 登记纸上问题</h3>
    <div class="muted small">一张题目纸（或一组题）登记成一条。今天做好，${steps[0]} 天后第一次做。</div>
    <label class="lbl">标题</label>
    <input id="sn-title" placeholder="例：英検 句動詞 ①、化学 第3章 Q1–10">
    <label class="lbl">分类（可选）</label>
    <input id="sn-tag" placeholder="例：英検、化学、公共" list="sheet-tags" value="${esc(sheetsUI.tag !== 'all' ? sheetsUI.tag : '')}">${tagDatalist()}
    <label class="lbl">张数</label>
    <input id="sn-count" type="number" min="1" max="50" value="1" inputmode="numeric">
    <div class="muted small">一次做了好几张时填张数，会自动编号成「标题 #1」「标题 #2」…</div>
    <label class="lbl">照片（可选，拍下题目纸方便认出是哪张）</label>
    <div class="row"><label class="btn"><input type="file" accept="image/*" capture="environment" data-file="sheetPhoto" hidden>📷 拍照</label>
      <label class="btn"><input type="file" accept="image/*" data-file="sheetPhoto" hidden>🖼 相册</label></div>
    <div id="sn-photo"></div>
    <label class="lbl">备注（可选）</label>
    <textarea id="sn-note" rows="2" placeholder="例：放在蓝色文件夹里"></textarea>
    <button class="btn primary block" data-act="sheetCreate">登记</button>`);
}

// ====================================================================
// 周期表练习 (化学基礎)
// ====================================================================

// look: tap to see each element / where: find the cell / name: which element is this cell?
const pt = { mode: 'look', range: 'key', sel: null, q: null, score: 0, total: 0, miss: [] };
const ptEl = sym => ELEMENTS.find(e => e.sym === sym);
const ptPool = () => (pt.range === '20' ? PT_TARGETS.filter(x => ptEl(x).z <= 20) : PT_TARGETS);

function ptNewQuestion() {
  const pool = ptPool();
  const last = pt.q?.sym;
  const misses = pt.miss.filter(x => pool.includes(x) && x !== last);
  let sym;
  do {
    sym = misses.length && Math.random() < 0.4 ? misses[Math.floor(Math.random() * misses.length)] : pool[Math.floor(Math.random() * pool.length)];
  } while (sym === last && pool.length > 1);
  const q = { sym, picked: null };
  if (pt.mode === 'name') {
    const e = ptEl(sym);
    // wrong answers from neighbours make it about the position, not luck
    const near = shuffle(pool.filter(x => x !== sym)).sort((a, b) => {
      const A = ptEl(a), B = ptEl(b);
      return (Math.abs(A.group - e.group) + Math.abs(A.period - e.period)) - (Math.abs(B.group - e.group) + Math.abs(B.period - e.period));
    });
    q.choices = shuffle([sym, ...near.slice(0, 3)]);
  }
  pt.q = q;
}

function ptAnswer(sym) {
  const q = pt.q;
  if (!q || q.picked) return;
  q.picked = sym;
  pt.total++;
  if (sym === q.sym) {
    pt.score++;
    pt.miss = pt.miss.filter(x => x !== q.sym);
    addXP(1);
    header();
  } else if (!pt.miss.includes(q.sym)) {
    pt.miss.push(q.sym);
  }
  viewPtable();
}

function ptLabel(e) {
  return `${e.z ? `${e.z} ` : ''}<b>${esc(e.sym)}</b> ${esc(e.name)}`;
}

function viewPtable() {
  if (pt.mode !== 'look' && !pt.q) ptNewQuestion();
  const q = pt.mode === 'look' ? null : pt.q;
  const done = q?.picked != null;
  const cell = e => {
    const c = PT_CATS[e.cat].color;
    let cls = 'pt-cell';
    let txt = e.z ? e.sym : '※';
    if (pt.mode === 'look') {
      if (pt.sel === e.sym) cls += ' sel';
    } else if (pt.mode === 'where') {
      txt = done && (e.sym === q.sym || e.sym === q.picked) ? txt : '';
      if (done && e.sym === q.sym) cls += ' ok';
      else if (done && e.sym === q.picked) cls += ' ng';
    } else if (e.sym === q.sym) {
      cls += done ? (q.picked === q.sym ? ' ok' : ' ng') : ' ask';
      txt = done ? e.sym : '?';
    }
    return `<button class="${cls}" style="--cc:${c};grid-column:${e.group};grid-row:${e.period + 1}" data-act="ptCell" data-sym="${esc(e.sym)}" aria-label="${esc(e.name)}">${txt}</button>`;
  };
  const heads = Array.from({ length: 18 }, (_, i) => `<span class="pt-g" style="grid-column:${i + 1};grid-row:1">${i + 1}</span>`).join('');
  const sel = pt.mode === 'look' && pt.sel ? ptEl(pt.sel) : null;
  const target = q ? ptEl(q.sym) : null;
  let panel = '';
  if (pt.mode === 'look') {
    panel = sel ? `<div class="pt-info" style="--cc:${PT_CATS[sel.cat].color}">
        <div class="pt-big">${ptLabel(sel)}</div>
        <div class="small">${sel.z ? `第${sel.period}周期・${sel.group}族 · ` : ''}${PT_CATS[sel.cat].name}</div>
        ${sel.memo ? `<div class="note">${esc(sel.memo)}</div>` : ''}</div>`
      : '<div class="pt-info muted small">点一个元素看名字、族・周期和要记的点。</div>';
  } else if (pt.mode === 'where') {
    panel = `<div class="pt-info"><div class="pt-big">${esc(target.name)}（${esc(target.sym)}）在哪里？</div>
      ${done ? `<div class="small">${q.picked === q.sym ? '⭕ 正确！' : `❌ 你点的是 ${ptLabel(ptEl(q.picked))}`} · 第${target.period}周期・${target.group}族（${PT_CATS[target.cat].name}）</div>${target.memo ? `<div class="note">${esc(target.memo)}</div>` : ''}` : '<div class="muted small">在表里点出它的位置</div>'}</div>`;
  } else {
    panel = `<div class="pt-info"><div class="pt-big">“?” 的位置是哪个元素？</div>
      <div class="choices pt-choices">${q.choices.map((x, i) => {
        const e = ptEl(x);
        const st = done ? (x === q.sym ? 'ok' : x === q.picked ? 'ng' : 'dim') : '';
        return `<button class="choice ${st}" data-act="ptPick" data-sym="${esc(x)}" ${done ? 'disabled' : ''}><b>${i + 1}</b>${esc(e.name)}（${esc(e.sym)}）</button>`;
      }).join('')}</div>
      ${done ? `<div class="small">第${target.period}周期・${target.group}族（${PT_CATS[target.cat].name}）</div>${target.memo ? `<div class="note">${esc(target.memo)}</div>` : ''}` : ''}</div>`;
  }
  setView(`
    <button class="back" data-act="nav" data-to="review">‹ 复习</button>
    <h2>🧪 周期表练习</h2>
    <div class="seg small">
      <button class="${pt.mode === 'look' ? 'on' : ''}" data-act="ptMode" data-mode="look">👀 看表</button>
      <button class="${pt.mode === 'where' ? 'on' : ''}" data-act="ptMode" data-mode="where">📍 找位置</button>
      <button class="${pt.mode === 'name' ? 'on' : ''}" data-act="ptMode" data-mode="name">❓ 认元素</button>
    </div>
    ${pt.mode === 'look' ? '' : `<div class="row pt-bar">
      <div class="chips"><button class="chip ${pt.range === '20' ? 'on' : ''}" data-act="ptRange" data-r="20">1–20 号</button><button class="chip ${pt.range === 'key' ? 'on' : ''}" data-act="ptRange" data-r="key">重要元素 ${PT_TARGETS.length} 个</button></div>
      <span class="small">${pt.score}/${pt.total}${pt.miss.length ? ` · 错过 ${pt.miss.length}` : ''}</span></div>`}
    <div class="pt-grid">${heads}${ELEMENTS.map(cell).join('')}</div>
    ${panel}
    ${q && done ? '<button class="btn primary block big" data-act="ptNext">下一个 →</button>' : ''}
    ${pt.mode === 'look' ? `<div class="pt-legend">${Object.values(PT_CATS).map(c => `<span style="--cc:${c.color}"><i></i>${c.name}</span>`).join('')}</div>
    <div class="card small">
      <b>1〜20 号的口诀</b>：水兵リーベ僕の船 七曲がりシップスクラークか<br>
      H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca<br>
      <span class="muted">现在的教科书：3〜12 族＝遷移元素，2 族全部＝アルカリ土類金属（包括 Be・Mg），18 族＝貴ガス。</span>
    </div>` : ''}
  `);
}

// ====================================================================
// SETTINGS
// ====================================================================

async function viewSettings() {
  const st = S.settings;
  let persisted = false;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* ignore */ }
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  setView(`
    <h2>⚙️ 设置</h2>
    ${standalone ? '' : `<div class="card warn">📲 <b>还没添加到主屏幕</b>：在 Safari 点底部的“分享”按钮 → “添加到主屏幕”，就会像普通 App 一样全屏打开，数据也更不容易被清掉。</div>`}

    <div class="card">
      <h4>📅 考试日期（英検 一次試験）</h4>
      <div class="muted small">默认是 2026年度第3回（本会场）的 1/24，请在英検官网确认后修改。</div>
      ${examSubjects('eiken').map(s => `<div class="kv"><span>${s.icon} ${s.name}</span><input type="date" data-exam="${s.id}" value="${st.exams[s.id] || ''}"></div>`).join('')}
      <button class="btn small" data-act="sameDate">英検各部分设成同一天</button>
    </div>

    <div class="card">
      <h4>📅 考试日期（共通テスト）</h4>
      <div class="muted small">2028 年 1 月的日程还没公布，先按往年（1 月中旬的周六・周日，理科在第 2 天）设成 1/16。大学入試センター公布后请修改。</div>
      ${examSubjects('kyotsu').map(s => `<div class="kv"><span>${s.icon} ${s.name}</span><input type="date" data-exam="${s.id}" value="${st.exams[s.id] || ''}"></div>`).join('')}
    </div>

    <div class="card">
      <h4>🤖 AI（Claude）</h4>
      <label class="lbl">API Key</label>
      <input type="password" id="api-key" placeholder="sk-ant-..." value="${esc(st.apiKey)}" autocomplete="off">
      <div class="row"><button class="btn primary" data-act="saveKey">保存</button><button class="btn" data-act="testKey">测试</button></div>
      <details><summary class="small">怎么获取？要钱吗？</summary><div class="small">
        1. 用浏览器打开 <b>console.anthropic.com</b>，注册登录。<br>
        2. Billing 里充值。建议先充 10 美元，用两三天后在 Console 的 Usage 里看花了多少，不够再补。<br>
        大约费用（Opus 5.5；选 Sonnet 5.5 约一半）：导入 2 页プリント 15–30 日元，解析一道错题 15–40 日元，AI 辅导每轮对话 3–6 日元，一次费曼讲解 15–30 日元。<br>
        建议关掉 Auto-reload（自动续充），避免多扣钱。<br>
        3. API Keys → Create Key，复制粘贴到上面。<br>
        Key 只保存在你的手机里，只发送给 Anthropic 官方 API。<br>
        不想花钱：导入时用“🆓 免费：复制提示词”，配合免费的 Claude App 也能做卡和解析（AI 辅导聊天需要 Key）。
      </div></details>
      <label class="lbl">模型</label>
      <select data-set="model">${AI.MODELS.map(m => `<option value="${m.id}" ${m.id === st.model ? 'selected' : ''}>${m.name}</option>`).join('')}</select>
      <label class="lbl">讲解语言</label>
      <select data-set="lang"><option value="zh" ${st.lang === 'zh' ? 'selected' : ''}>中文讲解（术语保留日语）</option><option value="ja" ${st.lang === 'ja' ? 'selected' : ''}>日本語</option></select>
      <div class="muted small">单词卡同时显示日语和中文意思；讲解、提示和作文批改的评语用这里选的语言。</div>
    </div>

    <div class="card">
      <h4>🎯 每日目标</h4>
      <div class="kv"><span>每天复习张数</span><input type="number" min="10" max="500" step="10" data-set-num="dailyGoal" value="${st.dailyGoal}"></div>
      <label class="toggle"><input type="checkbox" data-set-bool="autoSpeak" ${st.autoSpeak ? 'checked' : ''}><span>🔊 单词卡自动发音<br><small class="muted">出现单词时自动读出来（iPhone 静音模式下没有声音）</small></span></label>
    </div>

    <div class="card">
      <h4>💾 数据</h4>
      <div class="muted small">闪卡 ${S.cards.length} · 错题 ${S.problems.length} · 资料 ${S.sources.length} · 存储保护：${persisted ? '✅ 已开启' : '未开启'}</div>
      <div class="row wrap">
        <button class="btn" data-act="exportData">导出备份</button>
        <label class="btn"><input type="file" accept="application/json,.json" data-file="import" hidden>导入备份</label>
        ${persisted ? '' : '<button class="btn" data-act="persist">开启存储保护</button>'}
      </div>
      <div class="muted small">数据只存在这台手机的这个 App 里。偶尔导出一份备份（存到“文件”App）比较安心。</div>
      <button class="btn danger ghost small" data-act="wipe">清空全部数据</button>
    </div>
    <div class="muted small center">StudyQuest v1 · 祝考试顺利 🍀</div>
  `);
}

// ====================================================================
// modal / alerts
// ====================================================================

const modalData = {};
function modal(html) {
  const el = document.getElementById('modal');
  el.innerHTML = `<div class="sheet"><button class="sheet-x" data-act="closeModal">✕</button>${html}</div>`;
  el.classList.add('show');
  renderMath(el);
}
function closeModal() {
  document.getElementById('modal').classList.remove('show');
}
function alertBox(title, msg) {
  modal(`<h3>${esc(title)}</h3><p>${esc(msg)}</p><button class="btn primary block" data-act="closeModal">好</button>`);
}

// ====================================================================
// actions
// ====================================================================

const acts = {
  nav: d => { closeModal(); go(d.to); },
  back: () => history.length > 1 ? history.back() : go('home'),
  closeModal,
  zoom: d => {
    const b = imgCache.get(d.id);
    if (!b) return;
    const el = document.getElementById('viewer');
    el.innerHTML = `<img src="${blobURL(d.id, b)}" data-act="zoomToggle"><button class="sheet-x" data-act="closeViewer">✕</button>`;
    el.classList.add('show');
  },
  zoomToggle: (d, t) => t.classList.toggle('big'),
  closeViewer: () => document.getElementById('viewer').classList.remove('show'),

  // home / review
  startToday: () => startSession('today'),
  startMode: d => startSession(d.mode, d.sid || null),
  subjectMenu: d => subjectMenu(d.sid),
  addFor: d => { closeModal(); draft = newDraft(d.sid); go('add'); },

  // add
  pickSubject: d => {
    const keep = draft;
    draft = { ...newDraft(d.sid), photos: keep.photos, solPhotos: keep.solPhotos, note: keep.note };
    if (keep.mode === 'lesson') draft.mode = 'lesson';
    viewAdd();
  },
  setMode: d => { draft.mode = d.mode; viewAdd(); },
  setKind: d => { draft.sourceKind = d.kind; viewAdd(); },
  toggleReason: d => { draft.reason = draft.reason.includes(d.r) ? draft.reason.filter(x => x !== d.r) : [...draft.reason, d.r]; viewAdd(); },
  rmPhoto: d => { draft[d.key].splice(+d.i, 1); viewAdd(); },
  runAI,
  manualAI,
  copyPrompt: async () => toast(await copyText(modalData.prompt) ? '已复制，去 Claude App 粘贴吧' : '复制失败，请手动选择'),
  importManual: d => {
    try {
      const data = AI.parseLooseJSON(document.getElementById('manual-json').value);
      if (modalData.existingProblem) {
        const p = S.problems.find(x => x.id === modalData.existingProblem);
        modalData.existingProblem = null;
        closeModal();
        applyAnalysis(p, data);
        return;
      }
      if (d.schema === 'lesson') {
        closeModal();
        return saveLesson(data).catch(e => toast('解析失败：' + e.message, 4000));
      }
      if ((d.schema === 'cards' || d.schema === 'chemcards') && !Array.isArray(data.cards)) throw new Error('格式不对：没有 cards');
      if (d.schema === 'words' && !Array.isArray(data.words)) throw new Error('格式不对：没有 words');
      if (d.schema === 'problem' && !data.pattern) throw new Error('格式不对：没有 pattern');
      draft.preview = data;
      closeModal();
      go('add');
    } catch (e) {
      toast('解析失败：' + e.message, 4000);
    }
  },
  pvDel: d => { const c = (draft.preview.words || draft.preview.cards)[+d.i]; c._del = !c._del; viewPreview(); },
  savePreview,
  discardPreview: () => { draft.preview = null; viewAdd(); },
  saveRawProblem,
  manualCard: () => editCard(null),

  // session
  flip: () => { session.flipped = true; viewSession(); },
  grade: d => grade(+d.g),
  probHint: () => { session.hint++; viewSession(); },
  probReveal: () => { session.phase = 'reveal'; viewSession(); },
  endSession: () => { if (session.results.length) sessionDone(); else { session = null; go('review'); } },
  openProblemFromSession: d => go('problem/' + d.id),
  tutorFromSession: d => go('tutor/' + d.id),
  studySource: d => {
    const items = shuffle(S.cards.filter(c => c.sourceId === d.id)).map(c => ({ kind: 'card', id: c.id }));
    session = { ...buildSession('cards'), title: '资料复习', items };
    go('session');
  },

  // library
  libSubject: d => { closeModal(); lib.subject = d.sid; go('lib'); },
  libTab: d => { lib.tab = d.tab; viewLib(); },
  editCard: d => editCard(d.id),
  saveCard: async d => {
    const front = document.getElementById('ec-f').value.trim();
    const back = document.getElementById('ec-b').value.trim();
    if (!front || !back) return toast('正面和背面都要填');
    const old = S.cards.find(c => c.id === d.id);
    const c = old ? { ...old } : { id: uid(), type: 'qa', importance: 2, srs: newSrs(), created: Date.now() };
    Object.assign(c, { front, back, note: document.getElementById('ec-n').value.trim(), subject: document.getElementById('ec-sub').value });
    if (c.type === 'word') Object.assign(c, { word: front, ja: back });
    await putCard(c);
    closeModal();
    toast('已保存');
    if (!old) addXP(1);
    route();
  },
  resetCard: async d => { const c = S.cards.find(x => x.id === d.id); c.srs = newSrs(); await putCard(c); closeModal(); route(); },
  delCard: async d => {
    if (!confirm('删除这张卡？')) return;
    await db.del('cards', d.id);
    S.cards = S.cards.filter(c => c.id !== d.id);
    closeModal();
    route();
  },
  delSource: async d => {
    if (!confirm('删除这份资料和它的所有卡片？')) return;
    const src = S.sources.find(s => s.id === d.id);
    for (const c of S.cards.filter(c => c.sourceId === d.id)) await db.del('cards', c.id);
    for (const i of src.imageIds || []) await db.del('images', i);
    await db.del('sources', d.id);
    S.cards = S.cards.filter(c => c.sourceId !== d.id);
    S.sources = S.sources.filter(s => s.id !== d.id);
    go('lib');
  },

  // problem
  analyzeExisting: d => analyzeExisting(d.id),
  reanalyze: d => { closeModal(); analyzeExisting(d.id); },
  manualExisting: d => {
    const p = S.problems.find(x => x.id === d.id);
    const prompt = AI.problemPrompt({ subject: SUBJ[p.subject], ref: p.ref, note: p.note, reason: (p.reason || []).join('、'),
      hasSolution: !!p.solutionImageIds?.length, settings: S.settings });
    modal(`<h3>🆓 免费方式</h3>
      <ol class="small"><li>复制提示词</li><li>在 Claude App 里附上这道题（和解答页）的照片，粘贴发送</li><li>把回复粘贴到下面</li></ol>
      <button class="btn primary block" data-act="copyPrompt">📋 复制提示词</button>
      <textarea id="manual-json" rows="6" placeholder="把 AI 的回复粘贴到这里"></textarea>
      <button class="btn primary block" data-act="importManual" data-schema="problem">导入</button>`);
    modalData.prompt = AI.manualPrompt(prompt, 'problem');
    modalData.existingProblem = p.id;
  },
  makeVariant: d => makeVariant(d.id),
  variantResult: async d => {
    const p = S.problems.find(x => x.id === d.id);
    p.srs = schedule(p.srs, d.ok === '1' ? 2 : 0, daysTo(p.subject));
    await putProblem(p);
    addXP(d.ok === '1' ? 12 : 4, { review: true, correct: d.ok === '1', problem: true });
    toast(d.ok === '1' ? '+12 XP 漂亮！' : '+4 XP 错了也没关系，系统会很快再让你练');
    header();
  },
  tutorVariant: d => {
    const p = S.problems.find(x => x.id === d.id);
    const v = p.variants[+d.i];
    go('tutor/' + p.id);
    setTimeout(() => tutorSend(p.id,
      `我们来做这道类题，请像之前一样一步步引导我（先别给答案）：\n${v.problem}\n（给老师的参考答案，不要直接告诉我：${v.answer}；步骤：${v.steps.join(' / ')}）`,
      `我们来做这道类题：\n${v.problem}`), 50);
  },
  editProblem: d => editProblem(d.id),
  saveProblemEdit: async d => {
    const p = S.problems.find(x => x.id === d.id);
    p.title = document.getElementById('ep-title').value.trim() || p.title;
    p.ref = document.getElementById('ep-ref').value.trim();
    if (p.analysis) document.querySelectorAll('#modal textarea[data-k]').forEach(t => { p.analysis[t.dataset.k] = t.value; });
    await putProblem(p);
    if (p.analysis) await putCard(methodCardFor(p));
    closeModal();
    route();
  },
  resetProblem: async d => { const p = S.problems.find(x => x.id === d.id); p.srs = newSrs(); await putProblem(p); toast('已重置'); route(); },
  delProblem: async d => {
    if (!confirm('删除这道错题？')) return;
    const p = S.problems.find(x => x.id === d.id);
    for (const i of [...(p.imageIds || []), ...(p.solutionImageIds || [])]) await db.del('images', i);
    for (const c of S.cards.filter(c => c.problemId === d.id)) await db.del('cards', c.id);
    await db.del('problems', d.id);
    S.cards = S.cards.filter(c => c.problemId !== d.id);
    S.problems = S.problems.filter(x => x.id !== d.id);
    go('lib');
  },

  // tutor
  tutorSend: d => tutorSend(d.id),

  // sheets
  sheetNew: () => sheetNewModal(),
  sheetTab: d => { sheetsUI.tab = d.tab; viewSheets(); },
  sheetTag: d => { sheetsUI.tag = d.tag; viewSheets(); },
  sheetOpen: d => sheetDetail(d.id),
  sheetCreate: async () => {
    const title = document.getElementById('sn-title').value.trim();
    if (!title) return toast('写一个标题吧');
    const tag = document.getElementById('sn-tag').value.trim();
    const note = document.getElementById('sn-note').value.trim();
    const n = Math.max(1, Math.min(50, +document.getElementById('sn-count').value || 1));
    const photoId = modalData.sheetPhoto ? (await saveImages([modalData.sheetPhoto]))[0] : null;
    const now = Date.now();
    const due = nextDue(todayKey(), sheetSteps()[0]);
    for (let i = 0; i < n; i++) {
      await putSheet({ id: uid(), title: n > 1 ? `${title} #${i + 1}` : title, tag, note, photoId, stage: 0, due, done: false, history: [], created: now + i });
    }
    modalData.sheetPhoto = null;
    closeModal();
    addXP(2 * n);
    toast(`已登记 ${n} 张，${shortDate(due)} 第一次做`);
    sheetsUI.tab = 'all';
    route();
  },
  sheetRec: async d => {
    const x = S.sheets.find(s => s.id === d.id);
    const before = JSON.parse(JSON.stringify(x));
    recordSheet(x, d.r);
    await putSheet(x);
    addXP({ ok: 5, half: 3, bad: 2 }[d.r], { review: true, correct: d.r === 'ok' });
    const next = x.done ? '🎓 已掌握！' : `下次 ${shortDate(x.due)}（${daysUntil(x.due)} 天后）`;
    sheetsUI.undo = { before, msg: `已记录「${esc(x.title)}」${RESULT[d.r].mark} → ${next}` };
    closeModal();
    header();
    if (location.hash === '#/sheets') viewSheets(); else go('sheets');
  },
  sheetUndo: async () => {
    const u = sheetsUI.undo;
    if (!u) return;
    await putSheet(u.before);
    sheetsUI.undo = null;
    toast('已撤销');
    viewSheets();
  },
  sheetSave: async d => {
    const x = S.sheets.find(s => s.id === d.id);
    x.title = document.getElementById('sd-title').value.trim() || x.title;
    x.tag = document.getElementById('sd-tag').value.trim();
    x.note = document.getElementById('sd-note').value.trim();
    const due = document.getElementById('sd-due')?.value;
    if (due) x.due = due;
    await putSheet(x);
    closeModal();
    toast('已保存');
    viewSheets();
  },
  sheetRestart: async d => {
    const x = S.sheets.find(s => s.id === d.id);
    Object.assign(x, { stage: 0, done: false, due: nextDue(todayKey(), sheetSteps()[0]) });
    await putSheet(x);
    closeModal();
    toast(`已重新开始，${shortDate(x.due)} 做`);
    viewSheets();
  },
  sheetDel: async d => {
    if (!confirm('删除这条记录？（纸本身当然还在 😄）')) return;
    const x = S.sheets.find(s => s.id === d.id);
    if (x.photoId && !S.sheets.some(s => s.id !== x.id && s.photoId === x.photoId)) await db.del('images', x.photoId);
    await db.del('sheets', d.id);
    S.sheets = S.sheets.filter(s => s.id !== d.id);
    closeModal();
    viewSheets();
  },
  sheetSettings: async () => {
    const steps = document.getElementById('ss-steps').value.split(/[^0-9]+/).map(Number).filter(n => n > 0);
    if (!steps.length) return toast('至少要有一个间隔');
    S.settings.sheetSteps = steps;
    S.settings.sheetExam = document.getElementById('ss-exam').value || '';
    await saveSettings();
    toast('已保存（之后记录的结果按新设置排）');
    viewSheets();
  },

  // 周期表
  ptMode: d => { pt.mode = d.mode; pt.q = null; pt.sel = null; viewPtable(); },
  ptRange: d => { pt.range = d.r; pt.q = null; viewPtable(); },
  ptCell: d => {
    if (pt.mode === 'look') { pt.sel = pt.sel === d.sym ? null : d.sym; viewPtable(); return; }
    if (pt.mode === 'where' && d.sym !== 'La-Lu') ptAnswer(d.sym);
  },
  ptPick: d => ptAnswer(d.sym),
  ptNext: () => { ptNewQuestion(); viewPtable(); },

  // words
  say: d => speak(d.t),
  quizPick: d => {
    const q = session?.quiz;
    if (!q || q.picked != null) return;
    q.picked = q.choices[+d.i];
    q.ms = Date.now() - q.t0;
    const it = curItem();
    if (it?.obj.type === 'word' && (S.settings.autoSpeak || q.picked !== (it.obj.form || it.obj.word))) speak(it.obj.word);
    viewSession();
  },

  // writing
  essayGrade: d => essayGrade(d.id),
  essayTimer: d => {
    const t0 = Date.now();
    const limit = +d.min * 60;
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      const el = document.getElementById('etimer');
      if (!el) return clearInterval(timerHandle);
      const sec = Math.floor((Date.now() - t0) / 1000);
      el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} / ${d.min}:00`;
      el.classList.toggle('late', sec > limit);
    }, 500);
  },
  essayManual: async d => {
    const task = await findTask(d.id);
    const { text, wc } = essayInput(d.id);
    if (wc < 20) return toast('至少写 20 个词再批改吧');
    await saveEssayDraft(task.id, text);
    modalData.prompt = AI.manualPrompt(AI.essayPrompt({ task, text, wordCount: wc, settings: S.settings }), 'essay');
    modal(`<h3>🆓 免费批改</h3>
      <ol class="small"><li>复制提示词（已经包含题目和你的作文）</li><li>打开 ChatGPT / Gemini / Claude App，新对话里粘贴发送</li><li>复制 AI 的完整回复，粘贴到下面</li></ol>
      <button class="btn primary block" data-act="copyPrompt">📋 复制提示词</button>
      <textarea id="manual-json" rows="6" placeholder="把 AI 的回复粘贴到这里"></textarea>
      <button class="btn primary block" data-act="importEssay" data-id="${task.id}">导入</button>`);
  },
  importEssay: async d => {
    const task = await findTask(d.id);
    const { text, wc } = essayInput(d.id);
    try {
      const r = AI.parseLooseJSON(document.getElementById('manual-json').value);
      closeModal();
      await applyEssayResult(task, text, wc, r);
    } catch (e) {
      toast('解析失败：' + e.message, 4000);
    }
  },
  essayCopy: async d => {
    const task = await findTask(d.id);
    const R = WRITING_RULES[task.type];
    const { text, wc } = essayInput(d.id);
    if (!wc) return toast('先写点什么吧');
    await saveEssayDraft(task.id, text);
    const msg = `【英検準1級 ${R.label}（${R.min}〜${R.max} 词）】
${R.instruction}

${taskPromptText(task)}

【我的答案】（${wc} 词）
${text}

请按英検準1級的标准（内容・構成・語彙・文法 各 4 分）批改。`;
    toast(await copyText(msg) ? '已复制，粘贴到 Claude 聊天里就行' : '复制失败，请手动选择');
  },
  essayPhrases: async d => {
    const e = S.essays.find(x => x.id === d.id);
    const now = Date.now();
    const cards = e.result.phrases.map((p, i) => ({
      id: uid(), subject: 'write', type: 'qa', front: p.ja, back: p.en, note: `来自作文「${e.title}」的范文`,
      importance: 3, srs: newSrs(), created: now + i,
    }));
    await db.putMany('cards', cards);
    S.cards.push(...cards);
    e.phrasesAdded = true;
    await putEssay(e);
    addXP(cards.length);
    toast(`已加入 ${cards.length} 张表达卡`);
    viewEssayResult(e.id);
  },
  taskNew: () => modal(`
    <h3>＋ 添加题目</h3>
    <label class="lbl">题型</label>
    <select id="tn-type"><option value="opinion">意見論述（120〜150 词）</option><option value="summary">要約（60〜70 词）</option></select>
    <label class="lbl">标题（例：2025年度第1回）</label><input id="tn-title">
    <label class="lbl">意見論述：TOPIC</label><input id="tn-topic" placeholder="Should ... ?">
    <label class="lbl">意見論述：POINTS（用逗号分隔）</label><input id="tn-points" placeholder="Cost, Safety, Environment, Convenience">
    <label class="lbl">要約：原文</label><textarea id="tn-passage" rows="5"></textarea>
    <button class="btn primary block" data-act="taskSave">保存</button>`),
  taskSave: async () => {
    const type = document.getElementById('tn-type').value;
    const title = document.getElementById('tn-title').value.trim() || (type === 'summary' ? '要約' : '意見論述');
    const task = { id: 'custom-' + uid(), type, title, custom: true };
    if (type === 'summary') {
      task.passage = document.getElementById('tn-passage').value.trim();
      if (countWords(task.passage) < 50) return toast('原文太短了');
    } else {
      task.topic = document.getElementById('tn-topic').value.trim();
      task.points = document.getElementById('tn-points').value.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
      if (!task.topic) return toast('写一下 TOPIC');
    }
    await db.setMeta('customTasks', [...await db.getMeta('customTasks', []), task]);
    closeModal();
    go('essay/' + task.id);
  },
  taskDel: async d => {
    if (!confirm('删除这道题？（批改记录会保留）')) return;
    await db.setMeta('customTasks', (await db.getMeta('customTasks', [])).filter(t => t.id !== d.id));
    go('writing');
  },

  // feynman
  feyStart: d => startFeynman({ kind: d.kind, id: d.id }),
  feyNew: () => modal(`
    <h3>🗣 自己定一个主题</h3>
    <label class="lbl">科目</label>
    <select id="fn-sub">${SUBJECTS.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
    <label class="lbl">主题（越具体越好）</label>
    <input id="fn-topic" placeholder="例：法の支配と人の支配の違い / 酸化還元反応 / 等差数列の和の公式の導き方">
    <button class="btn primary block" data-act="feyCreateFree">开始</button>`),
  feyCreateFree: () => {
    const topic = document.getElementById('fn-topic').value.trim();
    if (!topic) return toast('写一个主题');
    return startFeynman({ kind: 'free', subject: document.getElementById('fn-sub').value, topic });
  },
  lessonNext: async d => {
    const src = S.sources.find(s => s.id === d.id);
    src.step = (src.step || 0) + 1;
    await putSource(src);
    const finished = src.step >= src.lesson.sections.length;
    addXP(finished ? 10 : 3);
    if (finished) toast('🎉 补完一节！+10 XP');
    header();
    await viewLesson(src);
  },
  lessonMore: d => lessonMore(d.id),
  packImport: async d => {
    const idx = await fetchJSON(PACK_INDEX);
    const entry = (idx.packs || []).find(p => p.id === d.id);
    if (!entry) return toast('找不到这个卡包');
    await runPackImports([entry]);
  },
  packImportAll: async () => {
    const imported = await db.getMeta('importedPacks', []);
    const idx = await fetchJSON(PACK_INDEX);
    await runPackImports((idx.packs || []).filter(p => !imported.includes(p.id)));
  },
  packPaste: () => {
    let data;
    try {
      data = AI.parseLooseJSON(document.getElementById('pack-json').value);
    } catch (e) {
      return toast('JSON 解析失败：' + e.message, 4000);
    }
    return runPackImports(Array.isArray(data.packs) ? data.packs : [data]);
  },
  lessonReset: async d => {
    const src = S.sources.find(s => s.id === d.id);
    src.step = 0;
    await putSource(src);
    viewLesson(src);
  },
  feySend: d => feySend(d.id),
  feyTeacher: d => feyTeacher(d.id),
  feyQuick: d => {
    const input = document.getElementById('fey-in');
    input.value = d.q;
    return feySend(d.id);
  },
  feyEval: d => feyEval(d.id),
  feyManual: d => feyManual(d.id),
  importFey: async d => {
    const f = S.feynman.find(x => x.id === d.id);
    try {
      const r = AI.parseLooseJSON(document.getElementById('manual-json').value);
      closeModal();
      await applyFeyResult(f, r);
    } catch (e) {
      toast('解析失败：' + e.message, 4000);
    }
  },
  feyToggleCard: d => {
    const f = S.feynman.find(x => x.id === d.id);
    const c = f.result.cards[+d.i];
    c._off = !c._off;
    putFey(f);
    renderFeyResult(f);
  },
  feyAddCards: async d => {
    const f = S.feynman.find(x => x.id === d.id);
    const srcCard = f.ref.kind === 'card' && S.cards.find(c => c.id === f.ref.id);
    const sourceId = f.ref.kind === 'source' ? f.ref.id : srcCard?.sourceId;
    const now = Date.now();
    const cards = f.result.cards.filter(c => !c._off).map((c, i) => ({
      id: uid(), subject: f.subject, type: 'qa', front: c.front, back: c.back, note: c.note || '', importance: 3,
      ...(sourceId ? { sourceId } : {}), feynmanId: f.id, srs: newSrs(), created: now + i,
    }));
    await db.putMany('cards', cards);
    S.cards.push(...cards);
    f.cardsAdded = true;
    await putFey(f);
    addXP(cards.length * 2);
    toast(`已加入 ${cards.length} 张，会按遗忘曲线出现`);
    header();
    renderFeyResult(f);
  },
  feyAgain: d => {
    const f = S.feynman.find(x => x.id === d.id);
    return startFeynman(f.ref.kind === 'free' ? { kind: 'free', subject: f.subject, topic: f.topic } : f.ref,
      { prevId: f.id, topic: f.topic, reference: f.reference, subject: f.subject, stretch: f.stretch });
  },
  feyDel: async d => {
    if (!confirm('删除这条讲解记录？（已加入复习的卡片会保留）')) return;
    await db.del('feynman', d.id);
    S.feynman = S.feynman.filter(x => x.id !== d.id);
    go('feynman');
  },
  quickSay: d => tutorSend(d.id, d.q),
  rmAttach: () => { tutorAttach = null; document.getElementById('attach-prev').innerHTML = ''; },
  clearChat: async d => {
    if (!confirm('清空对话？')) return;
    const p = S.problems.find(x => x.id === d.id);
    p.chat = [];
    await putProblem(p);
    route();
  },

  // settings
  saveKey: async () => { S.settings.apiKey = document.getElementById('api-key').value.trim(); await saveSettings(); toast('已保存'); },
  testKey: async () => {
    S.settings.apiKey = document.getElementById('api-key').value.trim();
    await saveSettings();
    const done = aiOverlay('正在测试…');
    try {
      const r = await AI.testKey(S.settings);
      alertBox('✅ 可以用了', 'AI 回复：' + r);
    } catch (e) {
      alertBox('❌ 不行', e.message);
    } finally { done(); }
  },
  sameDate: async () => {
    const v = document.querySelector('[data-exam]')?.value;
    if (!v) return;
    examSubjects('eiken').forEach(s => { S.settings.exams[s.id] = v; });
    await saveSettings();
    route();
  },
  exportData: async () => {
    const done = aiOverlay('正在打包…');
    try {
      const data = await exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const name = `studyquest-backup-${todayKey()}.json`;
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
      }
    } catch (e) {
      if (e.name !== 'AbortError') alertBox('导出失败', e.message);
    } finally { done(); }
  },
  persist: async () => {
    const ok = await navigator.storage?.persist?.();
    toast(ok ? '已开启' : '浏览器没有同意（添加到主屏幕后再试）');
    route();
  },
  wipe: async () => {
    if (!confirm('真的要清空全部闪卡、错题和记录吗？（API Key 和考试日期保留）')) return;
    if (!confirm('再确认一次：不可恢复！')) return;
    for (const s of ['cards', 'problems', 'images', 'sources', 'feynman', 'essays', 'sheets']) await db.clear(s);
    S.cards = []; S.problems = []; S.sources = []; S.feynman = []; S.essays = []; S.sheets = [];
    S.stats = { xp: 0, streak: 0, lastDay: null, days: {} };
    await saveStats();
    go('home');
  },
};

// ====================================================================
// events
// ====================================================================

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t || !t.dataset.act || t.disabled) return;
  const fn = acts[t.dataset.act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve(fn({ ...t.dataset }, t)).catch(err => alertBox('出错了', err.message || String(err)));
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.bind && draft) draft[t.dataset.bind] = t.value;
  if (t.dataset.bindLib) {
    lib[t.dataset.bindLib] = t.value;
    clearTimeout(t._deb);
    t._deb = setTimeout(async () => {
      const pos = t.selectionStart;
      await viewLib();
      const n = document.querySelector('[data-bind-lib]');
      n.focus();
      n.setSelectionRange(pos, pos);
    }, 300);
  }
  if (t.id === 'essay-in') {
    updateWordCount();
    clearTimeout(t._deb);
    t._deb = setTimeout(() => saveEssayDraft(t.dataset.task, t.value), 600);
  }
  if (t.id === 'tutor-in') {
    t.style.height = 'auto';
    t.style.height = Math.min(140, t.scrollHeight) + 'px';
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.exam) { S.settings.exams[t.dataset.exam] = t.value; await saveSettings(); }
  if (t.dataset.set) { S.settings[t.dataset.set] = t.value; await saveSettings(); toast('已保存'); }
  if (t.dataset.setNum) { S.settings[t.dataset.setNum] = Math.max(10, +t.value || 60); await saveSettings(); }
  if (t.dataset.setBool) { S.settings[t.dataset.setBool] = t.checked; await saveSettings(); toast('已保存'); }
  if (t.dataset.file) {
    const files = [...(t.files || [])];
    t.value = '';
    if (!files.length) return;
    if (t.dataset.file === 'import') {
      try {
        const data = JSON.parse(await files[0].text());
        await importAll(data);
        await load();
        toast('导入完成');
        route();
      } catch (err) { alertBox('导入失败', err.message); }
      return;
    }
    if (t.dataset.file === 'sheetPhoto') {
      modalData.sheetPhoto = await resizeImage(files[0]);
      document.getElementById('sn-photo').innerHTML = `<div class="photos"><div class="ph"><img src="${URL.createObjectURL(modalData.sheetPhoto)}"></div></div>`;
      return;
    }
    if (t.dataset.file === 'tutor') {
      const blob = await resizeImage(files[0]);
      tutorAttach = { blob, url: URL.createObjectURL(blob) };
      document.getElementById('attach-prev').innerHTML = `<img src="${tutorAttach.url}"> <button class="chip" data-act="rmAttach">移除图片</button>`;
      return;
    }
    await addPhotos(t.dataset.file, files);
  }
});

document.getElementById('modal').addEventListener('click', e => {
  if (e.target.id === 'modal') closeModal();
});

window.addEventListener('hashchange', route);

// ====================================================================
// boot
// ====================================================================

(async function boot() {
  try {
    await load();
  } catch (e) {
    document.getElementById('view').innerHTML = `<div class="card warn">无法打开本地数据库：${esc(e.message)}<br>如果在“无痕浏览”模式，请换成普通模式。</div>`;
    return;
  }
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) navigator.storage.persist();
  } catch { /* ignore */ }
})();

// for debugging from the console
window.__sq = { S, db };
