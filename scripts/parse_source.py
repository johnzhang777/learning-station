"""Import the authorized Feishu snapshot without changing its text or schedule."""
import datetime as dt
import json
import re
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
WORKSPACE = SITE.parents[1]
raw_path = WORKSPACE / 'tmp/english-source.json'
envelope = json.loads(raw_path.read_text(encoding='utf-8-sig'))
assert envelope['ok'], envelope.get('error')
doc = envelope['data']['document']
root = ET.fromstring('<root>' + doc['content'] + '</root>')

def txt(el):
    return ''.join(el.itertext()).strip()

def lines(el):
    chunks = [el.text or '']
    for child in el:
        chunks.append('\n' if child.tag == 'br' else ''.join(child.itertext()))
        chunks.append(child.tail or '')
    return [s.strip() for s in ''.join(chunks).split('\n') if s.strip()]

data = {'id':'english-2026', 'title':'每天五个词', 'subtitle':'2026秋—2027冬 · 21周英语陪伴手册',
        'startDate':'2026-09-07','endDate':'2027-01-31','sourceRevision':doc['revision_id'],
        'weeks':[], 'days':[], 'entries':[], 'monthlyReviews':[],
        'audioSource':'Microsoft 在线语音合成 · 英式 Sonia / 美式 Aria'}
week = day = monthly = None
monthly_group = None
start = dt.date(2026,9,7)
for el in root:
    t = txt(el)
    if el.tag == 'h1':
        m = re.search(r'第(\d+)周\s*·\s*(.+)',t)
        if m:
            n=int(m[1]); week={'number':n,'theme':m[2], 'icon':t.split('第')[0].strip(),
                              'startDate':str(start+dt.timedelta(days=(n-1)*7)),'dayIds':[]}
            data['weeks'].append(week)
        else: week=None
        day=monthly=None
    elif el.tag == 'h2':
        monthly_group=None
        m=re.search(r'Day\s*(\d+)',t)
        if m:
            n=int(m[1]); date=start+dt.timedelta(days=n-1)
            day={'id':n,'week':(n-1)//7+1,'date':str(date),'weekday':date.weekday(),
                 'kind':'learn' if date.weekday()<5 else 'review' if date.weekday()==5 else 'rest',
                 'entryIds':[]}
            data['days'].append(day); week['dayIds'].append(n); monthly=None
        elif '月大复习' in t:
            m=re.search(r'(\d+)月大复习｜(\d+)词',t); assert m,t
            monthly={'month':int(m[1]),'year':2027 if int(m[1])==1 else 2026,'count':int(m[2]),'groups':[]}
            data['monthlyReviews'].append(monthly); day=None
        else: day=None
    elif el.tag == 'h3' and monthly:
        monthly_group={'theme':t,'words':[]}; monthly['groups'].append(monthly_group)
    elif el.tag == 'p' and day and day['kind']=='learn' and t.startswith('□'):
        ls=lines(el); word=txt(el.find('b'))
        header=re.match(r'□\s*'+re.escape(word)+r'\s+(.+?)\s+〔(.+)〕$',ls[0]); assert header,(word,ls)
        pm=re.match(r'美\s*(/.+?/)\s*英\s*(/.+?/)$',ls[1]); assert pm,(word,ls)
        description=header[1]
        pos_m=re.match(r'([A-Za-z]+\.)\s*(.+)$',description)
        if pos_m: pos,meaning=pos_m[1],pos_m[2]
        else:
            split=description.split(' ',1); pos,meaning=split if len(split)==2 else ('短语',description)
        ex=[]
        for mark in ['①','②']:
            i=next(i for i,x in enumerate(ls) if x.startswith(mark))
            ex.append({'en':ls[i][1:].strip(),'zh':ls[i+1].removeprefix('译：').strip(),
                       'scene':ls[i+2].split('场景：',1)[1].strip()})
        entry={'id':f'w{len(data["entries"])+1:03d}','word':word,'pos':pos,'meaning':meaning,
               'sourceTag':header[2],'ipaUS':pm[1],'ipaUK':pm[2], 'examples':ex,
               'day':day['id'],'date':day['date'],'week':day['week'],'theme':week['theme']}
        data['entries'].append(entry); day['entryIds'].append(entry['id'])
    elif el.tag == 'table' and day and day['kind']=='review':
        day['reviewWords']=[txt(row.findall('td')[1]) for row in el.findall('.//tr')[1:]]
    elif el.tag == 'p' and monthly and monthly_group:
        if '（' in t:
            monthly_group['words'] += re.findall(r'(?:^|；)([^（）]+)（[^）]+）',t)

by_word={e['word']:e['id'] for e in data['entries']}
assert len(by_word)==525, 'Unexpected duplicate words'
for d in data['days']:
    if d['kind']=='learn': assert len(d['entryIds'])==5,d
    elif d['kind']=='review':
        d['entryIds']=[by_word[w] for w in d.pop('reviewWords')]
        assert len(d['entryIds'])==25,d
for m in data['monthlyReviews']:
    ids=[]
    for g in m['groups']:
        g['entryIds']=[by_word[w.strip()] for w in g.pop('words')]
        ids+=g['entryIds']
    m['entryIds']=ids
    assert len(ids)==m['count'],m
    actual={e['id'] for e in data['entries'] if e['date'].startswith(f'{m["year"]}-{m["month"]:02d}')}
    assert set(ids)==actual,(m,actual-set(ids))
assert len(data['weeks'])==21 and len(data['days'])==147
assert len(data['entries'])==525
assert sum(len(e['examples']) for e in data['entries'])==1050
for e in data['entries']:
    assert all(e[k] for k in ['word','meaning','ipaUS','ipaUK'])
    assert all(all(ex[k] for k in ['en','zh','scene']) for ex in e['examples'])
(SITE/'source').mkdir(exist_ok=True)
shutil.copyfile(raw_path,SITE/'source/feishu-snapshot.json')
(SITE/'dist/data.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
report={'sourceRevision':doc['revision_id'],'weeks':21,'days':147,'words':525,'examples':1050,
        'monthlyCounts':{str(m['month']):len(m['entryIds']) for m in data['monthlyReviews']},
        'contentChecks':'passed: schedule, unique words, two examples, all weekly and monthly references'}
(SITE/'source/content-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
