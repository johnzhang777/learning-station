"""Build the two Grade 6 calendars from the revised upper and older lower PEP lists."""
import argparse
import collections
import json
import re

from build_grade5 import ROOT, build, parse_stories, rows

SRC = ROOT / 'source/grade6'
EARLIER = ('data.json', 'spring-data.json', 'grade5-autumn-data.json', 'grade5-spring-data.json')
TERMS = {
    'autumn': {
        'grade': 6, 'id': 'english-2028-grade6-autumn', 'prefix': 'h', 'storyPrefix': 'x',
        'label': '六年级上学期', 'sourceTag': '六上', 'start': '2028-09-01',
        'end': '2029-01-15', 'review': '2028-12-16', 'book': '1212001601265',
        'support': '6s', 'appendix': 'Appendix 2 Words in each unit (pp.81–84)',
        'textbook': '新版人教PEP英语六年级上册（当前公开版）',
        'editionNote': '依据当前人教社公开新版六上教材核对。2028-2029学年实际用书请以学校发放版本为准。',
        'unitDays': [14, 14, 11, 10, 14, 13],
        'units': ['Amazing places', 'Getting together', 'Healthy life', 'Managing money well',
                  'Exploring space', 'Energy, nature and us'],
        'themes': ['地标与旅行', '聚会与活动', '健康与作息', '零花钱与消费', '太空与观测', '能源与环保'],
    },
    'spring': {
        'grade': 6, 'id': 'english-2029-grade6-spring', 'prefix': 'j', 'storyPrefix': 'y',
        'label': '六年级下学期', 'sourceTag': '六下旧版', 'start': '2029-02-15',
        'end': '2029-07-31', 'review': '2029-07-01', 'book': '1212001602145',
        'support': '6x', 'supportPath': 'yyptypzj',
        'appendix': 'Appendix 2 Words in each unit (pp.54–56)',
        'sourceEdition': '旧版人教PEP', 'editionLabel': '旧版过渡资料',
        'textbook': '旧版人教PEP英语六年级下册（三年级起点，2013年审定）',
        'editionNote': '过渡资料，按公开旧版六下教材编排。2029年春季请对照学校实际用书的单元与词表。',
        'unitDays': [24, 24, 25, 24],
        'units': ['How tall are you?', 'Last weekend', 'Where did you go?', 'Then and now'],
        'themes': ['比较与测量', '周末与日常', '旅行与户外', '今昔与校园运动'],
    },
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--term', choices=TERMS)
    args = parser.parse_args()
    old = collections.defaultdict(list)
    for filename in EARLIER:
        course = json.loads((ROOT / 'dist' / filename).read_text('utf-8'))
        for entry in course['entries']:
            old[entry['word'].casefold()].append({**entry, 'courseId': course['id']})

    textbook = rows('textbook.tsv', SRC)
    core_words = {row[3].casefold() for row in textbook}
    assert len({tuple(row[:4]) for row in textbook}) == len(textbook)
    extensions = [row[2].casefold() for row in rows('extensions.tsv', SRC)]
    assert len(set(extensions)) == len(extensions)
    assert not (set(extensions) & (set(old) | core_words))

    pronunciations = json.loads((SRC / 'pronunciations.json').read_text('utf-8'))
    stories = parse_stories(SRC)
    for story in stories:
        assert len(story['questions']) == 3 and len(story['cloze']) == 2
        assert len(story['paragraphs']) == len(story['translation'])
        assert story['oral'] and story['oralExample'] and len(story['retell']) >= 3
        passage = ' '.join(story['paragraphs'])
        for focus in story['focus']:
            assert re.search(r'(?<!\w)' + re.escape(focus) + r'(?!\w)', passage, re.I), (story['title'], focus)

    for term in [args.term] if args.term else TERMS:
        build(term, TERMS[term], pronunciations, old, stories, SRC)


if __name__ == '__main__':
    main()
