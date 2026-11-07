import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { AUTUMN,SPRING,courseForPath,validWordId,positionField,audioEntries } from '../dist/courses.js';
import { createFeedbackGate,FeedbackBoard } from '../dist/feedback.js';
import { ProgressSync } from '../dist/progress-sync.js';
import { validateFields,handle } from '../server/learning-api.js';
import { pbkdf2Sync } from 'node:crypto';

const data=JSON.parse(await readFile(new URL('../dist/spring-data.json',import.meta.url),'utf8'));
const audio=JSON.parse(await readFile(new URL('../dist/spring-audio-manifest.json',import.meta.url),'utf8'));
const entryMap=new Map(data.entries.map(e=>[e.id,e]));

test('spring calendar exactly matches 3 textbook + 2 extension on all 88 acquisition days',()=>{
  assert.equal(data.days.length,153);assert.equal(data.weeks.length,22);assert.equal(data.entries.length,325);
  assert.equal(data.days[0].date,'2027-03-01');assert.equal(data.days.at(-1).date,'2027-07-31');
  const learn=data.days.filter(d=>d.kind==='learn');assert.equal(learn.length,88);
  assert.equal(data.entries.filter(e=>e.category==='core').length,149);assert.equal(data.entries.filter(e=>e.category==='extension').length,176);
  assert.equal(new Set(data.days.map(d=>d.date)).size,153);assert.equal(new Set(data.entries.map(e=>e.id)).size,325);
  let slots=0;
  for(const d of data.days){
    assert.equal(new Date(d.date+'T00:00:00Z').getUTCDay(),(d.weekday+1)%7);
    assert.equal(d.entryIds.every(id=>entryMap.has(id)),true);assert.equal(new Set(d.entryIds).size,d.entryIds.length);
    if(d.kind==='learn'){
      assert.ok(d.date<'2027-07-01');assert.ok(d.weekday<5);
      assert.deepEqual(d.entryIds.map(id=>entryMap.get(id).category),['core','core','core','extension','extension']);slots+=d.entryIds.length;
    }
    if(d.weekday===6)assert.equal(d.kind,'rest');
  }
  assert.equal(slots,440);assert.equal(new Set(learn.flatMap(d=>d.entryIds)).size,325);
  for(const entry of data.entries){
    assert.equal(validWordId(entry.id),true);assert.ok(entry.ipaUK&&entry.ipaUS&&entry.source);
    assert.equal(entry.examples.length,2);for(const x of entry.examples)assert.ok(x.en&&x.zh&&x.scene);
    assert.ok(data.days[entry.day-1].entryIds.includes(entry.id));
  }
});

test('July rereads all 325 distinct words, with 12 stories at 2–3 per week',()=>{
  const recall=data.days.filter(d=>d.kind==='recall');assert.equal(recall.length,22);
  assert.equal(new Set(recall.flatMap(d=>d.entryIds)).size,325);assert.equal(recall.flatMap(d=>d.entryIds).length,325);
  assert.equal(data.stories.length,12);assert.deepEqual(data.weeks.filter(w=>w.storyIds.length).map(w=>w.storyIds.length),[2,3,2,3,2]);
  for(const s of data.stories){
    assert.equal(data.days[s.day-1].storyId,s.id);assert.ok(s.focusIds.every(id=>entryMap.has(id)));
    assert.equal(s.sentences.map(x=>x.text).join(' '),s.paragraphs.join(' '));
    assert.equal(s.questions.length,3);assert.equal(s.cloze.length,2);assert.ok(s.translation.length&&s.oral&&s.retell.length);
    assert.ok(s.wordCount>=80&&s.wordCount<=120);
  }
});

test('both accents cover every word, example, full story and sentence with existing individual MP3s',async()=>{
  const expected=new Map(data.entries.map(e=>[e.id,['word','ex1','ex2']]));
  for(const s of data.stories){expected.set(s.id,['passage']);for(const sentence of s.sentences)expected.set(sentence.id,['sentence']);}
  assert.equal(expected.size,485);assert.deepEqual(Object.keys(audio.entries).sort(),[...expected.keys()].sort());
  const files=new Set();let count=0;
  for(const [id,parts] of expected)for(const accent of ['uk','us']){
    assert.deepEqual(Object.keys(audio.entries[id][accent]).sort(),[...parts].sort());
    for(const part of parts){const clip=audio.entries[id][accent][part];assert.match(clip.src,/^audio\/clips\/[a-z0-9-]+\.mp3$/);assert.equal(clip.start,0);assert.ok(clip.end>0);files.add(clip.src);count++;}
  }
  assert.equal(count,2270);
  for(const file of files)assert.ok((await stat(new URL('../dist/'+file,import.meta.url))).size>1000,file);
  assert.equal(audioEntries(data).length,160);
  for(const file of ['student.pdf','parent.pdf'])assert.ok((await stat(new URL('../dist/materials/grade4-spring/'+file,import.meta.url))).size>100000);
});

test('legacy links retain autumn semantics while spring links and global navigation preserve selected course',()=>{
  for(const route of ['english','day','review','practice'])assert.equal(courseForPath([route,'32'],SPRING),AUTUMN);
  assert.equal(courseForPath(['spring','day','32'],AUTUMN),SPRING);assert.equal(courseForPath(['autumn','english'],SPRING),AUTUMN);
  assert.equal(courseForPath(['word','s325'],AUTUMN),SPRING);assert.equal(courseForPath(['word','w525'],SPRING),AUTUMN);
  for(const route of ['home','library','settings','feedback'])assert.equal(courseForPath([route],SPRING),SPRING);
  assert.equal(positionField(SPRING),'springPosition');assert.equal(positionField(AUTUMN),'position');
  for(const id of ['s000','s326','w000','w526','r01','r01s01','__proto__'])assert.equal(validWordId(id),false);
});

test('feedback gate opens only on the fifth consecutive rapid tap, with no slow-tap accumulation',()=>{
  let stamp=0;const gate=createFeedbackGate({now:()=>stamp});
  for(let i=0;i<4;i++){assert.equal(gate.tap(),false);stamp+=150;}assert.equal(gate.tap(),true);
  assert.equal(gate.tap(),false);stamp+=500;assert.equal(gate.tap(),false);
  for(let i=0;i<10;i++){stamp+=500;assert.equal(gate.tap(),false);}
  gate.reset();for(let i=0;i<4;i++){stamp+=100;assert.equal(gate.tap(),false);}gate.reset();stamp+=100;assert.equal(gate.tap(),false);
});

test('two-course local records, tombstones and independent resume positions survive refresh and queued upload',async()=>{
  const saved=new Map(),storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};let applied,uploaded;
  const options={storage,localOnly:true,api:()=>{throw Error('No cloud in local mode');},apply:value=>applied=value,notify:()=>{}};
  let sync=new ProgressSync(options);
  await sync.start({status:{w525:'learned',s325:'practice'},lastDay:121,lastIndex:9,courseId:SPRING,positions:{[AUTUMN]:{lastDay:32,lastIndex:4},[SPRING]:{lastDay:121,lastIndex:9}}});
  assert.equal(applied.position.value.lastDay,32);assert.equal(applied.springPosition.value.lastIndex,9);
  sync.change('s001','learned');sync.change('s325',null);sync.stop();
  sync=new ProgressSync(options);await sync.start();assert.equal(applied.w525.value,'learned');assert.equal(applied.s001.value,'learned');assert.equal(applied.s325.value,null);sync.stop();
  sync=new ProgressSync({...options,localOnly:false,api:async(url,options)=>{if(options?.method){uploaded=JSON.parse(options.body);return {ok:true};}return {fields:{}};}});
  await sync.start();assert.equal(uploaded.fields.position.value.lastDay,32);assert.equal(uploaded.fields.springPosition.value.lastIndex,9);assert.equal(sync.pending,null);sync.stop();
});

test('cloud saves all 850 word records and two positions without overwriting the autumn book',async()=>{
  const actor='a'.repeat(32),field=value=>({value,clock:1,actor}),fields={position:field({lastDay:147,lastIndex:4}),springPosition:field({lastDay:153,lastIndex:14})};
  for(const [prefix,count] of [['w',525],['s',325]])for(let i=1;i<=count;i++)fields[prefix+String(i).padStart(3,'0')]=field(i%2?'learned':'practice');
  assert.equal(Object.keys(validateFields(fields)).length,852);
  for(const [name,value] of [['s326','learned'],['s000','learned'],['springPosition',{lastDay:154,lastIndex:0}],['position',{lastDay:147,lastIndex:5}]])assert.throws(()=>validateFields({[name]:field(value)}));
  const env={ACCOUNT_USERNAME:'testchild',ACCOUNT_PASSWORD_SALT:'ab'.repeat(16),ACCOUNT_PASSWORD_HASH:pbkdf2Sync('spring-test',Buffer.from('ab'.repeat(16),'hex'),120000,32,'sha256').toString('hex'),SESSION_SECRET:'cd'.repeat(32)};
  const map=new Map(),kv={get:async key=>map.get(key)||null,put:async(key,value)=>map.set(key,value),list:async({prefix})=>({keys:[...map.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),complete:true})};
  const request=(route,method='GET',data,auth={})=>new Request('https://spring.example'+route,{method,headers:{...(method==='POST'?{Origin:'https://spring.example','Content-Type':'application/json'}:{}),...auth},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const login=await handle(request('/api/login','POST',{username:env.ACCOUNT_USERNAME,password:'spring-test'}),env,kv),session=await login.json();
  const auth={Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
  assert.equal((await handle(request('/api/progress','POST',{writer:actor,sequence:1,fields},auth),env,kv)).status,200);
  const restored=await (await handle(request('/api/progress','GET',undefined,auth),env,kv)).json();assert.deepEqual(restored.fields,fields);
});

test('feedback rendering treats user text as text, and failed sends retain drafts and idempotent IDs',async()=>{
  const board=new FeedbackBoard({toast:()=>{},loginUrl:'/'});
  const text='<img src=x onerror=alert(1)>\n文本';const html=board.message({id:'x',text,role:'user',createdAt:Date.now(),attachments:[]});
  assert.ok(html.includes('&lt;img'));assert.equal(html.includes('<img src=x'),false);
  board.render=()=>{};const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator');Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:true}});
  try {
    const draft=board.draft();draft.text='网络失败后的文字';const attempts=[];board.request=async(path,options)=>{attempts.push(JSON.parse(options.body));if(attempts.length===1)throw Error('offline');return {thread:{id:draft.id,text:draft.text,attachments:[],role:'user',createdAt:Date.now()}};};
    await board.send();assert.equal(board.draft().text,'网络失败后的文字');assert.equal(board.threadId,undefined);
    await board.send();assert.equal(attempts[0].id,attempts[1].id);assert.equal(board.threads.length,1);
  }finally{if(previous)Object.defineProperty(globalThis,'navigator',previous);else delete globalThis.navigator;}
});

test('feedback attachment selector enforces limits and its real File upload splits bytes without loss',async()=>{
  const board=new FeedbackBoard({toast:()=>{},loginUrl:'/'});board.render=()=>{};
  board.addFiles([new File(['<html>'], 'bad.html',{type:'text/html'})]);assert.equal(board.draft().files.length,0);
  const bytes=new Uint8Array(450000);bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  board.addFiles([new File([bytes],'测试.pdf',{type:'application/pdf'}),new File([new Uint8Array([137,80,78,71,13,10,26,10])],'截图.png',{type:'image/png'})]);
  assert.equal(board.draft().files.length,2);
  board.addFiles([new File([new Uint8Array(5*1024*1024+1)],'too-large.pdf',{type:'application/pdf'})]);assert.equal(board.draft().files.length,2);
  const uploaded=[];board.request=async(path,options)=>{
    if(path==='/uploads')return {chunkSize:192*1024,chunks:3};
    uploaded.push(Buffer.from(JSON.parse(options.body).data,'base64'));return {ok:true};
  };
  const item=board.draft().files[0];assert.equal(await board.upload(item),item.id);assert.deepEqual(Buffer.concat(uploaded),Buffer.from(bytes));
  assert.equal(item.uploaded,true);await board.upload(item);assert.equal(uploaded.length,3);
});
