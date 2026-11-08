"""Readable A4 learner books and separate companion answers from the website data."""
import argparse, collections, html, json, math, re, shutil, sys
from pathlib import Path

ap=argparse.ArgumentParser()
ap.add_argument('--out',required=True)
ap.add_argument('--vendor',default=r'D:\Codex\2026-09-06\ban\work\vendor')
args=ap.parse_args()
sys.path.insert(0,args.vendor)
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[1]
OUT=Path(args.out);OUT.mkdir(parents=True,exist_ok=True)
W,H=A4;M=43;WIDTH=W-2*M;BOTTOM=45
GREEN=HexColor('#245e55');INK=HexColor('#183c3e');MUTED=HexColor('#64746d');LINE=HexColor('#d9dfd6')
pdfmetrics.registerFont(TTFont('ZH',r'C:\Windows\Fonts\msyh.ttc',subfontIndex=0))
pdfmetrics.registerFont(TTFont('ZHB',r'C:\Windows\Fonts\msyhbd.ttc',subfontIndex=0))
pdfmetrics.registerFont(TTFont('EN',r'C:\Windows\Fonts\arial.ttf'))
pdfmetrics.registerFont(TTFont('ENB',r'C:\Windows\Fonts\arialbd.ttf'))
pdfmetrics.registerFontFamily('EN',normal='EN',bold='ENB',italic='EN',boldItalic='ENB')
pdfmetrics.registerFontFamily('ZH',normal='ZH',bold='ZHB',italic='ZH',boldItalic='ZHB')

def esc(s): return html.escape(str(s).replace('—','-').replace('–','-').replace('‑','-'),quote=False)
def style(font='ZH',size=11,leading=None,color=INK):
    return ParagraphStyle('p',fontName=font,fontSize=size,leading=leading or size*1.35,textColor=color,wordWrap='CJK' if font.startswith('ZH') else None,spaceAfter=0)

class Book:
    def __init__(self,path,label,kind):
        self.path=path;self.label=label;self.kind=kind
        self.c=canvas.Canvas(str(path),pagesize=A4,pageCompression=1)
        self.c.setTitle(label+' · 每日英语词汇 · '+kind)
        self.c.setAuthor('听听学堂');self.page=0;self.y=0;self.title='';self.subtitle='';self.layout=[]
    def new(self,title,subtitle='',continued=False):
        if self.page:self.c.showPage()
        self.page+=1;self.title=title;self.subtitle=subtitle
        c=self.c;c.setFillColor(GREEN);c.setFont('ZHB',9);c.drawString(M,H-31,self.label+' · 每日英语词汇')
        c.setFont('ZH',9);c.drawRightString(W-M,H-31,self.kind)
        c.setStrokeColor(LINE);c.line(M,H-40,W-M,H-40)
        self.y=H-57
        self.draw(title+('（续）' if continued else ''),'ZHB',18,24,gap=4)
        if subtitle:self.draw(subtitle,'ZH',9.5,13,color=MUTED,gap=7)
        c.setFont('EN',8);c.setFillColor(MUTED);c.drawString(M,23,'study4better.cloud-ip.cc')
        c.drawRightString(W-M,23,str(self.page));self.content_top=self.y
    def paragraph(self,text,font='ZH',size=11,leading=None,color=INK,width=WIDTH):
        p=Paragraph(text,style(font,size,leading,color));_,height=p.wrap(width,H)
        return p,height
    def ensure(self,height):
        if self.y-height<BOTTOM:self.new(self.title,self.subtitle,True)
        assert self.y-height>=BOTTOM,('Block too tall',self.title,height)
    def draw(self,text,font='ZH',size=11,leading=None,color=INK,gap=4,raw=False,width=WIDTH,x=M):
        p,height=self.paragraph(text if raw else esc(text),font,size,leading,color,width)
        self.ensure(height+gap);p.drawOn(self.c,x,self.y-height)
        self.layout.append({'page':self.page,'text':re.sub('<[^>]+>','',text),'x':x,'top':self.y,'bottom':self.y-height,'width':width,'size':size})
        self.y-=height+gap
    def gap(self,h=7):self.y-=h
    def rule(self,lines=1):
        self.ensure(lines*20+6)
        self.c.setStrokeColor(LINE)
        for _ in range(lines):self.y-=20;self.c.line(M,self.y,W-M,self.y)
        self.y-=6
    def word(self,e,index,repeated=False):
        source=('教材U'+str(e['unit'])+' p.'+str(e['source']['textbookPage'])+(' 复现' if repeated else '')) if e['category']=='core' else '拓展'
        blocks=[(f'<b>{index}. {esc(e["word"])}</b> <font name="ZH" size="11">{esc(e["pos"])}　{esc(e["meaning"])}</font> <font name="ZH" size="8.5" color="#245e55">[{esc(source)}]</font>','EN',14,18,INK,4),
                ('US '+esc(e['ipaUS'])+'    UK '+esc(e['ipaUK']),'EN',10.5,14,MUTED,4)]
        if e.get('ipaNote'):blocks.append((esc(e['ipaNote']),'ZH',9,12,MUTED,3))
        for i,x in enumerate(e['examples'],1):
            blocks += [(esc(str(i)+') '+x['en']),'EN',12,15,INK,2),
                       (esc(x['zh'])+' <font size="9" color="#64746d">['+esc(x['scene'])+']</font>','ZH',10.5,14,INK,5)]
        total=sum(self.paragraph(t,f,z,lead,col)[1]+gap for t,f,z,lead,col,gap in blocks)+8
        self.ensure(total)
        for text,font,size,lead,col,gap in blocks:self.draw(text,font,size,lead,col,gap,raw=True)
        self.c.setStrokeColor(LINE);self.c.line(M,self.y,W-M,self.y);self.y-=8
    def word_grid(self,ids,entries,answers=False,after=0):
        # Each cell stays intact; no word or answer is divided between pages.
        rows=[ids[i:i+2] for i in range(0,len(ids),2)]
        cell=(WIDTH-20)/2
        prepared=[]
        for pair in rows:
            texts=[]
            for eid in pair:
                e=entries[eid]
                t=f'<font name="ENB">{esc(e["word"])}</font><br/>'+ (esc(e['meaning']) if answers else '中文：________________')
                p,h=self.paragraph(t,'ZH',11,16,width=cell);texts.append((p,h))
            prepared.append((pair,texts,max(h for _,h in texts)+4))
        total=sum(r[2] for r in prepared)+after
        first_space=self.y-BOTTOM;full_space=self.content_top-BOTTOM
        row_capacity=max(1,int(min(first_space,full_space)/max((r[2] for r in prepared),default=36)))
        page_count=max(math.ceil(len(prepared)/row_capacity),1+max(0,math.ceil((total-first_space)/full_space)))
        per_page=math.ceil(len(prepared)/page_count) if prepared else 1
        for i,(pair,texts,height) in enumerate(prepared):
            if i and i%per_page==0:self.new(self.title,self.subtitle,True)
            self.ensure(height)
            for j,(p,h) in enumerate(texts):
                x=M+j*(cell+20);p.drawOn(self.c,x,self.y-h)
                self.layout.append({'page':self.page,'text':entries[pair[j]]['word'],'x':x,'top':self.y,'bottom':self.y-h,'width':cell,'size':11})
            self.y-=height
    def finish(self):
        self.c.save();reader=PdfReader(self.path)
        assert len(reader.pages)==self.page
        assert all(x['bottom']>=BOTTOM and x['top']<=H-45 for x in self.layout)
        return {'filename':self.path.name,'pages':self.page,'bytes':self.path.stat().st_size,'layout':self.layout}

def title_pages(book,data,companion=False):
    label=book.label
    book.new(label+' · 每日英语词汇',data['startDate']+' - '+data['endDate'])
    book.gap(42);book.draw('一起把词放进生活里','ZHB',25,34,gap=17)
    book.draw('每天3个教材词＋2个适龄拓展词','ZHB',16,22,gap=15)
    book.draw('积累到 '+data['coreCompletionDate']+'；复习从 '+data['reviewStart']+' 开始。',size=12,leading=18,gap=17)
    book.draw(str(len(data['entries']))+' 个不同词条 · '+str(len(data['entries'])*2)+' 句例句 · '+str(len(data['stories']))+' 篇原创短文',size=12,leading=18,gap=24)
    book.draw('陪读版：短文中文、理解题答案与词汇回顾参考。' if companion else 'A4打印版：每日词卡、周月回顾、短文与练习。',size=12,leading=18,gap=15)
    book.draw('网页可听单词、两句例句、整篇短文及逐句音频，支持英式与美式。',size=12,leading=18,gap=15)
    book.draw('https://www.study4better.cloud-ip.cc/?local=1#/library','EN',10,15,gap=20)
    book.draw('姓名：____________________　班级：____________________',size=12,leading=18,gap=20)
    book.draw('教材依据：当前人教社公开新版PEP五年级教材。2027-2028新印次尚未核实。',size=10,leading=15,color=MUTED)
    book.new('怎样使用这本手册')
    tips=['周一至周五：听单词，读音标，再读两句不同场景的例句。每天可分两小段完成。',
          '教材词会有计划地复现。标注“本学期复现”的词是再次练习，不是新的不同词条。',
          '周六：先读英文回想中文，再听读或选词造句。周日休息，不安排新词。',
          '本计划覆盖教材词表中的全部词，也含仅需在语境中理解的词；按老师要求区分认读与运用，不必把全部词统一当作听写要求。',
          '复习阶段：每天先回顾一小组词；完整学习周每周读2-3篇短文，其他学习日重读与表达。短周按实际天数安排。',
          '短文练习先口答或写关键词，再核对陪读版。表达题是开放题，不必逐字背参考答案。',
          '单词给出美式US和英式UK音标。词组特别标注分词音标，连读听音频；Taishan保留教材的汉语拼音专名，不另造整词音标。']
    for i,tip in enumerate(tips,1):book.draw(f'{i}. {tip}',size=12,leading=19,gap=15)
    book.draw('打印建议：A4纵向，100%或实际大小；可双面打印。每天对应同一日期和Day，按自己的进度学习。',size=10.5,leading=16,color=MUTED)

def story_page(book,story,companion=False,entries=None):
    book.new('短文 '+str(story['number'])+' · '+story['title'],story['date']+' · '+story['titleEn']+' · '+str(story['wordCount'])+'词')
    if companion:
        for paragraph in story['translation']:book.draw(paragraph,size=12,leading=19,gap=14)
        book.draw('理解题参考','ZHB',13,18,gap=9)
        for i,q in enumerate(story['questions'],1):
            book.draw(str(i)+'. '+q['zh'],size=10.5,leading=15,gap=3)
            book.draw(q['answer'],'EN',12,16,gap=10)
        book.draw('选词填空：'+'；'.join(q['answer'] for q in story['cloze']),size=12,leading=18,gap=14)
        book.draw('表达参考（意思合理即可）','ZHB',12,17,gap=7)
        book.draw(story['oralExample'],'EN',12,17,gap=12)
        book.draw('复述线索：'+' -> '.join(story['retell']),'ZH',11,16)
    else:
        book.draw('重点词：'+' / '.join(entries[eid]['word'] for eid in story['focusIds']),size=10,leading=14,color=GREEN,gap=10)
        for paragraph in story['paragraphs']:book.draw(paragraph,'EN',12.5,18,gap=11)
        if story['glossary']:book.draw('小帮手：'+'；'.join(en+'（'+zh+'）' for en,zh in story['glossary']),size=10,leading=14,color=MUTED,gap=9)
        book.draw('读懂了吗？先说或写关键词。','ZHB',12,17,gap=8)
        for i,q in enumerate(story['questions'],1):
            book.draw(str(i)+'. '+q['en'],'EN',11.5,16,gap=1);book.rule()
        book.draw('选词填空','ZHB',12,17,gap=5)
        for q in story['cloze']:book.draw(q['question'],'EN',11.5,16,gap=7)
        book.draw('说一说：'+story['oral'],size=11,leading=16,gap=5);book.rule()
        book.draw('复述线索：'+' -> '.join(story['retell']),'ZH',10.5,15,color=MUTED)

def make(term):
    data=json.loads((ROOT/f'dist/grade5-{term}-data.json').read_text('utf-8'))
    label='五年级'+('上学期' if term=='autumn' else '下学期')
    byid={e['id']:e for e in data['entries']};reports=[]
    learner=Book(OUT/(label+'_每日英语词汇_A4打印版.pdf'),label,'A4打印版')
    parent=Book(OUT/(label+'_每日英语词汇_陪读版.pdf'),label,'陪读版')
    title_pages(learner,data);title_pages(parent,data,True)
    for book in [learner,parent]:
        book.new('学期日历与学习安排')
        for wi,week in enumerate(data['weeks']):
            if wi==math.ceil(len(data['weeks'])/2):book.new('学期日历与学习安排（续）')
            ds=[data['days'][i-1] for i in week['dayIds']]
            book.draw('第'+str(week['number'])+'周　'+ds[0]['date']+' - '+ds[-1]['date'],'ZHB',11,16,gap=3)
            book.draw(week['theme']+'；积累'+str(sum(d['kind']=='learn' for d in ds))+'天，短文'+str(len(week['storyIds']))+'篇。',size=10.5,leading=15,gap=9)
    stories={s['id']:s for s in data['stories']}
    for day in data['days']:
        if day['kind']=='rest':continue
        title='Day '+str(day['id'])+' · '+('每日积累' if day['kind']=='learn' else '周六回顾' if day['kind']=='review' else '学期复习')
        sub=day['date']+'　'+['周一','周二','周三','周四','周五','周六','周日'][day['weekday']]+'　 第'+str(day['week'])+'周'
        learner.new(title,sub)
        if day['kind']=='learn':
            for i,eid in enumerate(day['entryIds'],1):learner.word(byid[eid],i,eid in day.get('repeatedIds',[]))
            learner.draw('我会用了：选一个词，写一句自己的话。',size=10.5,leading=15,gap=0);learner.rule()
        else:
            learner.draw('先看英文回想中文，能读的词打勾；想再练的词圈出来。',size=11,leading=16,gap=10)
            learner.word_grid(day['entryIds'],byid,after=220 if day.get('activity') else 100)
            learner.gap(9)
            if day.get('storyId'):
                s=stories[day['storyId']];learner.draw('今日阅读：第'+str(s['number'])+'篇《'+s['title']+'》。先完成上面的词汇回顾，再翻页读短文。',size=12,leading=18,gap=10)
            elif day.get('activity'):
                a=day['activity'];learner.draw(a['title'],'ZHB',13,18,gap=8)
                learner.draw('重读第'+str(a['story'])+'篇，再做两题。备选词：'+' / '.join(a['bank']),size=11,leading=16,gap=9)
                for q,_ in a['cloze']:learner.draw(q,'EN',11.5,16,gap=8)
                learner.draw(a['oral'],size=11,leading=16,gap=5);learner.rule(2)
            else:
                learner.draw('选两个词，各说一句自己的话。不会的先回到词卡听一听。',size=11,leading=16,gap=5);learner.rule(3)
            parent.new(title+' · 回顾参考',sub)
            parent.word_grid(day['entryIds'],byid,True,after=85 if day.get('activity') else 40)
            parent.draw('造句与口头题：语境合理、用词正确即可。可参考每日词卡的两句例句。',size=10.5,leading=16,color=MUTED,gap=9)
            if day.get('activity'):
                a=day['activity'];parent.draw(a['title'],size=12,leading=17)
                parent.draw('填空：'+'；'.join(ans for _,ans in a['cloze']),size=11,leading=16)
                parent.draw(a['model'],'EN',11.5,17)
        if day.get('storyId'):
            story_page(learner,stories[day['storyId']],entries=byid);story_page(parent,stories[day['storyId']],True,entries=byid)
    for month in data['monthlyReviews']:
        for book,answers in [(learner,False),(parent,True)]:
            book.new(str(month['year'])+'年'+str(month['month'])+'月 · 月度回顾'+('参考' if answers else ''),str(month['count'])+'个不同词条；本月出现的词汇，含教材复现。')
            book.word_grid(month['entryIds'],byid,answers)
    for book in [learner,parent]:
        book.new('词汇来源与使用说明')
        book.draw(data['textbook'],size=12,leading=18,gap=13)
        book.draw('词表：人教社公开电子教材，单元词表逐项核对，词卡保留原课本单元和首次出现页码。五上另纳入附录词汇表中的 everything。',size=11,leading=17,gap=12)
        book.draw('https://book.pep.com.cn/'+('1212001501255' if term=='autumn' else '1212001502255')+'/','EN',10,15,gap=12)
        book.draw('人教社官方配套目录与词表音频：',size=11,leading=16,gap=5)
        book.draw('https://www.pep.com.cn/zslth/yyptzy/xypep/'+('5s' if term=='autumn' else '5x')+'/','EN',9.5,14,gap=14)
        book.draw('音标：Cambridge Dictionary；词性与同形词另参考Oxford Learner’s Dictionaries。词组采用已核验的分词音标；专名Taishan沿用汉语拼音。每个词的具体链接保存在配套可编辑词库中。',size=11,leading=17,gap=13)
        book.draw('例句、短文与练习均为本计划原创。故事中的人物和活动为学习情境。译文和答案单独收在陪读版。',size=11,leading=17,gap=13)
        book.draw(data['editionNote']+' 若实际课本有调整，可按单元和页码对照更新。',size=11,leading=17,color=MUTED)
        reports.append(book.finish())
    folder=ROOT/f'dist/materials/grade5-{term}';folder.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(learner.path,folder/'a4.pdf');shutil.copyfile(parent.path,folder/'companion.pdf')
    return reports

if __name__=='__main__':
    reports=[]
    for term in ['autumn','spring']:reports+=make(term)
    (OUT.parent/'work/pdf-layout.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps([{k:v for k,v in r.items() if k!='layout'} for r in reports],ensure_ascii=False))
