# 卡包（packs）

Claude 在聊天里根据照片做好的内容放在这里，App 的 **拍照 → 📦 导入卡包** 会读取 `index.json` 并导入。

- `index.json`：`{ "packs": [ { id, title, subject, kind, file, created, count } ] }`，由 `tools/pack.py` 维护
- `<id>.json`：卡包本体
- `img/`：错题照片等（这个仓库公开时照片也公开，别拍到名字；有版权的教材页面不要放进来）

部分 id（英検準1級）：`vocab` 語彙・熟語・`read` 長文読解・`write` 英作文・`listen` リスニング
共通テスト：`chemb` 化学基礎（化学式用 `$\ce{H2SO4}$` 这种 mhchem 写法）

## 卡包种类

**单词卡**（`kind: "cards"`，每张卡 `type: "word"`；例句和解释必须原创，不能照抄单词书）
```json
{ "id": "...", "kind": "cards", "subject": "vocab", "title": "準1級 頻出動詞①", "summary": "- 要点",
  "cards": [ { "type": "word", "word": "alleviate", "pos": "動|名|形|副|熟", "ja": "和らげる", "zh": "减轻",
               "ex": "原创例句", "exTr": "例句翻译", "form": "例句里的形态", "cloze": "把 form 换成＿＿＿的例句",
               "distractors": ["同形态的干扰项×3"], "colloc": "搭配", "syn": "近义词", "note": "提示", "importance": 1-3 } ] }
```

**闪卡（笔记・资料）**
```json
{ "id": "...", "kind": "cards", "subject": "write",
  "title": "意見論述で使える表現", "summary": "- 要点（Markdown）",
  "cards": [ { "type": "qa|cloze", "front": "问题", "back": "答案", "note": "中文提示", "importance": 1-3,
               "distractors": ["可选：3 个和 back 同格式的错误选项 → 复习时出 4 选 1"],
               "quiz": "可选：true＝一直以 4 选 1 出现（「〇〇はどれ？」这种题）" } ],
  "images": [] }
```

**错题**（`analysis` 字段和 App 里 AI 解析的结构一样）
```json
{ "id": "...", "kind": "problem", "subject": "read", "title": "2025-1 大問3 (2)", "ref": "2025-1 大問3 (2)",
  "reason": ["找不到根据"], "note": "",
  "analysis": { "title", "ref", "problemText", "topic", "pattern", "trigger", "keyIdea", "firstStep",
                "hints": [], "steps": [ { "title", "detail" } ], "answer", "pitfalls": [], "formulas": [],
                "recallFront", "recallBack" },
  "images": ["packs/img/xxx.jpg"], "solutionImages": [] }
```

**补课**（`lesson` 字段和 App 里补课的结构一样，`lesson.cards` 会变成闪卡）
```json
{ "id": "...", "kind": "lesson", "subject": "read", "title": "...",
  "lesson": { "title", "overview", "prerequisites": [], "sections": [ { "heading", "explain", "example", "checkQ", "checkA" } ],
              "keyPoints": [], "formulas": [], "cards": [] },
  "images": [] }
```

## 发布

```
python3 tools/pack.py packs/<id>.json      # 检查格式并登记到 index.json
python3 tools/pack.py --image <照片> <名字>  # 缩小照片并存到 packs/img/<名字>.jpg
```
