#!/usr/bin/env python3
"""Validate a pack and register it in packs/index.json.

  python3 tools/pack.py packs/<id>.json
  python3 tools/pack.py --image <photo> <name>   -> packs/img/<name>.jpg (resized)
"""
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKS = ROOT / 'packs'
SUBJECTS = {'math2', 'mathB', 'phys', 'chem', 'kokyo', 'joho'}
JST = timezone(timedelta(hours=9))

PROBLEM_KEYS = ['title', 'ref', 'problemText', 'topic', 'pattern', 'trigger', 'keyIdea', 'firstStep',
                'hints', 'steps', 'answer', 'pitfalls', 'formulas', 'recallFront', 'recallBack']
LESSON_KEYS = ['title', 'overview', 'prerequisites', 'sections', 'keyPoints', 'formulas', 'cards']


def fail(msg):
    sys.exit(f'✗ {msg}')


def check_cards(cards, where):
    if not isinstance(cards, list):
        fail(f'{where}: cards must be a list')
    for i, c in enumerate(cards):
        for k in ('type', 'front', 'back'):
            if not c.get(k):
                fail(f'{where}: card {i} missing {k}')
        if c['type'] not in ('qa', 'cloze'):
            fail(f'{where}: card {i} bad type {c["type"]}')
        if c.get('importance', 2) not in (1, 2, 3):
            fail(f'{where}: card {i} bad importance')


def check(pack, path):
    for k in ('id', 'kind', 'subject', 'title'):
        if not pack.get(k):
            fail(f'missing {k}')
    if pack['subject'] not in SUBJECTS:
        fail(f'unknown subject {pack["subject"]}')
    if path.stem != pack['id']:
        fail(f'file name must be {pack["id"]}.json')
    kind = pack['kind']
    if kind == 'cards':
        check_cards(pack.get('cards'), 'cards')
        count = len(pack['cards'])
    elif kind == 'problem':
        a = pack.get('analysis') or {}
        missing = [k for k in PROBLEM_KEYS if k not in a]
        if missing:
            fail(f'analysis missing {missing}')
        if not a['steps'] or not all('title' in s and 'detail' in s for s in a['steps']):
            fail('analysis.steps need title/detail')
        count = 1
    elif kind == 'lesson':
        l = pack.get('lesson') or {}
        missing = [k for k in LESSON_KEYS if k not in l]
        if missing:
            fail(f'lesson missing {missing}')
        for i, s in enumerate(l['sections']):
            for k in ('heading', 'explain', 'example', 'checkQ', 'checkA'):
                if k not in s:
                    fail(f'lesson section {i} missing {k}')
        check_cards(l['cards'], 'lesson')
        count = len(l['cards'])
    else:
        fail(f'unknown kind {kind}')
    for img in pack.get('images', []) + pack.get('solutionImages', []):
        if not (ROOT / img).is_file():
            fail(f'image not found: {img}')
    return count


def add(path):
    path = Path(path)
    pack = json.loads(path.read_text(encoding='utf-8'))
    count = check(pack, path)
    index_path = PACKS / 'index.json'
    index = json.loads(index_path.read_text(encoding='utf-8'))
    entries = [e for e in index['packs'] if e['id'] != pack['id']]
    old = next((e for e in index['packs'] if e['id'] == pack['id']), None)
    entries.append({
        'id': pack['id'], 'title': pack['title'], 'subject': pack['subject'], 'kind': pack['kind'],
        'file': path.name, 'count': count,
        'created': old['created'] if old else datetime.now(JST).isoformat(timespec='minutes'),
    })
    index['packs'] = entries
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'✓ {pack["kind"]} · {pack["subject"]} · {pack["title"]} · {count}')


def image(src, name):
    from PIL import Image, ImageOps
    im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
    im.thumbnail((1600, 1600))
    out = PACKS / 'img' / f'{name}.jpg'
    im.save(out, 'JPEG', quality=82)
    print(f'✓ {out.relative_to(ROOT)} {im.size}')


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--image':
        image(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 2:
        add(sys.argv[1])
    else:
        sys.exit(__doc__)
