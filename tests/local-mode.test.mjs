import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressSync, RECORD_KEY } from '../dist/progress-sync.js';
const store=()=>{const saved=new Map();return {getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};};
test('local mode keeps sync v2 fields and tombstones, persists changes across refresh, never calls cloud',async()=>{
  const storage=store(),actor='a'.repeat(32);let calls=0,applied;
  const fields={w001:{value:'learned',clock:7,actor},w002:{value:null,clock:8,actor},position:{value:{lastDay:8,lastIndex:4},clock:9,actor}};
  storage.setItem(RECORD_KEY,JSON.stringify({fields,pending:{writer:actor,sequence:10,fields}}));
  const options={storage,localOnly:true,api:async()=>{calls++;throw Error('Cloud must not be called');},apply:value=>{applied=value;},notify:()=>{}};
  let sync=new ProgressSync(options);await sync.start({status:{w002:'learned'},lastDay:1,lastIndex:0});
  assert.equal(applied.w001.value,'learned');assert.equal(applied.w002.value,null);assert.equal(applied.position.value.lastDay,8);
  sync.change('w003','practice');sync.change('w001',null);await sync.pull();await sync.flush();sync.schedule(1);
  assert.equal(sync.timer,undefined);assert.equal(calls,0);sync.stop();
  sync=new ProgressSync(options);await sync.start();assert.equal(applied.w003.value,'practice');assert.equal(applied.w001.value,null);assert.ok(sync.pending);assert.equal(calls,0);sync.stop();
});
test('local mode migrates v1-only records, and current login implementation can later upload the retained queue',async()=>{
  const storage=store();let applied,uploaded;
  let sync=new ProgressSync({storage,localOnly:true,api:()=>{throw Error('No cloud');},apply:value=>applied=value,notify:()=>{}});
  await sync.start({status:{w001:'learned',w002:'practice'},lastDay:4,lastIndex:3});
  assert.equal(applied.w001.value,'learned');assert.equal(applied.position.value.lastDay,4);sync.stop();
  const original=await import('../dist/progress-sync.js');
  sync=new original.ProgressSync({storage,api:async(url,options)=>{if(options?.method){uploaded=JSON.parse(options.body);return {ok:true};}return {fields:{}};},apply:()=>{},notify:()=>{}});
  await sync.start();assert.equal(uploaded.fields.w002.value,'practice');assert.equal(sync.pending,null);sync.stop();
});
