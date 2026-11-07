// All Claude calls + prompts. Uses the official Anthropic SDK (vendored).
import Anthropic from '../vendor/anthropic.js';

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5（最准，推荐）' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5（便宜一半，够用）' },
];

function explLang(settings) {
  return settings.lang === 'ja'
    ? '日本語'
    : '简体中文（日语专有名词/术语保留原文，必要时括号补充）';
}

// ---------------- JSON schemas (structured outputs) ----------------

const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const SCHEMAS = {
  cards: obj({
    title: str,
    summary: str,
    cards: {
      type: 'array',
      items: obj({
        type: { type: 'string', enum: ['qa', 'cloze'] },
        front: str,
        back: str,
        note: str,
        importance: { type: 'integer', enum: [1, 2, 3] },
      }),
    },
  }),
  // 化学基礎: same as cards, plus wrong answers for a 4択 version
  chemcards: obj({
    title: str,
    summary: str,
    cards: {
      type: 'array',
      items: obj({
        type: { type: 'string', enum: ['qa', 'cloze'] },
        front: str,
        back: str,
        note: str,
        distractors: strArr,
        importance: { type: 'integer', enum: [1, 2, 3] },
      }),
    },
  }),
  problem: obj({
    title: str,
    ref: str,
    problemText: str,
    topic: str,
    pattern: str,
    trigger: str,
    keyIdea: str,
    firstStep: str,
    hints: strArr,
    steps: { type: 'array', items: obj({ title: str, detail: str }) },
    answer: str,
    pitfalls: strArr,
    formulas: strArr,
    recallFront: str,
    recallBack: str,
  }),
  variant: obj({
    problem: str,
    changed: str,
    steps: strArr,
    answer: str,
  }),
  lesson: obj({
    title: str,
    overview: str,
    prerequisites: strArr,
    sections: { type: 'array', items: obj({ heading: str, explain: str, example: str, checkQ: str, checkA: str }) },
    keyPoints: strArr,
    formulas: strArr,
    cards: {
      type: 'array',
      items: obj({
        type: { type: 'string', enum: ['qa', 'cloze'] },
        front: str,
        back: str,
        note: str,
        importance: { type: 'integer', enum: [1, 2, 3] },
      }),
    },
  }),
  words: obj({
    title: str,
    summary: str,
    words: {
      type: 'array',
      items: obj({
        word: str,
        pos: { type: 'string', enum: ['動', '名', '形', '副', '熟'] },
        ja: str,
        zh: str,
        ex: str,
        exTr: str,
        form: str,
        cloze: str,
        distractors: strArr,
        colloc: str,
        syn: str,
        note: str,
        importance: { type: 'integer', enum: [1, 2, 3] },
      }),
    },
  }),
  essay: obj({
    scores: obj({ content: { type: 'integer' }, structure: { type: 'integer' }, vocabulary: { type: 'integer' }, grammar: { type: 'integer' } }),
    total: { type: 'integer' },
    verdict: str,
    good: strArr,
    issues: { type: 'array', items: obj({ category: str, original: str, fixed: str, why: str }) },
    improved: str,
    phrases: { type: 'array', items: obj({ en: str, ja: str }) },
  }),
  feynman: obj({
    score: { type: 'integer' },
    verdict: str,
    covered: strArr,
    missing: strArr,
    wrong: { type: 'array', items: obj({ point: str, fix: str }) },
    simpler: str,
    cards: { type: 'array', items: obj({ front: str, back: str, note: str }) },
  }),
};

// ---------------- prompts (英検準1級) ----------------

const EXAM = '英検準1級';
const CHEM = '大学入学共通テスト「化学基礎」';
const isChem = subject => subject?.exam === 'kyotsu';
const examOf = subject => (isChem(subject) ? CHEM : EXAM);
const teacherOf = subject => (isChem(subject) ? `${CHEM}的化学老师` : `${EXAM}英语老师`);
const exampleOf = subject => (isChem(subject) ? '具体的物质、化学式或身边的例子' : '英文例子');

const CHEM_FORMAT = `化学式和反应式用 KaTeX 的 mhchem 写在 $ 里，例如 $\\ce{H2SO4}$、$\\ce{Cu^2+}$、$\\ce{MnO4- + 8H+ + 5e- -> Mn^2+ + 4H2O}$；数式也写在 $ 里，例如 $6.0 \\times 10^{23}$。`;

// 资料（笔记・参考书・解说・范文）→ 普通闪卡
export function cardsPrompt({ subject, note, settings }) {
  if (isChem(subject)) return chemCardsPrompt({ note, settings });
  const L = explLang(settings);
  const system = `你是${EXAM}对策的王牌讲师，也是制作闪卡的高手。学生会拍下英语学习资料（笔记、参考书、过去问的解说、写作范文等），你要把它变成“考试用得上”的闪卡。`;
  const user = `部分：${subject.name}
${note ? `学生备注：${note}\n` : ''}
请按以下规则从图片中制作闪卡：
1. 挑出值得背的内容：准1级水平的单词・熟语・句动词、常用搭配、写作和要约里能直接套用的表达、语法要点、阅读・听力中常见的换说（paraphrase）。
2. 一张卡只考一个点；正面绝不能泄露答案。
3. 表达类：front 用${L}写意思或使用场景，back 写英文表达（练“写得出来”）。单词类：front 写英文，back 写意思。
4. type："qa"=问答；"cloze"=把英文原句中的关键词挖空成「（　　）」，back 只写填入的词。
5. note 用${L}写一句用法提示或易混点（没有就留空字符串）。
6. importance：3=准1级很常用，2=一般，1=补充。
7. 每页一般 10–30 张，不要重复。
8. title：资料标题；summary：用${L}写要点总结（Markdown 列表 5–10 条）。
9. 需要补充例句时自己原创，不要大段照抄书上的文字。
10. 看不清的地方不要编造，在 summary 中说明。`;
  return { system, user };
}

// 化学基礎の资料（教科书・讲义・图录・笔记）→ 闪卡（可带 4 选 1 的干扰项）
function chemCardsPrompt({ note, settings }) {
  const L = explLang(settings);
  const system = `你是${CHEM}对策的王牌讲师，也是制作闪卡的高手。学生会拍下化学基礎的资料（教科书、学校讲义、图录、笔记、过去问的解说），你要把它变成“共通テスト用得上”的闪卡。`;
  const user = `${note ? `学生备注：${note}\n` : ''}
请按以下规则从图片中制作闪卡：
1. 挑出值得背、考试会问的内容：用语的定义、物质的性质・颜色・状态・用途、反应式和半反应式、周期律等规律和倾向、实验器具和操作的注意点、计算要用的公式和常数。
2. 一张卡只考一个点；正面绝不能泄露答案。
3. front 和 back 用日语（和共通テスト一样的用语），note 用${L}写一句记忆技巧、理由或易混点（没有就留空字符串）。
4. ${CHEM_FORMAT}
5. type："qa"=问答；"cloze"=把关键词挖空成「（　　）」，back 只写填入的内容（多个空用「／」隔开）。
6. distractors：答案很短（物质名、颜色、数值、用语、化学式等）时，给 3 个和 back 同样格式、看起来像但明显错误的选项，用来出 4 选 1；答案是长句或很难出选项时给空数组。
7. importance：3=共通テスト常考，2=一般，1=补充。
8. 每页一般 10–30 张，不要重复。
9. title：资料标题（例「化学基礎 酸化還元① 酸化数」）；summary：用${L}写要点总结（Markdown 列表 5–10 条，日语用语保留）。
10. 只做化学基礎范围内的内容（化学 才学的内容不要做）；看不清的地方不要编造，在 summary 中说明。`;
  return { system, user };
}

// 单词书・过去问・笔记的页面 → 单词卡（例句和解释全部原创）
export function wordsPrompt({ note, settings }) {
  const L = explLang(settings);
  const system = `你是${EXAM}的词汇教学专家。学生会拍下单词书、过去问或笔记的页面，你要把他“不会的词”做成高质量的单词卡，并且附上和${EXAM}大問1 一样形式的 4 选 1 练习。`;
  const user = `${note ? `学生备注：${note}\n\n` : ''}规则：
1. 选词：学生用笔做了记号（打勾、划线、圈起来、荧光笔等）的词＝不会的词，只做这些。页面上没有任何记号时，做所有准1级水平的词条（最多 40 个）。
2. 【版权】例句、译文和解释全部由你原创，不要照抄书上的例句和译文。
3. 每个词的字段：
 - word：原形（熟语、句动词照常写，例如 "come down with"）
 - pos：词性，只用「動」「名」「形」「副」「熟」之一
 - ja：日语意思，简洁，优先写英検最常考的意思（多个用「；」分隔，最多 3 个）
 - zh：中文意思
 - ex：原创英文例句，英検準1級 大問1 的风格（15–30 词），读完上下文能推出词义
 - exTr：例句的翻译（用${L}）
 - form：例句里目标词实际出现的形态（例如 alleviated）
 - cloze：把例句中的 form 换成「＿＿＿」之后的句子
 - distractors：3 个干扰选项。要和 form 词性相同、形态相同（同为过去式、同为复数等），准1级水平，放进句子里意思明显说不通；不要用 word 的同义词
 - colloc：常见搭配 1–2 个（英文，用「 / 」分隔；没有就空字符串）
 - syn：同义・近义词 1–3 个（英検的选项和长文常用它们换说；没有就空字符串）
 - note：用${L}写记忆技巧、词根或易混词（可以是空字符串）
 - importance：3=准1级高频，2=一般，1=较少考
4. title：例如「単熟語EX p.32–33 不会的词」；summary：用${L}列出这批词里最需要注意的 3–5 点（易混词等）。
5. 看不清的词不要猜，在 summary 里说明。`;
  return { system, user };
}

// 过去问的错题 → 解题分析
export function problemPrompt({ subject, ref, note, reason, hasSolution, settings }) {
  if (isChem(subject)) return chemProblemPrompt({ ref, note, reason, hasSolution, settings });
  const L = explLang(settings);
  const system = `你是${EXAM}的专业辅导老师。学生在做过去问，这道题（部分：${subject.name}）做错了或者没把握。
你要讲清楚“为什么是这个答案、其他选项为什么不对”，再总结出这类题的解题套路，让他下次遇到同类题能做对。`;
  const user = `${ref ? `题号：${ref}\n` : ''}${reason ? `学生的错因：${reason}\n` : ''}${note ? `学生备注：${note}\n` : ''}${hasSolution ? '最后标注为【解答】的图片是官方解答或解说，以它为准。\n' : '没有提供官方解答，请自己认真判断并确认答案。\n'}
请分析图片里的题目（有多道题时以题号为准，否则分析最主要的一道），说明文字用${L}：
- title：简短标题（例「2025-1 大問1 (5)」「大問3 第2段落の設問」）
- ref：题号（不知道就留空字符串）
- problemText：题目转写（英文原文。长文题只转写设问、选项和相关段落）
- topic：题型（例「大問1 語彙」「大問2 空所補充」「大問3 内容一致」「リスニング Part1」）
- pattern：解题套路，一句话（例「But / However 之后是作者的主张」「正确选项＝本文的换说（paraphrase）」「从上下文推测词义」）
- trigger：识别信号，格式“看到〇〇 → 想到△△”
- keyIdea：正确答案为什么对（引用根据句），以及每个错误选项为什么错
- firstStep：解这类题的第一步（例「先读设问和选项再读文章」「先判断空格需要正面还是负面的意思」）
- hints：3 个逐步加强的提示
- steps：解题过程，每步有 title 和 detail（根据句在哪里、和选项怎样对应）
- answer：正确答案，加上题目或关键句的译文
- pitfalls：干扰项的陷阱、学生容易错的原因（结合学生的错因）
- formulas：这道题里值得背的单词和表达（格式「英文 — 意思」）
- recallFront：“解法闪卡”正面：用 1–2 句概括题目和它问的是什么（不看原图也能懂）
- recallBack：“解法闪卡”背面：解题套路 + 第一步 + 关键根据
不确定的地方要说明，不要编造。`;
  return { system, user };
}

function chemProblemPrompt({ ref, note, reason, hasSolution, settings }) {
  const L = explLang(settings);
  const system = `你是${CHEM}的专业辅导老师。学生在做共通テスト的过去问或模拟题，这道题做错了或者没把握。
你要讲清楚“为什么是这个答案、其他选项为什么不对”，计算题要一步一步写出式子，再总结出这类题的解题套路，让他下次遇到同类题能做对。`;
  const user = `${ref ? `题号：${ref}\n` : ''}${reason ? `学生的错因：${reason}\n` : ''}${note ? `学生备注：${note}\n` : ''}${hasSolution ? '最后标注为【解答】的图片是官方解答或解说，以它为准。\n' : '没有提供官方解答，请自己认真计算并确认答案。\n'}
请分析图片里的题目（有多道题时以题号为准，否则分析最主要的一道），说明文字用${L}，化学用语保留日语。${CHEM_FORMAT}
- title：简短标题（例「2026 化学基礎 第1問 問3」）
- ref：题号（不知道就留空字符串）
- problemText：题目转写（日语原文，含选项）
- topic：单元（例「物質量」「中和滴定」「酸化還元」「化学結合」）
- pattern：解题套路，一句话（例「中和：酸の価数×mol＝塩基の価数×mol」「酸化数の変化から電子のやりとりを数える」）
- trigger：识别信号，格式“看到〇〇 → 想到△△”
- keyIdea：正确答案为什么对，以及每个错误选项错在哪里（知识题要指出被换掉的那个词）
- firstStep：第一步（例「先把题目给的量全部换成 mol」「先写出两个半反应式」）
- hints：3 个逐步加强的提示
- steps：解题过程，每步有 title 和 detail（计算题写出带单位的式子）
- answer：正确答案（编号加内容）
- pitfalls：容易掉进去的陷阱（结合学生的错因）
- formulas：这道题用到的、值得背的公式・反应式・知识点
- recallFront：“解法闪卡”正面：用 1–2 句概括题目和它问的是什么（不看原图也能懂）
- recallBack：“解法闪卡”背面：解题套路 + 第一步 + 关键知识
不确定的地方要说明，不要编造。`;
  return { system, user };
}

// 看不懂的内容 → 一对一补课
export function lessonPrompt({ subject, note, settings }) {
  if (isChem(subject)) return chemLessonPrompt({ note, settings });
  const L = explLang(settings);
  const system = `你是一位非常会讲课的${EXAM}英语老师，正在给学生一对一辅导（部分：${subject.name}）。
学生拍下了他没看懂的内容（参考书、语法、过去问的长文或解说、写作范文等）。请你从零开始讲到他懂，目标是在${EXAM}拿分。`;
  const user = `${note ? `学生说哪里不懂：${note}\n\n` : ''}请根据图片里的内容讲解，讲解全部用${L}（英文例句和术语保留原文，必要时附上翻译）：
- title：本节标题（例：「分詞構文」「長文：段落の主旨のつかみ方」）。
- overview：这一节在学什么、对英検有什么用，2–3 句。
- prerequisites：需要先会的旧知识，每条格式为“旧知识：一句话复习”。没有就给空数组。
- sections：拆成 3–6 个小节，从易到难。每节包括：
  - heading：小节名
  - explain：从零讲解，先给直觉或比喻，再讲正式的说法，最后讲注意点。用 Markdown，300 字以内
  - example：一个有代表性的英文例子（或英検风格的小题）加讲解
  - checkQ：一个检查他是否真懂的小问题
  - checkA：checkQ 的答案，加一句解释
- keyPoints：考试最可能用到的要点，5–10 条。
- formulas：本节的句型或公式化表达（没有就给空数组）。
- cards：把需要背的东西做成闪卡，10–25 张。英文表达类 front 写意思（用${L}）、back 写英文；type="cloze" 时把英文原句的关键词挖空成「（　　）」。note 用${L}写一句提示。importance：3=很常用。
- 只讲资料里的内容，以及理解它必需的基础，不要超纲。
- 图片看不清的地方要说明，不要编造。`;
  return { system, user };
}

function chemLessonPrompt({ note, settings }) {
  const L = explLang(settings);
  const system = `你是一位非常会讲课的化学老师，正在给准备${CHEM}的学生一对一辅导。
学生拍下了他没看懂的内容（教科书、讲义、过去问的解说等）。请你从零开始讲到他懂，目标是在共通テスト拿分。`;
  const user = `${note ? `学生说哪里不懂：${note}\n\n` : ''}请根据图片里的内容讲解，讲解用${L}，化学用语保留日语（必要时括号补充中文）。${CHEM_FORMAT}
- title：本节标题（例：「物質量（mol）の考え方」「酸化数の求め方」）。
- overview：这一节在学什么、在共通テスト里怎么考，2–3 句。
- prerequisites：需要先会的旧知识，每条格式为“旧知识：一句话复习”。没有就给空数组。
- sections：拆成 3–6 个小节，从易到难。每节包括：
  - heading：小节名
  - explain：从零讲解，先给直觉或比喻（粒子的图像），再讲正式的说法，最后讲注意点。用 Markdown，300 字以内
  - example：一个有代表性的例子或共通テスト风格的小题（计算题写出带单位的式子）
  - checkQ：一个检查他是否真懂的小问题
  - checkA：checkQ 的答案，加一句解释
- keyPoints：考试最可能用到的要点，5–10 条。
- formulas：本节的公式・反应式（没有就给空数组）。
- cards：把需要背的东西做成闪卡，10–25 张。front 是问题、back 是答案（日语）；type="cloze" 时把关键词挖空成「（　　）」。note 用${L}写一句提示。importance：3=常考。
- 只讲资料里的内容，以及理解它必需的基础，不要超出化学基礎的范围。
- 图片看不清的地方要说明，不要编造。`;
  return { system, user };
}

export function lessonMorePrompt({ subject, lesson, section, settings }) {
  const L = explLang(settings);
  const system = `你是一位非常有耐心的${teacherOf(subject)}，正在一对一辅导（部分：${subject.name}）。`;
  const user = `本节：${lesson.title}
概要：${lesson.overview}

学生说下面这个小节“还是不懂”：
【${section.heading}】
${section.explain}
例子：${section.example}
${(section.more || []).length ? `\n之前已经换过的讲法：\n${section.more.join('\n---\n')}\n` : ''}
请用${L}，换一个完全不同的角度重新讲：
- 用更生活化的比喻，或者从更基础的地方讲起
- 步骤拆得更细，每一步只讲一件事
- 给一个比原来更简单的${isChem(subject) ? '例子（具体的物质或数字）' : '英文例子'}，并讲解
- 15 行以内
- 不要超出这一节的范围`;
  return { system, user };
}

export function variantPrompt({ subject, problem, settings }) {
  if (isChem(subject)) return chemVariantPrompt({ problem, settings });
  const L = explLang(settings);
  const system = `你是${EXAM}的出题老师。你要出一道和原题同一题型、考同一个知识点或解题套路的新题。`;
  const user = `部分：${subject.name}
原题：
${problem.problemText}

题型：${problem.topic}
解题套路：${problem.pattern}
原题的要点：${problem.keyIdea}

请出 1 道新题：
- 词汇题：换一个新的句子语境，给 4 个选项（同词性、同形态），正确答案可以是原题的词或它的近义词
- 阅读・听力题：写一段 80–150 词的英文短文，再加设问和 4 个选项，考同样的解题套路
- problem：题目（英文，选项写成 1–4）
- changed：用${L}一句话说明这道题练的是什么
- steps：解题过程（用${L}，引用根据）
- answer：正确答案（编号加内容）
出题后自己检查一遍，确保只有一个正确答案。`;
  return { system, user };
}

function chemVariantPrompt({ problem, settings }) {
  const L = explLang(settings);
  const system = `你是${CHEM}的出题老师。你要出一道和原题同一单元、考同一个知识点或解题套路的新题。`;
  const user = `原题：
${problem.problemText}

单元：${problem.topic}
解题套路：${problem.pattern}
原题的要点：${problem.keyIdea}

请出 1 道新题（共通テスト风格，日语出题，选项写成 ①〜④ 或 ①〜⑥）：
- 计算题：换数值或换物质，答案要能整除或是整齐的有效数字
- 知识题：换一组选项，考同一个知识点的不同说法
- ${CHEM_FORMAT}
- problem：题目和选项
- changed：用${L}一句话说明这道题练的是什么
- steps：解题过程（用${L}，计算题写出带单位的式子）
- answer：正确答案（编号加内容）
出题后自己检查一遍，确保只有一个正确答案。`;
  return { system, user };
}

export function tutorSystem({ subject, problem, settings }) {
  const L = explLang(settings);
  return `你是一位耐心的苏格拉底式家教，正在辅导${examOf(subject)}（部分：${subject.name}）。学生在复习一道曾经做错的过去问，目标是让他自己找到答案的根据，而不是直接看答案。

规则：
- 全部用${L}回复，${isChem(subject) ? `化学用语保留日语。${CHEM_FORMAT}` : '英文原文照常引用。'}
${isChem(subject) ? '- 计算题让学生先说出“要求什么量、先换成多少 mol”，每一步带单位。\n' : ''}
- 每次回复简短（不超过 6 行），一次只问一个问题或只推进一步。
- 先问学生：题目在问什么、他觉得根据在哪里。
- 学生说对了：简短肯定，然后推进下一步。说错了：指出哪里不对、为什么，但让他自己改。
- 连续卡住两次，再给更具体的提示（参考下方的提示列表，由弱到强）。
- 只有学生明确说“给我答案”时，才给完整解答。
- 学生发来自己写的答案照片时：检查并指出问题。
- 解完后，让学生用一句话总结这类题的解题套路，并告诉他识别信号。

参考资料（不要一次性透露给学生）：
题目：${problem.problemText || '（见图片）'}
题型：${problem.topic || ''}
解题套路：${problem.pattern || ''}
识别信号：${problem.trigger || ''}
要点：${problem.keyIdea || ''}
第一步：${problem.firstStep || ''}
提示：${(problem.hints || []).map((h, i) => `${i + 1}. ${h}`).join(' / ')}
完整步骤：${(problem.steps || []).map((s, i) => `${i + 1}. ${s.title}：${s.detail}`).join(' / ')}
答案：${problem.answer || ''}
陷阱：${(problem.pitfalls || []).join(' / ')}`;
}

// ---------------- 英作文（要約・意見論述）批改 ----------------

export function essayPrompt({ task, text, wordCount, settings }) {
  const L = explLang(settings);
  const isSum = task.type === 'summary';
  const system = `你是${EXAM}英作文的资深阅卷老师，熟悉官方的四个评分观点（内容・構成・語彙・文法，各 0–4 分）。评分要严格、具体，目标是帮学生在考试中多拿分。`;
  const user = `题型：${isSum ? '要約（60〜70 語）' : '意見論述（120〜150 語）'}
${isSum ? `【原文】\n${task.passage}` : `【TOPIC】${task.topic}\n【POINTS】${task.points.join(' / ')}`}

【学生的答案】（${wordCount} 词）
${text}

评分规则：
- 四个观点各打 0–4 的整数分，total 是合计（满分 16）。
  - 内容：${isSum ? '是否抓住了原文所有段落的要点，有没有加入原文以外的个人意见' : '是否明确回答了 TOPIC，是否用了 POINTS 里的两个观点，并给出了具体的理由或例子'}
  - 構成：${isSum ? '要点之间的逻辑关系是否清楚（连接词用得对不对）' : '是否有序论・本论（两个理由）・结论的结构，段落之间是否连贯'}
  - 語彙：用词是否准确、多样${isSum ? '；是否用自己的话改写（paraphrase），而不是照抄原文' : ''}
  - 文法：语法错误的多少和严重程度，句式是否多样
- 字数不在规定范围内时，要在 verdict 和对应的观点里指出（会被扣分）。
- 和题目无关的内容在“内容”上要严重扣分。

请输出（说明文字用${L}）：
- scores：content / structure / vocabulary / grammar
- total：合计
- verdict：一句话总评
- good：做得好的地方 1–3 条
- issues：需要改的地方，最多 10 条。category（内容 / 構成 / 語彙 / 文法）、original（学生的原句或片段）、fixed（改正后的英文）、why（为什么，用${L}）
- improved：保留学生的观点和结构，改写成准1级合格水平的完整范文（英文，字数在规定范围内）
- phrases：从 improved 中挑 3–5 个值得背的表达：en（英文表达）、ja（意思，用${L}）`;
  return { system, user };
}

// ---------------- Feynman mode ----------------

function feynmanRef(reference, subject) {
  return reference
    ? `参考资料（讲解者看不到，只用来判断对错和遗漏，不要照抄给他）：\n${reference}`
    : `没有参考资料，请用你对${isChem(subject) ? `${CHEM}范围内化学知识` : `${EXAM}所需英语知识`}的理解来判断对错和遗漏。`;
}

// Keeps both the questions and the grading inside what the exam can ask.
function feynmanScope(reference, subject) {
  if (isChem(subject)) {
    return reference
      ? '范围以参考资料为准：资料里有的才算考试范围。资料里没有的内容（化学（专门科目）才学的内容、大学水平的理论等）一律视为超纲。'
      : '范围是高中「化学基礎」的教科书内容。化学（专门科目）才学的内容（化学平衡、熱化学、有机化学的细节等）和大学水平的理论一律视为超纲。';
  }
  return reference
    ? `范围以参考资料为准：资料里有的才算考试范围。资料里没有的内容（语言学理论、冷僻用法、学术细节等）一律视为超纲。`
    : `范围是${EXAM}需要的英语知识（词汇、语法、阅读・写作的技巧，以及常见社会话题的背景）。学术研究级别的内容一律视为超纲。`;
}

export function feynmanStudentSystem({ subject, topic, reference, stretch, settings }) {
  const L = explLang(settings);
  return `你在扮演“小明”：一个聪明、好奇，但对这个知识完全不懂的初中二年级学生。
一位高中生正在用费曼学习法给你讲解「${topic}」（${examOf(subject)}・${subject.name}）。你的任务是用提问帮他发现自己哪里没真正懂。

规则：
- 用${L}，语气像好奇的初中生，每次回复简短（不超过 4 行），一次最多问 2 个问题。
- 专门追问这些地方：讲得模糊的、跳步的、用了术语却没解释的、只背了结论没讲“为什么”的、和参考资料不一致的。
- 你是“不懂的学生”，不要直接纠正或讲答案，而是用问题让他自己发现，例如“为什么会这样？”“○○是什么意思？”“能举个${isChem(subject) ? '具体的例子' : '英文例子'}吗？”。
- 他讲错时，用“可是我好像听说……？”这种方式追问。
- 他讲清楚的地方，简短地说“懂了！”并复述你懂了什么（复述可以稍微简化，看他会不会纠正你）。
- 如果你觉得重要的地方都懂了，就说“我全懂了！可以点「结束并评分」啦 🎉”。

提问范围（非常重要，这是为考试复习，不是做研究）：
- ${feynmanScope(reference, subject)}
${stretch
    ? `- 主要问范围内的问题。偶尔（大约每 3 轮最多 1 次）可以问一个超出范围、但能加深理解的拓展问题，开头必须标「🔭拓展：」，让他知道这题不考。拓展问题也要是高中生能想的程度。
- 范围内的问题，问“为什么”之前先确认范围内有答案。`
    : '- 只问在范围内能找到答案的问题。问“为什么”之前，先确认范围内有答案；没有就不要问。'}
- 不要钻牛角尖：同一个点最多追问一次，他答得基本对就放过，去问下一个要点。
- 如果他说“超纲”“资料上没有”“跳过”，马上说“好的～”并换一个问题，不要再纠缠。
- 记录里标着【老师的解说】的是老师替他回答的内容，不是他讲的。之后可以请他用自己的话复述一下老师讲的要点。
- 优先追问考试最可能用到的要点。

${feynmanRef(reference, subject)}`;
}

export function feynmanEvalPrompt({ subject, topic, reference, transcript, settings }) {
  const L = explLang(settings);
  const system = `你是费曼学习法教练，也是${examOf(subject)}的专家。你要评价一位高中生对「${topic}」的讲解，找出他的知识漏洞，并把漏洞变成复习用的闪卡。`;
  const user = `部分：${subject.name}
主题：${topic}

${feynmanRef(reference, subject)}

讲解记录（“讲解者”是高中生，“小明”是扮演初中生的 AI，“老师”是讲解者答不上来时 AI 给的解说）：
${transcript}

评分范围：${feynmanScope(reference, subject)}

请评价，说明文字全部用${L}：
- score：0–100 的整数。准确性 40 分 + 完整性 30 分（对照考试会用到的要点）+ 用自己的话讲清楚（不是照背）20 分 + 能举${exampleOf(subject)}或打比方 10 分。
- verdict：一句话总评，要具体，带点鼓励。
- 注意：“老师”解说的内容不是讲解者讲的，不能算进 covered。老师解说过的范围内要点，除非讲解者之后用自己的话复述对了，否则算进 missing。
- covered：他讲对、讲清楚的要点（每条一句）。
- missing：范围内、考试会用到、但他没讲到的要点（每条一句）。超纲的内容不算漏掉、不扣分。
- wrong：讲错或混淆的地方：point=他怎么说的，fix=正确说法。小明问到超纲问题而他答不上来的，不算错。
- simpler：示范一段更简单的讲法（150 字以内，最好有比喻），让他下次讲得更好。
- cards：只针对 missing 和 wrong 的要点做闪卡（0–8 张，讲对的不要做，超纲的不要做）。${isChem(subject) ? `front 是问题、back 是答案（日语用语）；${CHEM_FORMAT}` : '英文表达类 front 写意思、back 写英文；其他 front 是问题、back 是答案；'}note 用${L}写一句提示。`;
  return { system, user };
}

export function feynmanTeacherPrompt({ subject, topic, reference, transcript, settings }) {
  const L = explLang(settings);
  const system = `你是一位讲解清楚的${teacherOf(subject)}（部分：${subject.name}）。学生在用费曼学习法给“小明”（AI 扮演的初中生）讲「${topic}」，小明最后问的问题学生答不上来。请你直接解说这个问题的答案，省得学生自己去查。`;
  const user = `${feynmanRef(reference, subject)}

讲解记录：
${transcript}

请解说小明最后一个问题的答案，规则：
- 用${L}，${isChem(subject) ? `化学用语保留日语。${CHEM_FORMAT}` : '英文例子照常用英文写。'}
- 第一行标明：「📘 考试范围内」或「🔭 拓展（不考）」。
- 先用一句话直接回答，再用 2–5 行解释为什么，能举${exampleOf(subject)}就举例。
- 先依据参考资料；资料里没有的，用${isChem(subject) ? '化学基礎的教科书知识' : `${EXAM}需要的英语知识`}解释。
- 不确定的内容要说明“不确定，建议查${isChem(subject) ? '教科书或图录' : '词典或参考书'}”，绝对不要编造。
- 最后一句请学生用自己的话把这个答案复述给小明听。`;
  return { system, user };
}

// Prompt the student can paste into the free Claude / ChatGPT app together
// with the same photos when they have no API key.
export function manualPrompt({ system, user }, schemaName) {
  const example = JSON.stringify(skeleton(SCHEMAS[schemaName]), null, 1);
  return `${system}

${user}

【输出格式】只输出一个 JSON 对象（不要任何其他文字、不要代码块标记），结构如下：
${example}`;
}

function skeleton(schema) {
  if (schema.type === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(schema.properties)) o[k] = skeleton(v);
    return o;
  }
  if (schema.type === 'array') return [skeleton(schema.items)];
  if (schema.enum) return schema.enum.join(' | ');
  if (schema.type === 'integer') return 0;
  return '...';
}

export function parseLooseJSON(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('没找到 JSON。请确认复制了 AI 的完整回复。');
  return JSON.parse(t.slice(a, b + 1));
}

// ---------------- API ----------------

export class AIError extends Error {}

function client(settings) {
  if (!settings.apiKey) throw new AIError('还没有设置 API Key（设置 → AI）。也可以用“免费：复制提示词”方式。');
  return new Anthropic({ apiKey: settings.apiKey.trim(), dangerouslyAllowBrowser: true, maxRetries: 2 });
}

export function imageBlock(b64) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } };
}

async function send(settings, params) {
  const c = client(settings);
  const base = { model: settings.model || MODELS[0].id, max_tokens: 16000, ...params };
  let res;
  try {
    try {
      // Server-side fallback: if the main model declines, the API retries on
      // a recommended fallback model inside the same call.
      res = await c.beta.messages.create({
        ...base,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (e) {
      if (!(e instanceof Anthropic.BadRequestError)) throw e;
      res = await c.messages.create(base);
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AIError('API Key 无效，请到设置里检查。');
    if (e instanceof Anthropic.PermissionDeniedError) throw new AIError('这个 API Key 没有权限使用该模型。');
    if (e instanceof Anthropic.RateLimitError) throw new AIError('请求太频繁或额度不足，稍等一下再试（或检查 console.anthropic.com 的余额）。');
    if (e instanceof Anthropic.BadRequestError) throw new AIError('请求被拒绝：' + (e.message || '') + '（照片太多/太大时也会这样，可以分批）');
    if (e instanceof Anthropic.APIConnectionError) throw new AIError('网络连接失败，检查网络后重试。');
    if (e instanceof Anthropic.APIError) throw new AIError(`AI 服务错误 ${e.status ?? ''}：${e.message}`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new AIError('AI 拒绝处理这张图片，换一张试试。');
  if (res.stop_reason === 'max_tokens') throw new AIError('内容太多，输出被截断了。请减少一次上传的照片数（建议 1–3 张）。');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { text, usage: res.usage };
}

export async function generateJSON(settings, { system, user }, images, schemaName, effort = 'medium', maxTokens = 16000) {
  const content = [...images.map(imageBlock), { type: 'text', text: user }];
  const { text } = await send(settings, {
    system,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
    output_config: { effort, format: { type: 'json_schema', schema: SCHEMAS[schemaName] } },
  });
  try {
    return JSON.parse(text);
  } catch {
    return parseLooseJSON(text);
  }
}

// messages: [{role, content}] already in API shape (consecutive roles merged by caller)
export async function chat(settings, system, messages, effort = 'low') {
  const { text } = await send(settings, {
    system,
    messages,
    max_tokens: 4000,
    output_config: { effort },
  });
  return text;
}

export async function testKey(settings) {
  const { text } = await send(settings, {
    max_tokens: 1000,
    messages: [{ role: 'user', content: '只回复两个字：成功' }],
    output_config: { effort: 'low' },
  });
  return text;
}
