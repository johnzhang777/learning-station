import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { handle } from '../server/learning-api.js';

const origin='https://feedback.example', password='synthetic-feedback-729';
const env={ACCOUNT_USERNAME:'testchild',ACCOUNT_PASSWORD_SALT:'ab'.repeat(16),ACCOUNT_PASSWORD_HASH:pbkdf2Sync(password,Buffer.from('ab'.repeat(16),'hex'),120000,32,'sha256').toString('hex'),SESSION_SECRET:'cd'.repeat(32)};
const adminCode=createHmac('sha256',Buffer.from(env.SESSION_SECRET,'hex')).update('learning-station:feedback-admin-access:v1\n').digest('hex');
const uuid=()=>randomBytes(16).toString('hex');
let sequence=0;
const id=prefix=>prefix+String(9999999999999-Date.now()-sequence++).padStart(13,'0')+uuid();
class KV {
  data=new Map();
  get=async key=>this.data.get(key)||null;
  put=async(key,value)=>{assert.match(key,/^[a-zA-Z0-9_]+$/);assert.ok(Buffer.byteLength(value)<300000);this.data.set(key,value);};
  async list({prefix,cursor,limit}) {
    const keys=[...this.data.keys()].filter(key=>key.startsWith(prefix)&&(!cursor||key>=cursor)).sort();
    return {keys:keys.slice(0,limit).map(key=>({key})),complete:keys.length<=limit,cursor:keys[limit]||null};
  }
}
function request(route,{method='GET',data,cookie,csrf,source=origin,type='application/json'}={}) {
  return new Request(origin+route,{method,headers:{...(method==='POST'?{Origin:source,'Content-Type':type}:{}),...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
}
const call=(kv,route,options={},extra={})=>handle(request('/api/feedback'+route,options),env,kv,extra);
const post=(kv,route,auth,data,extra)=>call(kv,route,{...auth,method:'POST',data},extra);
async function auth(kv,developer=false,config=env) {
  const response=developer?await post(kv,'/admin-login',{}, {code:adminCode}):await handle(request('/api/login',{method:'POST',data:{username:config.ACCOUNT_USERNAME,password}}),config,kv);
  assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  return {cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf};
}
async function newThread(kv,user,text='测试留言',attachments=[]) {
  const input={id:id('t'),text,attachments};
  const response=await post(kv,'/threads',user,input);assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
  return {input,thread:(await response.json()).thread};
}
async function upload(kv,user,bytes,type='application/pdf',name='学习资料.pdf') {
  const input={id:uuid(),name,type,size:bytes.length};
  const response=await post(kv,'/uploads',user,input);assert.equal(response.status,201);
  const meta=await response.json();
  for(let i=0;i<meta.chunks;i++) {
    const chunk=await post(kv,`/uploads/${input.id}/chunks/${i}`,user,{data:bytes.subarray(i*meta.chunkSize,(i+1)*meta.chunkSize).toString('base64')});
    assert.equal(chunk.status,200,JSON.stringify(await chunk.clone().json()));
  }
  return input;
}

test('feedback requires a server identity, same origin and independent CSRF; all reads are private',async()=>{
  const kv=new KV();
  const guest=await call(kv,'/session');assert.equal((await guest.json()).role,'guest');
  assert.equal((await call(kv,'/threads')).status,401);
  assert.equal((await post(kv,'/threads',{},{})).status,401);
  const user=await auth(kv);
  assert.equal((await post(kv,'/threads',{cookie:user.cookie},{})).status,403);
  assert.equal((await call(kv,'/threads',{...user,method:'POST',data:{},source:'https://other.example'})).status,403);
  assert.equal((await call(kv,'/threads',{...user,method:'POST',data:{},type:'text/plain'})).status,415);
  for(const route of ['/session','/threads']) {
    const response=await call(kv,route,user);assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('vary'),'Cookie');
  }
  const session=await (await call(kv,'/session',user)).json();assert.equal(session.role,'user');assert.equal(session.canManage,false);
});

test('empty native KV lists may omit keys or return null keys for threads and replies',async()=>{
  for(const emptyPage of [{complete:true,cursor:null,keys:null},{complete:true,cursor:null}]){
    const kv=new KV(),user=await auth(kv),list=kv.list.bind(kv);
    kv.list=async options=>{const page=await list(options);return page.keys.length?page:emptyPage;};
    const response=await call(kv,'/threads',user);
    assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
    assert.deepEqual(await response.json(),{threads:[],cursor:null});
    const {thread}=await newThread(kv,user);
    const history=await call(kv,'/threads',user);assert.equal(history.status,200);
    const first=(await history.json()).threads[0];assert.equal(first.id,thread.id);assert.equal(first.hasReply,false);
    const detail=await call(kv,'/threads/'+thread.id,user);assert.equal(detail.status,200);
    const value=await detail.json();assert.deepEqual(value.replies,[]);assert.equal(value.cursor,null);
  }
});

test('invalid KV list responses fail with a storage diagnostic instead of hiding history',async()=>{
  const kv=new KV(),user=await auth(kv),errors=[],original=console.error;
  console.error=value=>errors.push(value);
  try{
    for(const page of [null,{complete:true,keys:{}},{complete:'false',keys:[]},{complete:false,cursor:null,keys:null},{complete:false,cursor:'same',keys:[]},{complete:true,keys:[{key:123}]}]){
      kv.list=async()=>page;
      const response=await call(kv,'/threads?cursor=same',user);assert.equal(response.status,503);
      const value=await response.json();assert.equal(value.code,'FEEDBACK_LIST');assert.equal(value.kind,'TypeError');
    }
    assert.ok(errors.every(value=>JSON.parse(value).code==='FEEDBACK_LIST'));
  }finally{console.error=original;}
  // Even an empty intermediate page must retain its continuation cursor.
  kv.list=async()=>({complete:false,cursor:'next',keys:null});
  const response=await call(kv,'/threads',user);assert.deepEqual(await response.json(),{threads:[],cursor:'next'});
});

test('text history survives a new login and pagination; client roles never grant developer privileges',async()=>{
  const kv=new KV(),user=await auth(kv);
  const first=await newThread(kv,user,'<script>用户文本</script>\n第二行');
  const retry=await post(kv,'/threads',user,{...first.input,role:'developer',owner:'developer'});assert.equal(retry.status,200);
  assert.equal((await retry.json()).thread.role,'user');
  assert.equal((await post(kv,'/threads',user,{...first.input,text:'changed'})).status,409);
  for(let i=0;i<22;i++)await newThread(kv,user,'历史留言 '+i);
  const refreshed=await auth(kv),seen=new Set();let cursor;
  do {
    const page=await (await call(kv,'/threads'+(cursor?'?cursor='+encodeURIComponent(cursor):''),refreshed)).json();
    for(const t of page.threads){assert.equal(seen.has(t.id),false);seen.add(t.id);assert.equal('owner' in t,false);}cursor=page.cursor;
  }while(cursor);
  assert.equal(seen.size,23);assert.ok(seen.has(first.thread.id));
  const detail=await (await call(kv,'/threads/'+first.thread.id,refreshed)).json();assert.equal(detail.thread.text,first.input.text);
  const other={...env,ACCOUNT_USERNAME:'otherchild'},second=await auth(kv,false,other);
  const foreign=route=>handle(request('/api/feedback'+route,second),other,kv);
  assert.deepEqual((await (await foreign('/threads')).json()).threads,[]);
  assert.equal((await foreign('/threads/'+first.thread.id)).status,404);
});

test('developer login has a signed one-hour cookie; learning credentials cannot forge it',async()=>{
  const kv=new KV(),user=await auth(kv);
  assert.equal((await post(kv,'/admin-login',user,{code:env.SESSION_SECRET})).status,401);
  assert.equal((await call(kv,'/session',{cookie:user.cookie.replace('__Host-learning_session','__Host-feedback_admin')})).status,200);
  assert.equal((await (await call(kv,'/session',{cookie:user.cookie.replace('__Host-learning_session','__Host-feedback_admin')})).json()).role,'guest');
  const now=Date.now(),response=await post(kv,'/admin-login',{}, {code:adminCode},{now});
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Max-Age=3600; Secure/);
  const developer={cookie:response.headers.get('set-cookie').split(';')[0],csrf:(await response.json()).csrf};
  const session=await (await call(kv,'/session',developer,{now:now+30000})).json();assert.equal(session.canManage,true);
  assert.equal((await call(kv,'/threads',developer,{now:now+3601000})).status,401);
  assert.equal((await call(kv,'/threads',{cookie:developer.cookie+'x'})).status,401);
  assert.equal((await post(kv,'/admin-logout',{cookie:developer.cookie},{})).status,403);
  const out=await post(kv,'/admin-logout',developer,{});assert.equal(out.status,200);assert.match(out.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await handle(request('/api/progress',developer),env,kv)).status,401);
});

test('developer and user replies are distinct, concurrent replies survive and retry creates no duplicate',async()=>{
  const kv=new KV(),user=await auth(kv),developer=await auth(kv,true),{thread}=await newThread(kv,user);
  const inputs=[{id:id('r'),text:'开发者回复',attachments:[],role:'user'},{id:id('r'),text:'用户追加',attachments:[],role:'developer'}];
  const responses=await Promise.all(inputs.map((input,i)=>post(kv,`/threads/${thread.id}/replies`,i?user:developer,input)));
  assert.deepEqual(responses.map(x=>x.status),[201,201]);
  assert.equal((await post(kv,`/threads/${thread.id}/replies`,developer,inputs[0])).status,200);
  const detail=await (await call(kv,'/threads/'+thread.id,user)).json();assert.equal(detail.replies.length,2);
  assert.equal(detail.replies.find(r=>r.text==='开发者回复').role,'developer');assert.equal(detail.replies.find(r=>r.text==='用户追加').role,'user');
  assert.equal((await (await call(kv,'/threads',user)).json()).threads[0].hasReply,true);
  // Reply histories longer than one page preserve every independently stored reply.
  for(let i=0;i<31;i++)assert.equal((await post(kv,`/threads/${thread.id}/replies`,developer,{id:id('r'),text:'reply '+i,attachments:[]})).status,201);
  const seen=new Set();let cursor;
  do {const page=await (await call(kv,'/threads/'+thread.id+(cursor?'?cursor='+encodeURIComponent(cursor):''),user)).json();for(const r of page.replies)seen.add(r.id);cursor=page.cursor;}while(cursor);
  assert.equal(seen.size,33);
});

test('PDF and image chunks persist byte-for-byte and can be downloaded only through their private thread',async()=>{
  const kv=new KV(),user=await auth(kv),developer=await auth(kv,true);
  const pdf=Buffer.alloc(450000,65);pdf.write('%PDF-1.7\n');pdf.write('%%EOF',pdf.length-5);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(1050,18)]);
  const files=[await upload(kv,user,pdf),await upload(kv,user,png,'image/png','截图.png')];
  assert.equal((await call(kv,'/attachments/'+files[0].id,user)).status,404);
  const {thread}=await newThread(kv,user,'文字＋PDF＋图片',files.map(f=>f.id));
  for(const reader of [user,developer])for(let i=0;i<files.length;i++){
    const response=await call(kv,'/attachments/'+files[i].id,reader);assert.equal(response.status,200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),i?png:pdf);assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('content-security-policy'),/sandbox/);
    assert.match(response.headers.get('content-disposition'),i?/^inline/:/^attachment/);
  }
  assert.equal((await call(kv,'/attachments/'+files[0].id)).status,401);
  const other={...env,ACCOUNT_USERNAME:'otherchild'},second=await auth(kv,false,other);
  assert.equal((await handle(request('/api/feedback/attachments/'+files[0].id,second),other,kv)).status,404);
  assert.equal((await post(kv,'/threads',user,{id:id('t'),text:'不能挪用附件',attachments:[files[0].id]})).status,409);
  // A developer may attach a separate document in a reply.
  const replyFile=await upload(kv,developer,png,'image/png','开发者说明.png');
  assert.equal((await post(kv,`/threads/${thread.id}/replies`,developer,{id:id('r'),text:'',attachments:[replyFile.id]})).status,201);
  assert.equal((await call(kv,'/attachments/'+replyFile.id,user)).status,200);
});

test('invalid, oversized, incomplete, expired and borrowed uploads never become attachments',async()=>{
  const kv=new KV(),user=await auth(kv),developer=await auth(kv,true);
  for(const input of [{type:'text/html',size:20},{type:'application/pdf',size:5*1024*1024+1},{type:'image/png',size:0}])assert.equal((await post(kv,'/uploads',user,{id:uuid(),name:'bad',...input})).status,400);
  const input={id:uuid(),name:'incomplete.pdf',type:'application/pdf',size:200000};
  assert.equal((await post(kv,'/uploads',user,input)).status,201);
  assert.equal((await post(kv,'/uploads',user,input)).status,200);
  const chunk='/uploads/'+input.id+'/chunks/0';
  assert.equal((await post(kv,chunk,user,{data:Buffer.alloc(192*1024,65).toString('base64')})).status,400);
  assert.equal((await post(kv,chunk,user,{data:'%PDF-not-base64'})).status,400);
  const good=Buffer.alloc(192*1024,65);good.write('%PDF-1.7');
  assert.equal((await post(kv,chunk,user,{data:good.toString('base64')})).status,200);
  good[100]=66;assert.equal((await post(kv,chunk,user,{data:good.toString('base64')})).status,409);
  assert.equal((await post(kv,'/threads',user,{id:id('t'),text:'未完成',attachments:[input.id]})).status,409);
  assert.equal((await post(kv,'/threads',developer,{id:id('t'),text:'借用',attachments:[input.id]})).status,400);
  assert.equal((await post(kv,chunk,user,{data:good.toString('base64')},{now:Date.now()+25*3600000})).status,409);
  assert.equal((await post(kv,'/threads',user,{id:id('t'),text:'',attachments:[]})).status,400);
  assert.equal((await post(kv,'/threads',user,{id:id('t'),text:'中'.repeat(5001),attachments:[]})).status,400);
  assert.equal((await post(kv,'/threads',user,{id:id('t'),text:'重复',attachments:[input.id,input.id]})).status,400);
});

test('feedback write failures never acknowledge delivery and do not disclose raw data',async()=>{
  const kv=new KV(),user=await auth(kv);const original=kv.put;
  kv.put=async(key,value)=>{if(key.startsWith('feedback_thread_'))throw Error('private raw backend detail');return original(key,value);};
  const errors=[],error=console.error;console.error=message=>errors.push(message);
  try {
    const input={id:id('t'),text:'保留草稿',attachments:[]};const response=await post(kv,'/threads',user,input);
    assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,'FEEDBACK_WRITE');assert.equal(JSON.stringify(body).includes('private raw'),false);
    assert.equal(errors.some(s=>s.includes('private raw')),false);
    kv.put=original;assert.equal((await post(kv,'/threads',user,input)).status,201);
  }finally{console.error=error;}
});

test('invalid developer codes and excessive message posting are throttled',async()=>{
  const kv=new KV();
  for(let i=0;i<8;i++)assert.equal((await post(kv,'/admin-login',{}, {code:'0'.repeat(64)})).status,401);
  assert.equal((await post(kv,'/admin-login',{}, {code:adminCode})).status,429);
  const user=await auth(kv);
  for(let i=0;i<80;i++)await newThread(kv,user,'留言 '+i);
  assert.equal((await post(kv,'/threads',user,{id:id('t'),text:'too frequent',attachments:[]})).status,429);
});
