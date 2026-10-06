import { db, uid, exportAll, importAll } from './db.js';
import { schedule, newSrs, isDue, mastery, weakness, daysUntil } from './srs.js';
import * as AI from './ai.js';
import { esc, md, renderMath, resizeImage, blobToBase64, blobURL, toast, todayKey, shuffle, copyText } from './util.js';

// ====================================================================
// constants
// ====================================================================

export const SUBJECTS = [
  { id: 'math2', name: '数学Ⅱ', book: 'PRIME', color: '#4f7cff', icon: '∫', modes: ['problem', 'cards'] },
  { id: 'mathB', name: '数学B', book: 'PRIME', color: '#8a5cff', icon: 'Σ', modes: ['problem', 'cards'] },
  { id: 'phys', name: '物理', book: 'リードα', color: '#ff8a3d', icon: '⚡', modes: ['problem', 'cards'] },
  { id: 'chem', name: '化学', book: 'セミナー', color: '#16b26b', icon: '⚗', modes: ['cards', 'problem'] },
  { id: 'kokyo', name: '公共', book: 'プリント', color: '#e24a6b', icon: '⚖', modes: ['cards'] },
  { id: 'joho', name: '情報', book: 'プリント', color: '#12a5c9', icon: '⌨', modes: ['cards', 'problem'] },
];
const SUBJ = Object.fromEntries(SUBJECTS.map(s => [s.id, s]));
const REASONS = ['没思路', '公式忘了', '计算错误', '看错题', '太慢'];
const DAY = 86400000;

// ====================================================================
// state
// ====================================================================

const S = {
  cards: [],
  problems: [],
  sources: [],
  settings: null,
  stats: null,
};
const imgCache = new Map();

let draft = null;       // 拍照导入 in progress
let session = null;     // active review session
let lib = { subject: 'all', tab: 'problems', q: '' };
let timerHandle = null;
let busy = false;

function defaultSettings() {
  const exam = new Date(Date.now() + 22 * DAY);
  const ds = todayKey(exam.getTime());
  return {
    apiKey: '',
    model: AI.MODELS[0].id,
    lang: 'zh',
    dailyGoal: 60,
    exams: Object.fromEntries(SUBJECTS.map(s => [s.id, ds])),
  };
}

async function load() {
  const [cards, problems, sources, settings, stats] = await Promise.all([
    db.all('cards'), db.all('problems'), db.all('sources'),
    db.getMeta('settings', null), db.getMeta('stats', null),
  ]);
  S.cards = cards;
  S.problems = problems;
  S.sources = sources;
  S.settings = { ...defaultSettings(), ...(settings || {}) };
  S.settings.exams = { ...defaultSettings().exams, ...(settings?.exams || {}) };
  if (!settings) await db.setMeta('settings', S.settings);
  S.stats = stats || { xp: 0, streak: 0, lastDay: null, days: {} };
}

const saveSettings = () => db.setMeta('settings', S.settings);
const saveStats = () => db.setMeta('stats', S.stats);

async function putCard(c) { await db.put('cards', c); upsert(S.cards, c); }
async function putProblem(p) { await db.put('problems', p); upsert(S.problems, p); }
async function putSource(s) { await db.put('sources', s); upsert(S.sources, s); }
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

function nearestExam() {
  let best = null;
  for (const s of SUBJECTS) {
    const d = daysTo(s.id);
    if (d != null && d >= 0 && (best == null || d < best)) best = d;
  }
  return best;
}

function phase(d) {
  if (d == null) return { name: '设置考试日期', tip: '到 设置 里填写每科考试日期。' };
  if (d > 14) return { name: '第1阶段：全部收进来', tip: '把所有プリント拍成闪卡，问题集做完后把错题全部拍进来。每天把闪卡清零。' };
  if (d > 7) return { name: '第2阶段：解法训练', tip: '重点做“解法闪卡”和错题重做：看到题→30秒内说出第一步。每道错题至少做一次类题。' };
  if (d > 0) return { name: '第3阶段：考前冲刺', tip: '每天用“冲刺模式”刷弱项，错题全部再过一遍。考前一天看资料的要点总结。' };
  if (d === 0) return { name: '考试当天', tip: '早上用冲刺模式过一遍弱项闪卡，然后相信自己！' };
  return { name: '考试结束', tip: '辛苦了！可以在设置里改下次考试的日期。' };
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
  document.body.dataset.view = name;
  header();
  const map = { home: viewHome, add: viewAdd, review: viewReview, session: viewSession, lib: viewLib,
    problem: viewProblem, tutor: viewTutor, source: viewSource, settings: viewSettings };
  tabs({ problem: 'lib', tutor: 'lib', source: 'lib', session: 'review' }[name] || name);
  await (map[name] || viewHome)(arg);
}

function go(h) {
  if (location.hash === '#/' + h) route(); else location.hash = '#/' + h;
}

// ====================================================================
// HOME
// ====================================================================

async function viewHome() {
  const d = nearestExam();
  const ph = phase(d);
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

  setView(`
  <section class="hero">
    <div class="hero-days"><b>${d == null ? '?' : Math.max(0, d)}</b><span>天后考试</span></div>
    <div class="hero-txt">
      <div class="phase">${esc(ph.name)}</div>
      <div class="muted small">${esc(ph.tip)}</div>
      <div class="muted small">称号：${TITLES[Math.min(TITLES.length - 1, lv.level - 1)]} · 再 ${lv.toNext} XP 升级</div>
    </div>
  </section>

  ${empty ? `
  <section class="card onboarding">
    <h3>👋 3步开始</h3>
    <ol>
      <li><b>设置</b>：填 API Key（AI 自动做卡）和每科考试日期。没有 Key 也能用“免费：复制提示词”。</li>
      <li><b>拍照</b>：プリント → 自动生成闪卡；做错的题 + 解答页 → 自动解析解法。</li>
      <li><b>复习</b>：每天点“开始今日任务”，把数字清零就赢了。</li>
    </ol>
    <div class="row"><button class="btn" data-act="nav" data-to="settings">去设置</button><button class="btn primary" data-act="nav" data-to="add">📷 拍第一张</button></div>
  </section>` : ''}

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
    '没思路': '“没思路”最多 → 多刷“解法闪卡”，练习看到题 30 秒内说出第一步。',
    '公式忘了': '“公式忘了”最多 → 把公式做成闪卡（拍照导入时选“背诵资料”）。',
    '计算错误': '“计算错误”最多 → 做类题时一定在纸上算完再对答案，并拍照让 AI 找错。',
    '看错题': '“看错题”最多 → 读题时把条件和所求画线，答完回头再读一次问题。',
    '太慢': '“太慢”最多 → 冲刺阶段对这些题计时重做。',
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

function newDraft(sid = 'math2') {
  return { subject: sid, mode: SUBJ[sid].modes[0], sourceKind: 'print', photos: [], solPhotos: [], note: '', ref: '', reason: [], preview: null };
}

async function viewAdd() {
  if (!draft) draft = newDraft();
  const s = SUBJ[draft.subject];
  if (draft.preview) return viewPreview();
  const photoList = (arr, key) => arr.map((p, i) => `<div class="ph"><img src="${p.url}"><button data-act="rmPhoto" data-key="${key}" data-i="${i}">×</button></div>`).join('');
  const isP = draft.mode === 'problem';
  setView(`
  <h2>📷 拍照导入</h2>
  <div class="chips">${SUBJECTS.map(x => subjChip(x.id, x.id === draft.subject)).join('')}</div>

  <div class="seg">
    <button class="${!isP ? 'on' : ''}" data-act="setMode" data-mode="cards">📄 背诵资料 → 闪卡</button>
    <button class="${isP ? 'on' : ''}" data-act="setMode" data-mode="problem">✏️ 错题 → 解法</button>
  </div>

  ${!isP ? `
  <div class="card">
    <div class="muted small">资料类型</div>
    <div class="seg small">
      <button class="${draft.sourceKind === 'print' ? 'on' : ''}" data-act="setKind" data-kind="print">プリント</button>
      <button class="${draft.sourceKind === 'book' ? 'on' : ''}" data-act="setKind" data-kind="book">问题集（${esc(s.book)}）的暗记题</button>
    </div>
    <div class="muted small">💡 一次 1–3 页效果最好。已经写了答案的穴埋めプリント最理想。</div>
  </div>` : `
  <div class="card">
    <label class="lbl">题号（可选）</label>
    <input data-bind="ref" placeholder="例：${esc(s.book)} 123 (2)" value="${esc(draft.ref)}">
    <label class="lbl">错因（可多选）</label>
    <div class="chips">${REASONS.map(r => `<button class="chip ${draft.reason.includes(r) ? 'on' : ''}" data-act="toggleReason" data-r="${r}">${r}</button>`).join('')}</div>
  </div>`}

  <div class="card">
    <div class="lbl">${isP ? '① 题目照片' : '资料照片'}</div>
    <div class="photos">${photoList(draft.photos, 'photos')}</div>
    <div class="row">
      <label class="btn"><input type="file" accept="image/*" capture="environment" data-file="photos" hidden>📷 拍照</label>
      <label class="btn"><input type="file" accept="image/*" multiple data-file="photos" hidden>🖼 相册</label>
    </div>
    ${isP ? `
    <div class="lbl" style="margin-top:14px">② 解答页照片（强烈推荐，AI 会按官方解法讲）</div>
    <div class="photos">${photoList(draft.solPhotos, 'solPhotos')}</div>
    <div class="row">
      <label class="btn"><input type="file" accept="image/*" capture="environment" data-file="solPhotos" hidden>📷 拍照</label>
      <label class="btn"><input type="file" accept="image/*" multiple data-file="solPhotos" hidden>🖼 相册</label>
    </div>` : ''}
    <label class="lbl">${isP ? '卡在哪里？（可选）' : '备注（可选，例如“老师说第3页必考”）'}</label>
    <textarea data-bind="note" rows="2">${esc(draft.note)}</textarea>
  </div>

  <div class="stack">
    <button class="btn primary block" data-act="runAI" ${draft.photos.length ? '' : 'disabled'}>🤖 AI ${isP ? '解析解法' : '生成闪卡'}</button>
    <button class="btn block" data-act="manualAI" ${draft.photos.length ? '' : 'disabled'}>🆓 免费：复制提示词到 Claude/ChatGPT App</button>
    ${isP ? `<button class="btn ghost block" data-act="saveRawProblem" ${draft.photos.length ? '' : 'disabled'}>只保存照片（以后再解析）</button>`
          : `<button class="btn ghost block" data-act="manualCard">✍️ 手动添加一张卡</button>`}
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

function draftPrompt() {
  const subject = SUBJ[draft.subject];
  if (draft.mode === 'problem') {
    return AI.problemPrompt({ subject, ref: draft.ref, note: draft.note, reason: draft.reason.join('、'),
      hasSolution: draft.solPhotos.length > 0, settings: S.settings });
  }
  return AI.cardsPrompt({ subject, sourceKind: draft.sourceKind, note: draft.note, settings: S.settings });
}

async function runAI() {
  if (busy) return;
  busy = true;
  const done = aiOverlay(draft.mode === 'problem' ? 'AI 正在拆解这道题…' : 'AI 正在找重点、做闪卡…');
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
    } else {
      result = await AI.generateJSON(S.settings, prompt, imgs, 'cards', 'medium');
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
  const schema = draft.mode === 'problem' ? 'problem' : 'cards';
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
  const cards = r.cards || [];
  setView(`
    <h2>✅ 生成了 ${cards.length} 张卡</h2>
    <div class="card"><b>${esc(r.title || '')}</b><div class="summary">${md(r.summary || '')}</div></div>
    <div class="muted small">点 × 删除不需要的卡。保存后可在“题库”里编辑。</div>
    ${cards.map((c, i) => `
      <div class="card pv ${c._del ? 'del' : ''}">
        <div class="pv-top"><span class="tag">${c.type === 'cloze' ? '填空' : '问答'}</span><span class="stars">${'★'.repeat(c.importance || 2)}</span>
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
  await putSource(src);
  const cards = (r.cards || []).filter(c => !c._del).map((c, i) => ({
    id: uid(), subject: draft.subject, type: c.type === 'cloze' ? 'cloze' : 'qa', front: c.front, back: c.back,
    note: c.note || '', importance: c.importance || 2, sourceId: src.id, srs: newSrs(), created: created + i,
  }));
  await db.putMany('cards', cards);
  S.cards.push(...cards);
  addXP(Math.min(30, cards.length));
  toast(`已保存 ${cards.length} 张卡`);
  const sid = draft.subject;
  draft = newDraft(sid);
  go('source/' + src.id);
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
  if (it.kind === 'card') return renderCardItem(prog, it.obj);
  return renderProblemItem(prog, it.obj);
}

function renderCardItem(prog, c) {
  const s = SUBJ[c.subject];
  const typeName = { qa: '问答', cloze: '填空', method: '解法闪卡' }[c.type] || '';
  const isNew = !c.srs || c.srs.isNew;
  const f = session.flipped;
  setView(`${prog}
    <div class="flash ${f ? 'flipped' : ''} ${c.type === 'method' ? 'method' : ''}" data-act="${f ? '' : 'flip'}" style="--c:${s.color}">
      <div class="flash-meta"><span>${s.icon} ${s.name}</span><span>${typeName}${isNew ? ' · 🆕' : ''}</span></div>
      ${c.type === 'method' ? '<div class="muted small">看到这道题，第一步做什么？用什么解法？先在脑中说出来。</div>' : ''}
      <div class="flash-front">${md(c.front)}</div>
      ${f ? `<div class="flash-sep"></div><div class="flash-back">${md(c.back)}</div>${c.note ? `<div class="note">${md(c.note)}</div>` : ''}
        ${c.type === 'method' && c.problemId ? `<button class="btn ghost small" data-act="openProblemFromSession" data-id="${c.problemId}">看完整解法 →</button>` : ''}` : '<div class="tap-hint">点卡片看答案</div>'}
    </div>
    ${f ? gradeBar(['忘了', '模糊', '记得', '秒答']) : `<button class="btn primary block big" data-act="flip">显示答案</button>`}
  `);
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
        <span class="dot"></span><span class="li-t">${esc(s.title)}</span>
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
  return `<button class="li card-li" data-act="editCard" data-id="${c.id}" style="--c:${SUBJ[c.subject].color}">
    <span class="dot"></span><span class="li-t">${md(c.front)}<small class="muted">${md(c.back)}</small></span>
    <span class="mini-m">${c.srs?.isNew ? '新' : Math.round(mastery(c.srs) * 100) + '%'}</span></button>`;
}

async function viewSource(id) {
  const src = S.sources.find(s => s.id === id);
  if (!src) return go('lib');
  const cards = S.cards.filter(c => c.sourceId === id);
  setView(`
    <button class="back" data-act="back">‹ 返回</button>
    <h2>${esc(src.title)}</h2>
    <div class="muted small">${SUBJ[src.subject].name} · ${cards.length} 张卡</div>
    <div class="card"><h4>📌 考前一页纸</h4><div class="summary">${md(src.summary)}</div></div>
    ${await imgsHTML(src.imageIds)}
    <div class="row"><button class="btn primary" data-act="studySource" data-id="${id}">▶ 只刷这份资料</button>
      <button class="btn danger ghost" data-act="delSource" data-id="${id}">删除</button></div>
    <div class="list">${cards.map(cardRow).join('')}</div>
  `);
}

function editCard(id) {
  const c = S.cards.find(x => x.id === id) || { id: null, subject: lib.subject !== 'all' ? lib.subject : (draft?.subject || 'kokyo'), type: 'qa', front: '', back: '', note: '', importance: 2 };
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
      ${c.id ? `<button class="btn block" data-act="resetCard" data-id="${c.id}">重置进度（当新卡）</button>
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
      ${(a.steps || []).map((st, i) => `<details ${open ? 'open' : ''}><summary>${i + 1}. ${md(st.title)}</summary>${md(st.detail)}</details>`).join('')}
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
      <button class="big-btn" data-act="makeVariant" data-id="${p.id}" ${hasKey && p.analysis ? '' : 'disabled'}><b>🔁 出类题</b><span>改数值、同解法</span></button>
    </div>
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
      <h4>📅 考试日期</h4>
      ${SUBJECTS.map(s => `<div class="kv"><span>${s.icon} ${s.name}</span><input type="date" data-exam="${s.id}" value="${st.exams[s.id] || ''}"></div>`).join('')}
      <button class="btn small" data-act="sameDate">全部设成同一天</button>
    </div>

    <div class="card">
      <h4>🤖 AI（Claude）</h4>
      <label class="lbl">API Key</label>
      <input type="password" id="api-key" placeholder="sk-ant-..." value="${esc(st.apiKey)}" autocomplete="off">
      <div class="row"><button class="btn primary" data-act="saveKey">保存</button><button class="btn" data-act="testKey">测试</button></div>
      <details><summary class="small">怎么获取？要钱吗？</summary><div class="small">
        1. 用浏览器打开 <b>console.anthropic.com</b>，注册登录。<br>
        2. Billing 里充值（最低 5 美元左右，够用整个考试期间：一页プリント约 2–5 日元，一道错题解析约 5–15 日元）。<br>
        3. API Keys → Create Key，复制粘贴到上面。<br>
        Key 只保存在你的手机里，只发送给 Anthropic 官方 API。<br>
        不想花钱：导入时用“🆓 免费：复制提示词”，配合免费的 Claude App 也能做卡和解析（AI 辅导聊天需要 Key）。
      </div></details>
      <label class="lbl">模型</label>
      <select data-set="model">${AI.MODELS.map(m => `<option value="${m.id}" ${m.id === st.model ? 'selected' : ''}>${m.name}</option>`).join('')}</select>
      <label class="lbl">讲解语言</label>
      <select data-set="lang"><option value="zh" ${st.lang === 'zh' ? 'selected' : ''}>中文讲解（术语保留日语）</option><option value="ja" ${st.lang === 'ja' ? 'selected' : ''}>日本語</option></select>
      <div class="muted small">闪卡的正反面永远是日语（和考试一致），讲解/提示用这里选的语言。</div>
    </div>

    <div class="card">
      <h4>🎯 每日目标</h4>
      <div class="kv"><span>每天复习张数</span><input type="number" min="10" max="500" step="10" data-set-num="dailyGoal" value="${st.dailyGoal}"></div>
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
  pickSubject: d => { const keep = draft; draft = { ...newDraft(d.sid), photos: keep.photos, solPhotos: keep.solPhotos }; viewAdd(); },
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
      if (d.schema === 'cards' && !Array.isArray(data.cards)) throw new Error('格式不对：没有 cards');
      if (d.schema === 'problem' && !data.pattern) throw new Error('格式不对：没有 pattern');
      draft.preview = data;
      closeModal();
      go('add');
    } catch (e) {
      toast('解析失败：' + e.message, 4000);
    }
  },
  pvDel: d => { const c = draft.preview.cards[+d.i]; c._del = !c._del; viewPreview(); },
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
    SUBJECTS.forEach(s => { S.settings.exams[s.id] = v; });
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
    for (const s of ['cards', 'problems', 'images', 'sources']) await db.clear(s);
    S.cards = []; S.problems = []; S.sources = [];
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
