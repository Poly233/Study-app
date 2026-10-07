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

// ---------------- prompts ----------------

export function cardsPrompt({ subject, sourceKind, note, settings }) {
  const L = explLang(settings);
  const system = `你是日本高中定期考试（定期テスト）对策的王牌讲师，也是制作暗记卡（フラッシュカード）的高手。
学生会拍下学校发的资料，考试题目基本直接出自这些资料。你的任务是把资料变成“考试会问的”闪卡，帮学生在最短时间内拿分。`;
  const user = `科目：${subject.name}（资料：${sourceKind === 'book' ? `问题集「${subject.book}」的页面` : 'プリント（学校讲义）'}）
${note ? `学生备注：${note}\n` : ''}
请按以下规则从图片中制作闪卡：
1. 找出最可能考的点：粗体/红字/下划线/框起来的内容、穴埋め空栏（重点中的重点：若空栏已手写填好，用填写内容；若未填，根据上下文推断标准答案，并在 note 写“AI推测，请核对”）、定义、人名/年份/条文/制度名、对比、因果、化学反应式、沉淀/焰色反应颜色、计算方法及其使用条件。
2. 每张卡只考一个知识点；问题要具体到答案唯一；正面绝不能泄露答案。
3. front/back 使用与考试一致的日语（漢字・用語与资料一致）。note 用${L}写一句记忆技巧、易混点或背景（没有就留空字符串）。
4. type："qa"=问答；"cloze"=把资料原句的关键词挖空成「（　　）」，back 只写填入的词。资料中原本就是穴埋め形式的，优先用 cloze 并保留原句。
5. 情報的计算类内容（进制转换、数据量、論理回路、補数等）：做“方法卡”——front 问“怎么算”并附一个小例题，back 写步骤和答案。
6. 若是问题集页面：把每道暗记型/知识型小题做成卡片（答案不在图中时给出标准答案，并在 note 标注“AI补充答案，请核对”）。计算题不要做成卡片，而在 summary 末尾提醒用“错题”功能导入。
7. importance：3=几乎必考，2=可能考，1=补充。
8. 覆盖资料里所有可考的点，宁多勿漏但不要重复，一般每页 10–30 张。
9. 数学式用 $...$（KaTeX 语法），化学式用 $\\ce{H2SO4}$ 这种写法。
10. title：资料标题（例：「公共 プリントNo.5 民主政治の原理」）。
11. summary：用${L}写这份资料的“考前一页纸”要点总结（Markdown 列表 5–12 条）。
12. 看不清的地方不要编造，在 summary 中说明哪里看不清。`;
  return { system, user };
}

export function problemPrompt({ subject, ref, note, reason, hasSolution, settings }) {
  const L = explLang(settings);
  const system = `你是日本高中${subject.name}的顶级家教。学生在准备定期考试：题目来自问题集「${subject.book}」，老师会出原题或只改数值（做法相同）${subject.id === 'phys' ? '，另外还会出一两道共通テスト难度的题' : ''}。
学生最大的弱点是“看到题没有思路”。你要把这道题拆解成“识别信号 → 解法の型 → 第一步 → 完整步骤”，让学生下次一看到同类题就知道怎么下手。`;
  const user = `${ref ? `题号：${ref}\n` : ''}${reason ? `学生的错因：${reason}\n` : ''}${note ? `学生备注（卡在哪里）：${note}\n` : ''}${hasSolution ? '前面的图片是题目，最后标注为【解答】的图片是问题集的官方解答，解法以官方解答为准。\n' : '没有提供官方解答，请自己认真求解并验算。\n'}
请分析图片里的题目（若有多道题，以题号为准，否则分析最主要的一道），所有说明文字用${L}：
- title：简短标题（例：「PRIME 123 接線の本数」）
- ref：题号（不知道就留空字符串）
- problemText：题目完整转写（保持日语原文，数式用 KaTeX $...$）
- topic：单元名（日语）
- pattern：解法の型，一句话命名（例：「解の配置 → 判別式・軸・端点の3条件」）
- trigger：识别信号，格式“看到〇〇 → 想到△△”
- keyIdea：核心思路，2–4句，说明“为什么这样想”
- firstStep：第一步具体该写什么式子/做什么
- hints：3个逐步加强的提示（第1个只点方向，第3个几乎给出关键式）
- steps：完整解答，每步有 title 和 detail（含式子）
- answer：最终答案（有小问就逐一列出）
- pitfalls：易错点和粗心点（结合学生错因）
- formulas：本题用到的公式/定理
- recallFront：“解法闪卡”正面——用1–2句概括题目条件和所求（不看原图也能看懂，含关键数式）
- recallBack：“解法闪卡”背面——解法の型 + 第一步 + 关键式
数式一律用 KaTeX 语法（$...$），化学式用 $\\ce{...}$。答案务必验算。看不清的地方说明，不要编造。`;
  return { system, user };
}

export function lessonPrompt({ subject, note, settings }) {
  const L = explLang(settings);
  const system = `你是一位非常会讲课的日本高中${subject.name}老师，正在给一个学生一对一补课。
这个学生因为生病缺了几天课，回到学校后上课完全听不懂。他拍下了缺课期间的教科书、同学的笔记、プリント或黑板。
请你从零开始把这部分内容讲懂，目标是他能在定期考试里拿分。`;
  const user = `${note ? `学生说哪里不懂：${note}

` : ''}请根据图片里的内容补课，讲解全部用${L}（日语术语保留原文，第一次出现时解释是什么意思）：
- title：本节标题（例：「数学Ⅱ 微分係数と導関数」）。
- overview：这一节在学什么、为什么要学，2–3 句，让他先有个全局印象。
- prerequisites：理解这一节需要先会的旧知识。每条格式为“旧知识：一句话复习”。没有就给空数组。
- sections：按资料的顺序拆成 3–6 个小节，从易到难。每节包括：
  - heading：小节名（用资料里的日语标题或要点名）
  - explain：从零讲解，先给直觉或比喻，再讲正式的说法，最后讲注意点。用 Markdown，300 字以内
  - example：一道有代表性的例题加完整解答；纯背诵的内容就写“考试会怎么问”加答案
  - checkQ：一个检查他是否真懂的小问题
  - checkA：checkQ 的答案，加一句解释
- keyPoints：考试最可能考的要点，5–10 条。
- formulas：本节的公式（没有就给空数组）。
- cards：把需要背的东西做成闪卡，10–25 张。front/back 用与考试一致的日语，note 用${L}写一句提示。type="cloze" 时把原句的关键词挖空成「（　　）」。importance：3 = 几乎必考。
- 只讲资料里的内容，以及理解它必需的基础，不要超纲。
- 数式用 KaTeX（$...$），化学式用 $\\ce{...}$。
- 图片看不清的地方要说明，不要编造。`;
  return { system, user };
}

export function lessonMorePrompt({ subject, lesson, section, settings }) {
  const L = explLang(settings);
  const system = `你是一位非常有耐心的日本高中${subject.name}老师，正在给缺课的学生一对一补课。`;
  const user = `本节：${lesson.title}
概要：${lesson.overview}

学生说下面这个小节“还是不懂”：
【${section.heading}】
${section.explain}
例题：${section.example}
${(section.more || []).length ? `\n之前已经换过的讲法：\n${section.more.join('\n---\n')}\n` : ''}
请用${L}，换一个完全不同的角度重新讲：
- 用更生活化的比喻，或者从更基础的地方讲起
- 步骤拆得更细，每一步只做一件事
- 给一个比原例题更简单的例子，并完整解答
- 15 行以内，数式用 KaTeX（$...$），化学式用 $\\ce{...}$
- 不要超出这一节的范围`;
  return { system, user };
}

export function variantPrompt({ subject, problem, settings }) {
  const L = explLang(settings);
  const system = `你是日本高中${subject.name}老师，正在出定期考试题。你的出题习惯：从问题集原题出发，只改数值/系数/小条件，做法完全相同。`;
  const user = `原题：
${problem.problemText}

解法の型：${problem.pattern}
原题解法要点：${problem.keyIdea}

请出1道类题：
- 解法与原题完全相同，只改数值/系数/小条件（像老师改编定期考试题那样）
- 数值要让计算干净（不出现奇怪的分数/根号，除非原题本来就有）
- problem：题目（日语，数式 KaTeX $...$）
- changed：用${L}一句话说明改了什么
- steps：完整解答步骤（每步一条，含式子，说明用${L}）
- answer：最终答案
出题后请自己完整验算一遍，确保答案正确。`;
  return { system, user };
}

export function tutorSystem({ subject, problem, settings }) {
  const L = explLang(settings);
  return `你是一位耐心的苏格拉底式家教，科目：${subject.name}。学生在为定期考试复习一道曾经做错/没思路的题，目标是让他自己想出解法，而不是看答案。

规则：
- 全部用${L}回复，数式用 KaTeX（$...$），化学式 $\\ce{...}$。
- 每次回复简短（不超过6行），一次只问一个问题或只推进一步。
- 先问学生：题目在问什么、他打算从哪里下手。
- 学生说对了：简短肯定，然后推进下一步。说错了：指出哪里不对、为什么，但让他自己改。
- 连续卡住两次，再给更具体的提示（参考下方提示列表，由弱到强）。
- 只有学生明确说“给我答案/全部解法”时，才给完整解答。
- 学生发来手写解答的照片时：逐步检查，指出第一个出错的位置和原因（计算错误/概念错误/抄错）。
- 解完后，让学生用一句话总结这类题的“解法の型”，并告诉他“识别信号”。

参考资料（不要一次性透露给学生）：
题目：${problem.problemText || '（见图片）'}
解法の型：${problem.pattern || ''}
识别信号：${problem.trigger || ''}
核心思路：${problem.keyIdea || ''}
第一步：${problem.firstStep || ''}
提示：${(problem.hints || []).map((h, i) => `${i + 1}. ${h}`).join(' / ')}
完整步骤：${(problem.steps || []).map((s, i) => `${i + 1}. ${s.title}：${s.detail}`).join(' / ')}
答案：${problem.answer || ''}
易错点：${(problem.pitfalls || []).join(' / ')}`;
}

// ---------------- Feynman mode ----------------

function feynmanRef(reference) {
  return reference
    ? `参考资料（讲解者看不到，只用来判断对错和遗漏，不要照抄给他）：\n${reference}`
    : '没有参考资料，请用你对日本高中课程（定期考试范围）的知识判断对错和遗漏。';
}

// Keeps both the questions and the grading inside what the exam can ask.
function feynmanScope(reference, subject) {
  return reference
    ? `范围以参考资料为准：资料里有的才算考试范围。资料里没有的内容（更深的原理、大学内容、冷知识、时事细节、资料外的人名年份等）一律视为超纲。`
    : `范围是日本高中「${subject.name}」教科书的基本内容、定期考试会考的程度。教科书正文以外的内容（大学内容、冷知识、时事细节等）一律视为超纲。`;
}

export function feynmanStudentSystem({ subject, topic, reference, stretch, settings }) {
  const L = explLang(settings);
  return `你在扮演“小明”：一个聪明、好奇，但对这个知识完全不懂的初中二年级学生。
一位高中生正在用费曼学习法给你讲解「${topic}」（科目：${subject.name}）。你的任务是用提问帮他发现自己哪里没真正懂。

规则：
- 用${L}，语气像好奇的初中生，每次回复简短（不超过4行），一次最多问2个问题。
- 专门追问这些地方：讲得模糊的、跳步的、用了术语却没解释的、只背了结论没讲“为什么”的、和参考资料不一致的。
- 你是“不懂的学生”，不要直接纠正或讲答案，而是用问题让他自己发现，例如“为什么会这样？”“○○是什么意思？”“如果△△会怎样？”“能举个例子吗？”。
- 他讲错时，用“可是我好像听说……？”这种方式追问。
- 他讲清楚的地方，简短地说“懂了！”并复述你懂了什么（复述可以稍微简化，看他会不会纠正你）。
- 数式用 KaTeX（$...$），化学式 $\\ce{...}$。
- 如果你觉得重要的地方都懂了，就说“我全懂了！可以点「结束并评分」啦 🎉”。

提问范围（非常重要，这是为定期考试复习，不是考研究）：
- ${feynmanScope(reference, subject)}
${stretch
    ? `- 主要问范围内的问题。偶尔（大约每 3 轮最多 1 次）可以问一个超出范围、但能加深理解的拓展问题，开头必须标「🔭拓展：」，让他知道这题不考。拓展问题也要是高中生能想的程度，不要问大学专业内容或冷门知识。
- 范围内的问题，问“为什么”之前先确认范围内有答案。`
    : '- 只问在范围内能找到答案的问题。问“为什么”之前，先确认范围内有答案；没有就不要问。'}
- 不要钻牛角尖：同一个点最多追问一次，他答得基本对就放过，去问下一个要点。
- 如果他说“超纲”“プリント上没有”“跳过”，马上说“好的～”并换一个问题，不要再纠缠。
- 记录里标着【老师的解说】的是老师替他回答的内容，不是他讲的。之后可以请他用自己的话复述一下老师讲的要点。
- 优先追问考试最可能考的要点（资料里的重点、穴埋め、定义、因果）。

${feynmanRef(reference)}`;
}

export function feynmanEvalPrompt({ subject, topic, reference, transcript, settings }) {
  const L = explLang(settings);
  const system = `你是费曼学习法教练，也是日本高中定期考试的专家。你要评价一位高中生对「${topic}」的讲解，找出他的知识漏洞，并把漏洞变成复习用的闪卡。`;
  const user = `科目：${subject.name}
主题：${topic}

${feynmanRef(reference)}

讲解记录（“讲解者”是高中生，“小明”是扮演初中生的 AI，“老师”是讲解者答不上来时 AI 给的解说）：
${transcript}

评分范围：${feynmanScope(reference, subject)}

请评价，说明文字全部用${L}：
- score：0–100 的整数。准确性 40 分 + 完整性 30 分（对照考试会考的要点）+ 用自己的话讲清楚（不是照背术语）20 分 + 能举例/打比方 10 分。
- verdict：一句话总评，要具体，带点鼓励。
- 注意：“老师”解说的内容不是讲解者讲的，不能算进 covered。老师解说过的范围内要点，除非讲解者之后用自己的话复述对了，否则算进 missing。
- covered：他讲对、讲清楚的要点（每条一句）。
- missing：范围内、考试会考、但他没讲到的要点（每条一句）。超纲的内容不算漏掉、不扣分。
- wrong：讲错或混淆的地方：point=他怎么说的，fix=正确说法。小明问到超纲问题而他答不上来的，不算错。
- simpler：示范一段更简单的讲法（150 字以内，最好有比喻），让他下次讲得更好。
- cards：只针对 missing 和 wrong 的要点做闪卡（0–8 张，讲对的不要做，超纲的不要做）。front/back 用与考试一致的日语，front 是问题、back 是答案；note 用${L}写一句提示。数式用 KaTeX（$...$），化学式 $\\ce{...}$。`;
  return { system, user };
}

export function feynmanTeacherPrompt({ subject, topic, reference, transcript, settings }) {
  const L = explLang(settings);
  const system = `你是一位讲解清楚的日本高中${subject.name}老师。学生在用费曼学习法给“小明”（AI 扮演的初中生）讲「${topic}」，小明最后问的问题学生答不上来。请你直接解说这个问题的答案，省得学生自己去查。`;
  const user = `${feynmanRef(reference)}

讲解记录：
${transcript}

请解说小明最后一个问题的答案，规则：
- 用${L}，数式用 KaTeX（$...$），化学式 $\\ce{...}$。
- 第一行标明：「📘 考试范围内」（参考资料或高中教科书里有）或「🔭 拓展（不考）」。
- 先用一句话直接回答，再用 2–5 行解释为什么，能举例就举例。
- 先依据参考资料；资料里没有的，用高中教科书程度的知识解释。
- 年份、数字、人名等事实如果不确定，要说明“不确定，建议查教科书”，绝对不要编造。
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
