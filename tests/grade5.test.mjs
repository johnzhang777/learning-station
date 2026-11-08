import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat,readdir} from 'node:fs/promises';
import {createHash,pbkdf2Sync} from 'node:crypto';
import {COURSE_INFO,GRADE5_AUTUMN,GRADE5_SPRING,AUTUMN,SPRING,courseForPath,courseHref,isCoursePrefix} from '../dist/courses.js';
import {COURSE_LIMITS,MAX_PROGRESS_FIELDS,validWordId,positionField} from '../dist/course-schema.js';
import {ProgressSync} from '../dist/progress-sync.js';
import {handle,validateFields} from '../server/learning-api.js';
const hash=text=>createHash('sha256').update(text).digest('hex');
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const all=await Promise.all(COURSE_INFO.map(async info=>({info,data:JSON.parse(await read('dist/'+info.data)),audio:JSON.parse(await read('dist/'+info.audio))})));
const grade5=all.slice(2);
const textbook=(await read('source/grade5/textbook.tsv')).split(/\r?\n/).filter(l=>l&&!l.startsWith('#')).map(l=>l.split('|'));
const phon=JSON.parse(await read('source/grade5/pronunciations.json'));

for(const [i,{info,data,audio}] of grade5.entries()){
  const term=i?'spring':'autumn',entries=new Map(data.entries.map(e=>[e.id,e]));
  test(`${term}: real calendar, leap day, 3+2 mix, paced complete textbook and explicit recurrences`,()=>{
    assert.equal(data.id,info.id);assert.equal(data.days.length,i?168:137);assert.equal(data.weeks.length,i?25:20);
    assert.equal(data.days[0].date,i?'2028-02-15':'2027-09-01');assert.equal(data.days.at(-1).date,i?'2028-07-31':'2028-01-15');
    assert.equal(data.coreCompletionDate,i?'2028-06-30':'2027-12-15');assert.equal(data.reviewStart,i?'2028-07-01':'2027-12-16');
    const learn=data.days.filter(d=>d.kind==='learn');assert.equal(learn.length,i?99:76);
    const seen=new Set(),coreSeen=new Set();let lastDate='';
    for(const d of data.days){
      const utc=new Date(d.date+'T00:00:00Z');assert.equal((utc.getUTCDay()+6)%7,d.weekday);
      if(lastDate)assert.equal((Date.parse(d.date)-Date.parse(lastDate))/86400000,1);lastDate=d.date;
      assert.equal(d.entryIds.length,new Set(d.entryIds).size);
      if(d.weekday===6)assert.equal(d.kind,'rest');
      if(d.weekday===5)assert.equal(d.kind,'review');
      if(d.kind!=='learn')continue;
      assert.ok(d.date<data.reviewStart);assert.equal(d.entryIds.length,5);
      assert.deepEqual(d.entryIds.map(id=>entries.get(id).category),['core','core','core','extension','extension']);
      assert.deepEqual(new Set(d.repeatedIds),new Set(d.entryIds.slice(0,3).filter(id=>seen.has(id))));
      for(const id of d.entryIds){seen.add(id);if(entries.get(id).category==='core')coreSeen.add(id);}
    }
    assert.equal(seen.size,i?333:272);assert.equal(coreSeen.size,i?135:120);
    assert.equal(data.entries.filter(e=>e.category==='extension').length,i?198:152);
    for(const [,unit,page,word] of textbook.filter(r=>r[0]===term)){
      const entry=data.entries.find(e=>e.word===word);assert.ok(entry,word);assert.equal(entry.category,'core');assert.equal(entry.unit,Number(unit));assert.equal(entry.source.textbookPage,Number(page));assert.ok(entry.date<data.reviewStart);
    }
    assert.equal(data.entries.length,new Set(data.entries.map(e=>e.word.toLowerCase())).size);
    for(const e of data.entries){assert.ok(validWordId(e.id));assert.equal(e.examples.length,2);assert.notEqual(e.examples[0].en,e.examples[1].en);for(const x of e.examples)assert.ok(x.en&&x.zh&&x.scene);assert.ok(data.days[e.day-1].entryIds.includes(e.id));assert.equal(e.ipaUS,phon[e.word].us);assert.equal(e.ipaUK,phon[e.word].uk);}
    if(i){const leap=data.days.find(d=>d.date==='2028-02-29');assert.equal(leap.kind,'learn');assert.equal(leap.weekday,1);}
  });
  test(`${term}: review covers every semester word once and schedules complete reading tasks`,()=>{
    const recall=data.days.filter(d=>d.kind==='recall');const ids=recall.flatMap(d=>d.entryIds);
    assert.equal(ids.length,data.entries.length);assert.equal(new Set(ids).size,data.entries.length);
    assert.equal(recall.length,i?21:22);assert.equal(Math.max(...recall.map(d=>d.entryIds.length)),i?16:13);
    assert.deepEqual(data.weeks.filter(w=>w.storyIds.length).map(w=>w.storyIds.length),i?[2,3,2,3,1]:[2,3,2,3,2]);
    assert.equal(data.stories.length,i?11:12);
    for(const s of data.stories){
      assert.equal(data.days[s.day-1].storyId,s.id);assert.ok(s.date>=data.reviewStart&&s.date<=data.endDate);
      assert.equal(s.sentences.map(x=>x.text).join(' '),s.paragraphs.join(' '));assert.ok(s.wordCount>=80&&s.wordCount<=120);
      assert.ok(s.focusIds.every(id=>entries.has(id)));assert.equal(s.focusIds.length,10+i*(s.number===5?2:0));
      assert.equal(s.questions.length,3);assert.equal(s.cloze.length,2);assert.equal(s.translation.length,2);assert.ok(s.oral&&s.oralExample&&s.retell.length);
    }
    for(const day of data.days.filter(d=>d.activity)){const story=data.stories.find(s=>s.number===day.activity.story);assert.ok(story.date<day.date);assert.equal(day.kind,'recall');}
    const ordered=data.days.map(d=>d.id);assert.deepEqual(data.weeks.flatMap(w=>w.dayIds),ordered);
  });
  test(`${term}: saved UK/US audio matches current text, including full passages and sentences`,async()=>{
    const texts=new Map();
    for(const e of data.entries){texts.set(e.id,{word:e.word,ex1:e.examples[0].en,ex2:e.examples[1].en});}
    for(const s of data.stories){texts.set(s.id,{passage:s.paragraphs.join(' ')});for(const sentence of s.sentences)texts.set(sentence.id,{sentence:sentence.text});}
    assert.deepEqual(Object.keys(audio.entries).sort(),[...texts.keys()].sort());assert.equal(audio.sourceDataSha256,hash(await read('dist/'+info.data)));
    const files=new Set();
    for(const [id,parts] of texts)for(const accent of ['uk','us']){
      assert.deepEqual(Object.keys(audio.entries[id][accent]).sort(),Object.keys(parts).sort());
      for(const [part,text] of Object.entries(parts)){
        const clip=audio.entries[id][accent][part];assert.match(clip.src,/^audio\/clips\/[a-z0-9-]+\.mp3$/);assert.equal(clip.start,0);assert.ok(clip.end>.12);assert.equal(audio.sourceHashes[id+'/'+part],hash(text));files.add(clip.src);
      }
    }
    for(const file of files)assert.ok((await stat(new URL('../dist/'+file,import.meta.url))).size>1000,file);
    assert.deepEqual(info.materials.map(m=>m.label),['A4打印版','陪读版']);
    for(const m of info.materials){const bytes=await readFile(new URL('../dist/'+m.href,import.meta.url));assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>100000);}
  });
}

test('new extensions do not duplicate older books or either semester textbook list; IDs never collide',()=>{
  const old=new Set(all.slice(0,2).flatMap(c=>c.data.entries.map(e=>e.word.toLowerCase())));
  const core=new Set(grade5.flatMap(c=>c.data.entries.filter(e=>e.category==='core').map(e=>e.word.toLowerCase())));
  const ext=grade5.flatMap(c=>c.data.entries.filter(e=>e.category==='extension').map(e=>e.word.toLowerCase()));
  assert.equal(ext.length,350);assert.equal(new Set(ext).size,350);assert.ok(ext.every(w=>!old.has(w)&&!core.has(w)));
  const ids=all.flatMap(c=>c.data.entries.map(e=>e.id));assert.equal(new Set(ids).size,1455);
});

test('four-term routing retains old deep links and selects new stories and words independently',()=>{
  for(const {id,prefix} of COURSE_INFO){assert.equal(isCoursePrefix(prefix),true);assert.equal(courseForPath([prefix,'english']),id);assert.equal(courseForPath(['settings'],id),id);}
  for(const route of ['day','english','review','practice'])assert.equal(courseForPath([route,'1'],GRADE5_SPRING),AUTUMN);
  assert.equal(courseForPath(['word','f272']),GRADE5_AUTUMN);assert.equal(courseForPath(['word','g333']),GRADE5_SPRING);
  assert.equal(courseHref('story/t01',GRADE5_AUTUMN),'#/grade5-autumn/story/t01');assert.equal(courseHref('day/1',SPRING),'#/spring/day/1');
  for(const id of ['f000','f273','g000','g334','f001x','t01','v01s01'])assert.equal(validWordId(id),false);
});

test('four resume positions and tombstones survive offline refresh and subsequent cloud upload',async()=>{
  const saved=new Map(),storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};let applied;
  const options={storage,localOnly:true,api:()=>assert.fail('local mode cannot call cloud'),apply:f=>applied=f,notify:()=>{}};
  let sync=new ProgressSync(options);const positions=Object.fromEntries(Object.entries(COURSE_LIMITS).map(([id,r])=>[id,{lastDay:r.days,lastIndex:r.index}]));
  await sync.start({courseId:GRADE5_SPRING,positions,status:{w001:'learned',s325:'practice',f272:'learned',g333:'practice'}});
  sync.change('f272',null);sync.stop();sync=new ProgressSync(options);await sync.start();
  for(const [id,p]of Object.entries(positions))assert.deepEqual(applied[positionField(id)].value,p);
  assert.equal(applied.w001.value,'learned');assert.equal(applied.g333.value,'practice');assert.equal(applied.f272.value,null);sync.stop();
  let uploaded;sync=new ProgressSync({...options,localOnly:false,api:async(_url,o)=>o?.method?(uploaded=JSON.parse(o.body),{ok:true}):{fields:{}}});await sync.start();assert.equal(uploaded.fields.g333.value,'practice');assert.equal(uploaded.fields.f272.value,null);assert.equal(sync.pending,null);sync.stop();
});

test('progress API round trips a full four-course record and merges a second device without losing older terms',async()=>{
  const actor='a'.repeat(32),field=value=>({value,clock:1,actor}),fields={};
  for(const r of Object.values(COURSE_LIMITS)){
    fields[r.position]=field({lastDay:r.days,lastIndex:r.index});
    for(let n=1;n<=r.words;n++)fields[r.prefix+String(n).padStart(3,'0')]=field(n%2?'learned':'practice');
  }
  assert.equal(Object.keys(fields).length,1459);assert.equal(MAX_PROGRESS_FIELDS,1459);assert.deepEqual(validateFields(fields),fields);
  for(const [name,value] of [['f273','learned'],['g334','learned'],['grade5AutumnPosition',{lastDay:138,lastIndex:0}],['grade5SpringPosition',{lastDay:168,lastIndex:16}]])assert.throws(()=>validateFields({[name]:field(value)}));
  const origin='https://grade5.example',env={ACCOUNT_USERNAME:'testchild',ACCOUNT_PASSWORD_SALT:'ab'.repeat(16),ACCOUNT_PASSWORD_HASH:pbkdf2Sync('synthetic-grade5',Buffer.from('ab'.repeat(16),'hex'),120000,32,'sha256').toString('hex'),SESSION_SECRET:'cd'.repeat(32)};
  const map=new Map(),kv={get:async k=>map.get(k)||null,put:async(k,v)=>map.set(k,v),list:async({prefix})=>({keys:map.size?[...map.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})):null,complete:true})};
  const request=(path,method='GET',data,auth={})=>new Request(origin+path,{method,headers:{...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...auth},...(data?{body:JSON.stringify(data)}:{})});
  const login=await handle(request('/api/login','POST',{username:env.ACCOUNT_USERNAME,password:'synthetic-grade5'}),env,kv);assert.equal(login.status,200);const session=await login.json(),auth={Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  assert.equal((await handle(request('/api/progress','POST',{writer:actor,sequence:1,fields},auth),env,kv)).status,200);
  const remoteActor='b'.repeat(32),patch={g333:{value:null,clock:2,actor:remoteActor}};
  assert.equal((await handle(request('/api/progress','POST',{writer:remoteActor,sequence:1,fields:patch},auth),env,kv)).status,200);
  const restored=await (await handle(request('/api/progress','GET',null,auth),env,kv)).json();assert.deepEqual(restored.fields,{...fields,...patch});
});

test('every distributed MP3 is referenced by a course, and old collections remain byte-for-byte unchanged',async()=>{
  const used=new Set(all.flatMap(c=>Object.values(c.audio.entries).flatMap(accents=>Object.values(accents).flatMap(parts=>Object.values(parts).map(clip=>clip.src.split('/').at(-1))))));
  const actual=await readdir(new URL('../dist/audio/clips/',import.meta.url));assert.deepEqual(actual.filter(p=>p.endsWith('.mp3')).sort(),[...used].sort());
  const originalHashes={
    'data.json':'a1e3c6834fc0ea26dec597d5c898470079f16c196c5aa6f55fbac3ebadff106e',
    'spring-data.json':'cdffa06586dc413430839d6258544fc68739f70092353ea9507d87d8cbfbf50d',
    'audio-manifest.json':'3f7d40c88a79a48b66f66792090ad9cd95b15576fe731a0551bde6d02e1c9c10',
    'spring-audio-manifest.json':'0e1c587c97585bb992fcaf15843cddcd1019f71ada0da0fb5383a24a32486216'
  };
  for(const [file,expected] of Object.entries(originalHashes))assert.equal(hash(await read('dist/'+file)),expected,file);
});
