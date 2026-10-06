// Exam-aware spaced repetition.
// Classic SM-2 style growth, but every interval is capped so each item comes
// back at least ~2 more times before the exam day. After the exam date passes
// the cap is lifted (normal long-term review).

const DAY = 86400000;

export function startOfDay(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function daysUntil(dateStr, now = Date.now()) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const exam = new Date(y, m - 1, d).getTime();
  return Math.round((exam - startOfDay(now)) / DAY);
}

export function newSrs() {
  return { due: 0, interval: 0, ease: 2.3, reps: 0, lapses: 0, last: 0, isNew: true };
}

// grade: 0 = 忘了, 1 = 模糊, 2 = 记得, 3 = 秒答
export function schedule(srs, grade, daysToExam, now = Date.now()) {
  const s = { ...(srs || newSrs()) };
  const wasNew = s.isNew;
  s.isNew = false;
  s.last = now;
  let ivl;
  if (grade === 0) {
    s.lapses += 1;
    s.reps = 0;
    s.ease = Math.max(1.3, s.ease - 0.2);
    s.interval = 0;
    s.due = now + 60 * 1000; // relearn in this session
    return s;
  }
  if (grade === 1) {
    s.ease = Math.max(1.3, s.ease - 0.15);
    ivl = wasNew || s.interval < 1 ? 1 : Math.max(1, s.interval * 1.2);
  } else if (grade === 2) {
    ivl = wasNew ? 1 : s.reps <= 1 ? 3 : s.interval * s.ease;
  } else {
    s.ease = Math.min(3.0, s.ease + 0.15);
    ivl = wasNew ? 3 : Math.max(4, s.interval * s.ease * 1.3);
  }
  s.reps += 1;
  if (daysToExam != null && daysToExam >= 0) {
    const cap = Math.max(1, Math.floor(daysToExam / 2));
    ivl = Math.min(ivl, cap);
  }
  ivl = Math.max(1, Math.round(ivl));
  s.interval = ivl;
  // due at 4am of the target day, so "tomorrow" means tomorrow morning
  s.due = startOfDay(now) + ivl * DAY + 4 * 3600 * 1000;
  return s;
}

export function isDue(srs, now = Date.now()) {
  if (!srs || srs.isNew) return false;
  return srs.due <= now;
}

// 0..1, rough "how well do I know this"
export function mastery(srs) {
  if (!srs || srs.isNew) return 0;
  const m = Math.min(1, (srs.reps * 0.25) + (srs.interval / 10)) - srs.lapses * 0.05;
  return Math.max(0, Math.min(1, m));
}

// Higher = weaker; used by the 考前冲刺 mode.
export function weakness(srs) {
  if (!srs || srs.isNew) return 5;
  return srs.lapses * 2 + (3 - srs.ease) * 3 + (srs.interval < 2 ? 2 : 0);
}
