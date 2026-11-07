"""Import the checked spring handbook without changing the autumn collection."""
import argparse, collections, datetime as dt, hashlib, json, re, shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def unique(xs): return list(dict.fromkeys(xs))
def split_sentences(text):
    # Keep closing quotation marks with their sentence; retain the exact source text.
    result=re.findall(r'.+?(?:[.!?][\'\"”]?(?=\s|$)|$)',text.strip())
    result=[s.strip() for s in result if s.strip()]
    assert ' '.join(result)==' '.join(text.split())
    return result

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source',required=True);ap.add_argument('--pdf-dir');args=ap.parse_args()
    source=Path(args.source);raw=json.loads(source.read_text(encoding='utf-8'))
    entries=[];byword={};start=dt.date(2027,3,1);end=dt.date(2027,7,31)
    for a in raw['entries']:
        day=next(d for d in raw['learning_days'] if any(x['word']==a['word'] for x in d['words']))
        eid='s'+a['entry_id'][1:];byword[a['word']]=eid
        entries.append({'id':eid,'word':a['word'],'pos':a['pos'],'meaning':a['meaning_zh'],'sourceTag':a['source_code'],
                        'category':a['category'],'ipaUS':a['ipa_us'],'ipaUK':a['ipa_uk'],'examples':a['examples'],
                        'day':(dt.date.fromisoformat(day['date'])-start).days+1,'date':day['date'],'week':day['week'],'theme':day['theme'],
                        'source':a['source'],'pronunciationReference':a['pronunciation_reference']})
    learn={d['date']:d for d in raw['learning_days']};july={d['date']:d for d in raw['july_retrieval']}
    stories=[];story_dates={}
    for a in raw['stories']:
        sid=f'r{a["id"]:02d}';story_dates[a['date']]=sid
        sentences=[s for para in a['en'] for s in split_sentences(para)]
        stories.append({'id':sid,'number':a['id'],'date':a['date'],'day':(dt.date.fromisoformat(a['date'])-start).days+1,
                        'title':a['title_zh'],'titleEn':a['title_en'],'paragraphs':a['en'],'translation':a['zh'],
                        'sentences':[{'id':f'{sid}s{i:02d}','text':s} for i,s in enumerate(sentences,1)],
                        'wordCount':a['word_count'],'focusIds':[byword[w] for w in a['focus']],'questions':[{'en':q,'zh':z,'answer':ans} for q,z,ans in a['questions']],
                        'cloze':[{'question':q,'answer':ans} for q,ans in a['cloze']],'oral':a['oral'],'oralExample':a['oral_model'],'retell':a['retell'],
                        'glossary':a.get('glossary',[])})
    days=[]
    for offset in range((end-start).days+1):
        date=start+dt.timedelta(days=offset);iso=date.isoformat();week=offset//7+1
        day={'id':offset+1,'week':week,'date':iso,'weekday':date.weekday(),'entryIds':[]}
        if iso in learn:
            source_day=learn[iso];day.update(kind='learn',entryIds=[byword[x['word']] for x in source_day['words']],
                categories=[x['category'] for x in source_day['words']],repeatedIds=[byword[x['word']] for x in source_day['words'] if x['semester_repeat']])
            assert day['categories']==['core']*3+['extension']*2
        elif date.weekday()==6:day['kind']='rest'
        elif iso in july:day.update(kind='recall',entryIds=[byword[w] for w in july[iso]['words']])
        else:
            weekstart=date-dt.timedelta(days=date.weekday())
            words=[x for d in days if weekstart<=dt.date.fromisoformat(d['date'])<date for x in d['entryIds']]
            # The June 30 monthly sheet closes acquisition; July Saturdays follow the July retrieval plan.
            if date.month==7:words=[byword[w] for d in raw['july_retrieval'] if weekstart<=dt.date.fromisoformat(d['date'])<=date for w in d['words']]
            day.update(kind='review',entryIds=unique(words))
        if iso in story_dates:day['storyId']=story_dates[iso]
        if iso in raw['july_activities']:day['activity']=raw['july_activities'][iso]
        days.append(day)
    icons=['📚','✋','✍️','🫧','🏡','⏰','🚌','👕','🛍️','🎒','🐑','🌱','🥣','🍽️','🔢','🌿','🦋','📖','📚','🎒','🥕','🌳']
    july_themes=['课堂与家庭的故事','出行与购物的故事','农场与餐桌的故事','健康与暑假的故事']
    weeks=[]
    for number in range(1,23):
        group=[d for d in days if d['week']==number]
        review=next((d for d in group if d['kind']=='review'),None)
        ids=unique(x for d in group for x in d['entryIds'])
        weeks.append({'number':number,'theme':raw['weeks'][number-1]['theme'] if number<=18 else july_themes[number-19],
                      'icon':icons[number-1],'startDate':group[0]['date'],'dayIds':[d['id'] for d in group],
                      'reviewIds':review['entryIds'] if review else ids,'reviewDayId':review['id'] if review else None,
                      'learnSlots':sum(len(d['entryIds']) for d in group if d['kind']=='learn'),
                      'storyIds':[d['storyId'] for d in group if d.get('storyId')]})
    monthly=[]
    entry_map={e['id']:e for e in entries}
    for month in range(3,8):
        group=[d for d in days if dt.date.fromisoformat(d['date']).month==month and d['kind'] in ['learn','recall']]
        ids=unique(x for d in group for x in d['entryIds']);themes=collections.defaultdict(list)
        for eid in ids:themes[entry_map[eid]['theme']].append(eid)
        monthly.append({'month':month,'year':2027,'count':len(ids),'learningSlots':sum(len(d['entryIds']) for d in group),
                        'entryIds':ids,'groups':[{'theme':k,'entryIds':v} for k,v in themes.items()]})
    data={'id':'english-2027-spring','title':'每天五个词 · 四年级下学期','subtitle':'2027年3-7月 · 每天3教材词+2适龄拓展词',
          'startDate':start.isoformat(),'endDate':end.isoformat(),'sourceRevision':1,'weeks':weeks,'days':days,'entries':entries,
          'monthlyReviews':monthly,'stories':stories,'dailyMix':{'core':3,'extension':2},'learningSlots':440,
          'textbook':'新版人教PEP英语四年级下册（当前公开版本）','audioSource':'预先保存的英式、美式MP3'}
    assert len(entries)==325 and len([d for d in days if d['kind']=='learn'])==88
    assert sum(len(d['entryIds']) for d in days if d['kind']=='learn')==440
    assert sum(e['category']=='core' for e in entries)==149 and sum(e['category']=='extension' for e in entries)==176
    assert len(unique(x for d in days if d['kind']=='recall' for x in d['entryIds']))==325
    target=ROOT/'dist/spring-data.json';target.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    report={'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'days':153,'weeks':22,'learningDays':88,'slots':440,
            'uniqueWords':325,'uniqueCore':149,'uniqueExtension':176,'dailyMix':{'core':3,'extension':2},'stories':12,'sentences':sum(len(s['sentences']) for s in stories),
            'julyStoryFrequency':[2,3,2,3,2],'contentChecks':'passed','limits':['2027春季新印本尚未核实；对应当前公开PEP四下。','飞书参考页未读取成功，短文按已确认频率新编。']}
    (ROOT/'source/spring-content-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    if args.pdf_dir:
        pdfs=Path(args.pdf_dir);folder=ROOT/'dist/materials/grade4-spring';folder.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(pdfs/'四年级下_每日英语词汇与短文复习_20270301-20270731_A4学生册.pdf',folder/'student.pdf')
        shutil.copyfile(pdfs/'四年级下_七月短文译文与复习答案_202707_A4家长册.pdf',folder/'parent.pdf')
    print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()
