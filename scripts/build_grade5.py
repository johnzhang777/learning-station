"""Rebuild both Grade 5 courses from reviewed, editable source material."""
import collections, datetime as dt, hashlib, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'source/grade5'
TERMS = {
    'autumn': {'id':'english-2027-grade5-autumn','prefix':'f','storyPrefix':'t',
               'label':'五年级上学期','start':'2027-09-01','end':'2028-01-15','review':'2027-12-16',
               'book':'1212001501255','support':'5s','unitDays':[13,13,12,13,13,12],
               'units':['Different friends','My feelings','Work and play','Healthy habits','Food we eat','Nature and us'],
               'themes':['朋友与本领','情绪与合作','学习与玩耍','健康与习惯','食物与植物','自然与出游']},
    'spring': {'id':'english-2028-grade5-spring','prefix':'g','storyPrefix':'v',
               'label':'五年级下学期','start':'2028-02-15','end':'2028-07-31','review':'2028-07-01',
               'book':'1212001502255','support':'5x','unitDays':[17,16,17,16,17,16],
               'units':['Following the rules','Our community','Life in different seasons','My hometown','Travelling around','Making a travel plan'],
               'themes':['规则与公共场所','社区与助人','月份与节日','家乡与文化','交通与出行','计划与旅行']}
}

def rows(name, source=SRC):
    return [line.split('|') for line in (source/name).read_text('utf-8').splitlines() if line and not line.startswith('#')]

def unique(xs): return list(dict.fromkeys(xs))

def parse_stories(source=SRC):
    result=[]; story=None
    for line in (source/'stories.txt').read_text('utf-8').splitlines():
        if line.startswith('# '):
            term,title,title_en,focus=line[2:].split('|')
            story={'term':term,'title':title,'titleEn':title_en,'focus':focus.split(','),
                   'paragraphs':[],'translation':[],'questions':[],'cloze':[],'glossary':[]}
            result.append(story)
        elif line.startswith('EN '): story['paragraphs'].append(line[3:])
        elif line.startswith('ZH '): story['translation'].append(line[3:])
        elif line.startswith('Q '): story['questions'].append(dict(zip(['en','zh','answer'],line[2:].split('|'))))
        elif line.startswith('C '): story['cloze'].append(dict(zip(['question','answer'],line[2:].split('|'))))
        elif line.startswith('O '): story['oral']=line[2:]
        elif line.startswith('M '): story['oralExample']=line[2:]
        elif line.startswith('R '): story['retell']=line[2:].split('|')
        elif line.startswith('G '): story['glossary'].append(line[2:].split('|'))
        elif line.strip(): raise ValueError('Unknown story line: '+line[:35])
    return result

def sentences(paragraphs):
    result=[]
    for paragraph in paragraphs:
        result += [s.strip() for s in re.findall(r'.+?(?:[.!?][\'"”]?(?=\s|$)|$)',paragraph) if s.strip()]
    assert ' '.join(result)==' '.join(' '.join(paragraphs).split())
    return result

def build(term, config, pronunciations, old, all_stories, source_dir=SRC):
    entries=[]; cores=collections.defaultdict(list); extensions=collections.defaultdict(list)
    grade=config.get('grade',5)
    example_file=source_dir/'core-examples.tsv'
    ex={p[0]:p[1:] for p in rows(example_file.name,source_dir)} if example_file.exists() else {}
    def make_entry(word,pos,meaning,unit,category,examples,source):
        phon=pronunciations.get(f'{term}:{word}') or pronunciations[word]
        tag=config.get('sourceTag','五上' if term=='autumn' else '五下')
        e={'id':config['prefix']+f'{len(entries)+1:03d}','word':word,'pos':pos,'meaning':meaning,
           'category':category,'sourceTag':tag+str(unit) if category=='core' else '拓',
           'ipaUS':phon['us'],'ipaUK':phon['uk'],'examples':examples,'unit':unit,'theme':config['themes'][unit-1],
           'source':source,'pronunciationReference':phon['reference'],
           'previousCourses':[e['courseId'] for e in old.get(word.casefold(),[])]}
        if phon.get('note'): e['ipaNote']=phon['note']
        if phon.get('audioContext'): e['wordAudioContext']=phon['audioContext']
        assert len(examples)==2 and examples[0]['en']!=examples[1]['en']
        entries.append(e)
        return e['id']
    for t,unit,page,word,pos,meaning,*example_fields in rows('textbook.tsv',source_dir):
        if t!=term: continue
        p=example_fields or ex.get(word)
        if p:
            assert len(p)==6 and all(p), (term,word)
            examples=[dict(zip(['en','zh','scene'],p[i:i+3])) for i in [0,3]]
        else:
            assert word.casefold() in old,word
            examples=old[word.casefold()][-1]['examples']
        unit=int(unit)
        appendix=config.get('appendix') or ('Appendix 3 Vocabulary (p.83)' if term=='autumn' and word=='everything' else ('Appendix 2 Words in each unit (pp.80–82)' if term=='autumn' else 'Appendix 2 Words in each unit (pp.81–83)'))
        source={'reference':f'https://book.pep.com.cn/{config["book"]}/',
                'location':f'{config.get("sourceEdition","新版人教PEP")}{config["label"]} Unit {unit} {config["units"][unit-1]}，课本p.{page}；{appendix}',
                'supporting_reference':f'https://www.pep.com.cn/zslth/{config.get("supportPath","yyptzy")}/xypep/{config["support"]}/',
                'textbookPage':int(page),'appendix':appendix}
        cores[unit].append(make_entry(word,pos,meaning,unit,'core',examples,source))
    for t,unit,word,pos,meaning,en,zh,scene,en2,zh2,scene2 in rows('extensions.tsv',source_dir):
        if t!=term: continue
        unit=int(unit)
        assert word.casefold() not in old,word
        extensions[unit].append(make_entry(word,pos,meaning,unit,'extension',
            [{'en':en,'zh':zh,'scene':scene},{'en':en2,'zh':zh2,'scene':scene2}],
            {'reference':'原创适龄生活例句；词典核验读音','location':config['themes'][unit-1]+'主题拓展'}))
    byid={e['id']:e for e in entries}; byword={e['word']:e['id'] for e in entries}
    start,end,review_start=map(dt.date.fromisoformat,[config['start'],config['end'],config['review']])
    monday=start-dt.timedelta(days=start.weekday())
    dates=[start+dt.timedelta(days=i) for i in range((end-start).days+1)]
    learning=[d for d in dates if d<review_start and d.weekday()<5]
    retrieval=[d for d in dates if d>=review_start and d.weekday()<5]
    assert len(learning)==sum(config['unitDays'])
    plans={}; introduced=set(); last_seen={}; usage=collections.Counter(); offset=0
    for unit,count in enumerate(config['unitDays'],1):
        core=cores[unit]; ext=extensions[unit]; assert len(ext)==count*2
        consumed=0
        for i,date in enumerate(learning[offset:offset+count]):
            # Introduce three on the first day; pace the rest through the unit's final day.
            target=3 if i==0 else 3+((len(core)-3)*i)//(count-1)
            new=core[consumed:target]; consumed=target
            available=[eid for eid in introduced if eid not in new]
            available.sort(key=lambda eid:(last_seen[eid],usage[eid],eid))
            recalled=available[:3-len(new)]
            assert len(new)+len(recalled)==3
            ids=new+recalled+ext[i*2:i*2+2]
            assert len(ids)==len(set(ids))==5
            plans[date]={'kind':'learn','entryIds':ids,'categories':['core']*3+['extension']*2,'repeatedIds':recalled,'unit':unit}
            introduced.update(new)
            for eid in ids:
                last_seen[eid]=date;usage[eid]+=1
                if 'date' not in byid[eid]:
                    byid[eid].update(date=date.isoformat(),day=(date-start).days+1,week=(date-monday).days//7+1)
        assert consumed==len(core)
        offset+=count
    assert introduced=={e['id'] for e in entries if e['category']=='core'}
    # Recall every distinct entry once across weekdays, in the order it was first studied.
    recall_order=sorted(entries,key=lambda e:(e['date'],e['id']))
    for i,date in enumerate(retrieval):
        ids=[e['id'] for e in recall_order[len(entries)*i//len(retrieval):len(entries)*(i+1)//len(retrieval)]]
        plans[date]={'kind':'recall','entryIds':ids}
    story_groups=collections.defaultdict(list)
    for date in retrieval: story_groups[(date-monday).days//7+1].append(date)
    story_dates=[]
    for i,group in enumerate(story_groups.values()):
        if len(group)<=2: story_dates+=group
        else:
            target=2 if i%2==0 else 3
            indexes=[1,3] if target==2 else [0,2,4]
            story_dates += [group[min(j,len(group)-1)] for j in indexes]
    source_stories=[s for s in all_stories if s['term']==term]
    assert len(story_dates)==len(source_stories),(term,len(story_dates),len(source_stories))
    stories=[]
    for i,(raw,date) in enumerate(zip(source_stories,story_dates),1):
        s={k:v for k,v in raw.items() if k not in ['term','focus']}
        sid=config['storyPrefix']+f'{i:02d}'
        s.update(id=sid,number=i,date=date.isoformat(),day=(date-start).days+1,
                 wordCount=len(re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*",' '.join(s['paragraphs']))),
                 focusIds=[byword[w] for w in raw['focus']],
                 sentences=[{'id':f'{sid}s{j:02d}','text':text} for j,text in enumerate(sentences(s['paragraphs']),1)])
        assert 80<=s['wordCount']<=120
        stories.append(s); plans[date]['storyId']=sid
    days=[]
    for date in dates:
        day={'id':(date-start).days+1,'date':date.isoformat(),'weekday':date.weekday(),'week':(date-monday).days//7+1,'entryIds':[]}
        if date in plans: day.update(plans[date])
        elif date.weekday()==6: day['kind']='rest'
        else:
            day.update(kind='review',entryIds=unique(eid for d in days if d['week']==day['week'] for eid in d['entryIds']))
        if date>=review_start and day['kind']=='recall' and not day.get('storyId'):
            prior=[s for s in stories if s['date']<date.isoformat()]
            if prior:
                s=prior[-1]
                day['activity']={'story':s['number'],'title':'重读：'+s['title'],
                    'bank':[q['answer'] for q in s['cloze']],
                    'cloze':[[q['question'],q['answer']] for q in s['cloze']],
                    'oral':s['oral'],'model':s['oralExample']}
        days.append(day)
    weeks=[]
    for number in range(1,days[-1]['week']+1):
        group=[d for d in days if d['week']==number]
        review_day=next((d for d in group if d['kind']=='review'),None)
        units=unique(d['unit'] for d in group if d.get('unit'))
        themes=[config['themes'][u-1] for u in units]
        if any(d['date']>=config['review'] for d in group): themes.append('学期短文与词汇复习')
        weeks.append({'number':number,'theme':' / '.join(themes),'icon':'📖' if not units else ['🎨','💬','📅','🌿','🍲','🗺️'][units[0]-1],
            'startDate':group[0]['date'],'dayIds':[d['id'] for d in group],
            'reviewIds':review_day['entryIds'] if review_day else unique(eid for d in group for eid in d['entryIds']),
            'reviewDayId':review_day['id'] if review_day else None,
            'learnSlots':sum(len(d['entryIds']) for d in group if d['kind']=='learn'),
            'storyIds':[d['storyId'] for d in group if d.get('storyId')]})
    monthly=[]
    for year,month in unique((d.year,d.month) for d in dates):
        group=[d for d in days if d['date'].startswith(f'{year}-{month:02d}') and d['kind'] in ['learn','recall']]
        ids=unique(eid for d in group for eid in d['entryIds']); themes=collections.defaultdict(list)
        for eid in ids: themes[byid[eid]['theme']].append(eid)
        monthly.append({'year':year,'month':month,'count':len(ids),'learningSlots':sum(len(d['entryIds']) for d in group),
                        'entryIds':ids,'groups':[{'theme':theme,'entryIds':eids} for theme,eids in themes.items()]})
    data={'id':config['id'],'title':'每天五个词 · '+config['label'],
          'subtitle':'每日3个教材词＋2个适龄拓展词；学期末词汇与短文复习',
          'startDate':config['start'],'endDate':config['end'],'reviewStart':config['review'],
          'coreCompletionDate':max(e['date'] for e in entries if e['category']=='core'),
          'sourceRevision':1,'textbook':config.get('textbook','新版人教PEP英语'+config['label']+'（当前公开版）'),
          'dailyMix':{'core':3,'extension':2},'learningSlots':len(learning)*5,
          'entries':entries,'days':days,'weeks':weeks,'monthlyReviews':monthly,'stories':stories,
          'reviewDescription':'词汇回顾＋短文理解＋重读表达；完整学习周每周2–3篇，不足一周按实际天数安排。',
          'editionNote':config.get('editionNote','依据当前人教社公开教材核对；尚未核实2027—2028新印次。'),
          'audioSource':'预先保存的英式、美式MP3'}
    if config.get('editionLabel'):data['editionLabel']=config['editionLabel']
    assert len({eid for d in days if d['kind']=='recall' for eid in d['entryIds']})==len(entries)
    assert max(e['date'] for e in entries)<config['review']
    filename=f'grade{grade}-{term}-data.json'
    (ROOT/'dist'/filename).write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    report={'course':data['id'],'start':config['start'],'end':config['end'],'reviewStart':config['review'],
            'coreCompletionDate':data['coreCompletionDate'],'calendarDays':len(days),'calendarWeeks':len(weeks),
            'learningDays':len(learning),'learningSlots':len(learning)*5,'coreSlots':len(learning)*3,
            'uniqueCore':sum(e['category']=='core' for e in entries),'uniqueExtension':len(learning)*2,
            'distinctEntries':len(entries),'reviewWeekdays':len(retrieval),'stories':len(stories),
            'storyFrequency':[len([s for s in stories if (dt.date.fromisoformat(s['date'])-monday).days//7+1==w]) for w in story_groups],
            'maxReviewWords':max(len(d['entryIds']) for d in days if d['kind']=='recall'),
            'dataSha256':hashlib.sha256((ROOT/'dist'/filename).read_bytes()).hexdigest()}
    (source_dir/f'{term}-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
    return data

if __name__=='__main__':
    pronunciations=json.loads((SRC/'pronunciations.json').read_text('utf-8'))
    old=collections.defaultdict(list)
    for filename in ['data.json','spring-data.json']:
        course=json.loads((ROOT/'dist'/filename).read_text('utf-8'))
        for e in course['entries']: old[e['word'].casefold()].append({**e,'courseId':course['id']})
    stories=parse_stories()
    for term,config in TERMS.items(): build(term,config,pronunciations,old,stories)
