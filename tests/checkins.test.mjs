import test from 'node:test';
import assert from 'node:assert/strict';
import {pbkdf2Sync} from 'node:crypto';
import {handle} from '../server/learning-api.js';
import {CheckinBoard,chinaToday} from '../dist/checkins.js';
const now=Date.parse('2026-11-07T16:00:01Z'),origin='https://checkin.example';
const env={ACCOUNT_USERNAME:'testchild',ACCOUNT_PASSWORD_SALT:'ab'.repeat(16),ACCOUNT_PASSWORD_HASH:pbkdf2Sync('synthetic-checkin',Buffer.from('ab'.repeat(16),'hex'),120000,32,'sha256').toString('hex'),SESSION_SECRET:'cd'.repeat(32)};
class KV{
  data=new Map();get=async key=>this.data.get(key)||null;put=async(key,value)=>this.data.set(key,value);
  async list({prefix,cursor,limit}){const keys=[...this.data.keys()].filter(k=>k.startsWith(prefix)&&(!cursor||k>=cursor)).sort();return {keys:keys.length?keys.slice(0,limit).map(key=>({key})):null,complete:keys.length<=limit,cursor:keys[limit]||null};}
}
function request(path,{method='GET',data,cookie,csrf,source=origin}={}){return new Request(origin+path,{method,headers:{...(method==='POST'?{Origin:source,'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});}
const call=(kv,path,options={},config=env,time=now)=>handle(request(path,options),config,kv,{now:time});
async function login(kv,config=env){const res=await call(kv,'/api/login',{method:'POST',data:{username:config.ACCOUNT_USERNAME,password:'synthetic-checkin'}},config);assert.equal(res.status,200);return {cookie:res.headers.get('set-cookie').split(';')[0],csrf:(await res.json()).csrf};}
const input=(date,n=1)=>({date,id:n.toString(16).padStart(32,'0')});

test('China calendar crosses midnight at UTC 16:00 and empty native lists are valid',async()=>{
  assert.equal(chinaToday(Date.parse('2026-11-07T15:59:59Z')),'2026-11-07');assert.equal(chinaToday(now),'2026-11-08');
  const kv=new KV(),user=await login(kv),res=await call(kv,'/api/checkins?month=2026-11',user);assert.equal(res.status,200);
  assert.deepEqual((await res.json()).records,[]);assert.equal(res.headers.get('cache-control'),'private, no-store');
});
test('check-in and make-up history are persisted and their type is assigned by the server',async()=>{
  const kv=new KV(),user=await login(kv);
  for(const [date,kind,n]of [['2026-11-08','normal',1],['2026-11-07','makeup',2]]){
    const res=await call(kv,'/api/checkins',{...user,method:'POST',data:{...input(date,n),kind:kind==='normal'?'makeup':'normal'}});assert.equal(res.status,200);
    const body=await res.json();assert.equal(body.record.kind,kind);assert.equal(body.record.createdAt,now);
  }
  const fresh=await login(kv),history=await (await call(kv,'/api/checkins?month=2026-11',fresh)).json();assert.equal(history.records.length,2);
  assert.equal(history.records[0].kind,'makeup');assert.equal(history.records[1].kind,'normal');assert.equal('owner' in history.records[0],false);
});
test('duplicate retries and concurrent requests keep one visible day and preserve the first normal check-in',async()=>{
  const kv=new KV(),user=await login(kv),options={...user,method:'POST',data:input('2026-11-08')};
  const first=await (await call(kv,'/api/checkins',options)).json();
  const retry=await (await call(kv,'/api/checkins',options,env,now+86400000)).json();assert.deepEqual(retry.record,first.record);
  await Promise.all([2,3].map(n=>call(kv,'/api/checkins',{...user,method:'POST',data:input('2026-11-08',n)})));
  const records=(await (await call(kv,'/api/checkins?month=2026-11',user)).json()).records;assert.equal(records.length,1);assert.equal(records[0].kind,'normal');
});
test('check-ins require account, origin and CSRF; another account cannot read the history',async()=>{
  const kv=new KV(),user=await login(kv);
  assert.equal((await call(kv,'/api/checkins')).status,401);
  assert.equal((await call(kv,'/api/checkins',{method:'POST',cookie:user.cookie,data:input('2026-11-08')})).status,403);
  assert.equal((await call(kv,'/api/checkins',{...user,method:'POST',source:'https://other.example',data:input('2026-11-08')})).status,403);
  await call(kv,'/api/checkins',{...user,method:'POST',data:input('2026-11-08')});
  const otherEnv={...env,ACCOUNT_USERNAME:'otherchild'},other=await login(kv,otherEnv);
  assert.deepEqual((await (await call(kv,'/api/checkins?month=2026-11',other,otherEnv)).json()).records,[]);
});
test('future and nonexistent dates are rejected and months are filtered',async()=>{
  const kv=new KV(),user=await login(kv);
  for(const date of ['2026-11-09','2026-02-30','2026-13-01','bad'])assert.equal((await call(kv,'/api/checkins',{...user,method:'POST',data:input(date)})).status,400);
  assert.equal((await call(kv,'/api/checkins?month=2026-12',user)).status,400);
  await call(kv,'/api/checkins',{...user,method:'POST',data:input('2026-10-31')});
  assert.equal((await (await call(kv,'/api/checkins?month=2026-10',user)).json()).records.length,1);
  assert.equal((await (await call(kv,'/api/checkins?month=2026-11',user)).json()).records.length,0);
});
test('write failure does not acknowledge a check-in',async()=>{
  const kv=new KV(),user=await login(kv),put=kv.put;kv.put=async()=>{throw Error('sensitive storage failure');};
  const old=console.error;console.error=()=>{};
  try{const res=await call(kv,'/api/checkins',{...user,method:'POST',data:input('2026-11-08')});assert.equal(res.status,503);assert.equal((await res.json()).code,'CHECKIN_WRITE');}finally{console.error=old;kv.put=put;}
  assert.equal((await (await call(kv,'/api/checkins',user)).json()).records.length,0);
});
test('local check-ins survive refresh without cloud calls; failed cloud retries retain the request ID',async()=>{
  const saved=new Map(),storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
  let calls=0;const local=new CheckinBoard({localOnly:true,owner:'local',storage,toast:()=>{},api:()=>{calls++;}});local.render=()=>{};
  local.today='2026-11-08';await local.sign('2026-11-08');await local.sign('2026-11-07');assert.equal(calls,0);
  const restored=new CheckinBoard({localOnly:true,owner:'local',storage,toast:()=>{}});assert.equal(restored.records['2026-11-07'].kind,'makeup');assert.equal(restored.records['2026-11-08'].kind,'normal');
  const ids=[],cloud=new CheckinBoard({localOnly:false,owner:'testchild',storage,toast:()=>{},api:async(path,options)=>{const value=JSON.parse(options.body);ids.push(value.id);if(ids.length===1)throw Error('unavailable');return {today:'2026-11-08',record:{...value,kind:'normal',createdAt:now}};}});cloud.render=()=>{};cloud.today='2026-11-08';
  await cloud.sign('2026-11-08');assert.equal(cloud.records['2026-11-08'],undefined);await cloud.sign('2026-11-08');assert.equal(ids[0],ids[1]);assert.equal(cloud.records['2026-11-08'].kind,'normal');
});
