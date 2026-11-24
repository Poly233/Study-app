// 漢文: kunten markup → tokens → 書き下し文, and HTML for 白文 / 訓読.
//
// Markup, one token per character:
//   字[カナ]       送り仮名 (katakana, shown at the lower right)
//   字[カナ|カナ]  再読文字: right-side and left-side 送り仮名
//   字{よみ}       what the character becomes in 書き下し (助詞・助動詞 in hiragana: 不{ず} 之{の})
//   字{一|二}      再読文字: first reading in place, second after the 返り点 group
//   字(レ)         返り点: レ 一 二 三 上 中 下 甲 乙 一レ 上レ
//   字_            置き字 (not read)
// Spaces are ignored; punctuation passes through.

const TOKEN = /(\S)(?:\[([^\]|]*)(?:\|([^\]]*))?\])?(?:\{([^}|]*)(?:\|([^}]*))?\})?(?:\(([^)]*)\))?(_)?/gu;
const PUNCT = new Set(['、', '。', '「', '」', '，', '？', '！', '・']);

export function parse(src) {
  const out = [];
  for (const m of String(src).replace(/\s+/g, '').matchAll(TOKEN)) {
    const [, base, ok, ok2, read, read2, mark, silent] = m;
    out.push({ base, ok: ok || '', ok2: ok2 || '', read: read ?? null, read2: read2 ?? null, mark: mark || '', silent: !!silent, punct: PUNCT.has(base) });
  }
  return out;
}

const hira = s => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

// The reading of a token in 書き下し (second = the 再読 reading after returning).
function reading(t, second = false) {
  if (t.silent) return '';
  if (t.read2 != null) return second ? t.read2 : t.read;
  if (t.read != null) return t.read;
  return t.base + hira(t.ok);
}

const isRe = m => m.includes('レ');
const NEXT = { 一: '二', 二: '三', 三: '四', 上: '中', 中: '下', 甲: '乙', 乙: '丙', 丙: '丁' };
const role = m => m.replace('レ', ''); // 一レ → 一

// Reorders the tokens by their 返り点 and joins the readings.
export function kakikudashi(src) {
  const toks = typeof src === 'string' ? parse(src) : src;
  const out = [];
  const stack = [];
  // after reading a character: first return to a character waiting with レ,
  // then climb from this character's point (一→二→三, 上→中→下, 甲→乙)
  const resolve = t => {
    const top = stack[stack.length - 1];
    if (top && isRe(top.mark)) {
      stack.pop();
      out.push(reading(top, true));
      resolve(top);
    }
    const r = role(t.mark);
    const top2 = stack[stack.length - 1];
    if (NEXT[r] && top2) {
      const tr = role(top2.mark);
      if (tr === NEXT[r] || (r === '上' && tr === '下')) {
        stack.pop();
        out.push(reading(top2, true));
        resolve(top2);
      }
    }
  };
  const emit = t => { out.push(reading(t, true)); resolve(t); };
  for (const t of toks) {
    if (t.silent) continue;
    if (t.punct) { out.push(t.base); continue; }
    if (t.mark && (isRe(t.mark) || ['二', '三', '四', '中', '下', '乙', '丙', '丁'].includes(t.mark))) {
      if (t.read2 != null) out.push(t.read); // 再読文字: first reading now
      stack.push(t);
      continue;
    }
    emit(t);
  }
  // anything still waiting (malformed markup) is read at the end so nothing is lost
  while (stack.length) out.push(reading(stack.pop(), true));
  return out.join('');
}

// Problems in the markup (for the pack tool).
export function check(src) {
  const toks = parse(src);
  const errs = [];
  let open = 0;
  for (const t of toks) {
    if (t.punct && open) errs.push(`返り点 not closed before ${t.base}`);
    if (t.mark && !/^(レ|一|二|三|四|上|中|下|甲|乙|丙|一レ|上レ|甲レ)$/.test(t.mark)) errs.push(`bad mark ${t.mark}`);
    if (t.mark) open = 0;
  }
  return errs;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 白文: plain characters; words from the gloss list are tappable.
export function hakubunHTML(lines, gloss) {
  const words = (gloss || []).map(g => g.w).filter(Boolean).sort((a, b) => b.length - a.length);
  return lines.map(src => {
    const text = parse(src).map(t => t.base).join('');
    let html = '';
    for (let i = 0; i < text.length;) {
      const w = words.find(x => text.startsWith(x, i));
      if (w) { html += `<span class="kb-w" data-act="kbGloss" data-w="${esc(w)}">${esc(w)}</span>`; i += w.length; } else { html += esc(text[i]); i++; }
    }
    return `<p>${html}</p>`;
  }).join('');
}

// 訓読: vertical columns read right to left. Each character is a small cell
// (返り点 | 字 | 送り仮名) laid out without relying on vertical text rendering,
// so the kana always sit next to their own character.
export function kundokuHTML(lines, perCol = 12) {
  const cell = t => {
    if (t.punct) return `<div class="kc p"><span></span><b>${esc(t.base)}</b><span></span></div>`;
    const kana = s => [...s].map(c => `<i>${esc(c)}</i>`).join('');
    return `<div class="kc${t.silent ? ' oki' : ''}"><span class="kr">${esc(t.mark)}</span><b>${esc(t.base)}</b><span class="ok">${kana(t.ok)}</span>${t.ok2 ? `<span class="ok2">${kana(t.ok2)}</span>` : ''}</div>`;
  };
  const cols = [];
  for (const src of lines) {
    const toks = parse(src);
    let col = [];
    let n = 0;
    for (const t of toks) {
      // punctuation stays with the character before it
      if (n >= perCol && !t.punct) { cols.push(col); col = []; n = 0; }
      col.push(cell(t));
      if (!t.punct) n++;
    }
    if (col.length) cols.push(col);
  }
  return cols.map(c => `<div class="kcol">${c.join('')}</div>`).join('');
}
