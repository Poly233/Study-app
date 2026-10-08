# 卡包（packs）

Claude 在聊天里根据照片做好的内容放在这里，App 的 **拍照 → 📦 导入卡包** 会读取 `index.json` 并导入。

- `index.json`：`{ "packs": [ { id, title, subject, kind, file, created, count } ] }`，由 `tools/pack.py` 维护
- `<id>.json`：卡包本体
- `img/`：错题照片等（这个仓库公开时照片也公开，别拍到名字）

科目 id：`math2` 数学Ⅱ・`mathB` 数学B・`phys` 物理・`chem` 化学・`kokyo` 公共・`joho` 情報

## 三种卡包

**闪卡（プリント・问题集暗记题）**
```json
{ "id": "...", "kind": "cards", "subject": "kokyo", "sourceKind": "print",
  "title": "公共 プリントNo.5 民主政治の原理", "summary": "- 要点（考前一页纸，Markdown）",
  "cards": [ { "type": "qa|cloze", "front": "日语问题", "back": "日语答案", "note": "中文提示", "importance": 1-3 } ],
  "images": [] }
```

**错题**（`analysis` 字段和 App 里 AI 解析的结构一样）
```json
{ "id": "...", "kind": "problem", "subject": "math2", "title": "PRIME 123 接線", "ref": "PRIME 123",
  "reason": ["没思路"], "note": "",
  "analysis": { "title", "ref", "problemText", "topic", "pattern", "trigger", "keyIdea", "firstStep",
                "hints": [], "steps": [ { "title", "detail" } ], "answer", "pitfalls": [], "formulas": [],
                "recallFront", "recallBack" },
  "images": ["packs/img/xxx.jpg"], "solutionImages": [] }
```

**补课**（`lesson` 字段和 App 里补课的结构一样，`lesson.cards` 会变成闪卡）
```json
{ "id": "...", "kind": "lesson", "subject": "chem", "title": "...",
  "lesson": { "title", "overview", "prerequisites": [], "sections": [ { "heading", "explain", "example", "checkQ", "checkA" } ],
              "keyPoints": [], "formulas": [], "cards": [] },
  "images": [] }
```

## 发布

```
python3 tools/pack.py packs/<id>.json      # 检查格式并登记到 index.json
python3 tools/pack.py --image <照片> <名字>  # 缩小照片并存到 packs/img/<名字>.jpg
```
