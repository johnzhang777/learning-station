import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {handle} from '../server/learning-api.js';
import {handleFeedbackLogin} from '../server/node-feedback-login.js';
import {developerCredential,developerPassword,loginDeveloper,provisionDeveloper} from './helpers/developer.mjs';
const origin='https://developer.example',env={ACCOUNT_USERNAME:'testchild',ACCOUNT_PASSWORD_SALT:'ab'.repeat(16),ACCOUNT_PASSWORD_HASH:'ef'.repeat(32),SESSION_SECRET:'cd'.repeat(32)};
class KV{data=new Map();get=async key=>this.data.get(key)||null;put=async(k,v)=>this.data.set(k,v);list=async()=>({keys:null,complete:true,cursor:null});}
function request(path,data,extra={}){return new Request(origin+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});}
const sign=text=>createHmac('sha256',Buffer.from(env.SESSION_SECRET,'hex')).update(text).digest('hex');
const edge=(kv,now=Date.now())=>(path,options={})=>handle(request(path,options.data,options.cookie?{Cookie:options.cookie}:{}),env,kv,{now});
test('encrypted password ticket hides verifier and binds one password, origin, version and expiry',async()=>{
  const kv=new KV(),now=Date.now(),call=edge(kv,now);await provisionDeveloper(kv);
  const response=await call('/api/feedback/admin-login-ticket',{data:{password:developerPassword}});const offered=await response.json();assert.equal(response.status,200);
  const visible=Buffer.from(offered.ticket,'base64').toString();for(const value of [developerPassword,developerCredential.hash,developerCredential.salt,env.SESSION_SECRET])assert.equal(visible.includes(value),false);
  let derivations=0;const derive=()=>{derivations++;throw Error('must not derive');};
  for(const [password,ticket,source,time]of [['wrong-password',offered.ticket,origin,now],[developerPassword,offered.ticket.slice(0,-4)+'AAAA',origin,now],[developerPassword,offered.ticket,'https://other.example',now],[developerPassword,offered.ticket,origin,now+61000]]){
    const res=await handleFeedbackLogin(new Request(origin+'/auth/feedback-login',{method:'POST',headers:{Origin:source,'Content-Type':'application/json'},body:JSON.stringify({password,ticket})}),env,{now:time,derive});assert.equal(res.status,401);
  }
  assert.equal(derivations,0);
  const valid=await handleFeedbackLogin(request('/auth/feedback-login',{password:developerPassword,ticket:offered.ticket}),env,{now});assert.equal(valid.status,200);
  const proof=await valid.json();const cookie=await call('/api/feedback/admin-login',{data:proof});assert.equal(cookie.status,200);
  await kv.put('feedback_admin_password_v1',JSON.stringify({...developerCredential,version:'34'.repeat(16)}));
  assert.equal((await call('/api/feedback/admin-login',{data:proof})).status,401);
  const session=await call('/api/feedback/session',{cookie:cookie.headers.get('set-cookie').split(';')[0]});assert.equal((await session.json()).role,'guest');
});
test('password configuration requires an operator signature, rejects stale versions and stores only a verifier',async()=>{
  const kv=new KV(),now=Date.now(),credential={...developerCredential,updatedAt:now};
  const post=(body,signature)=>handle(request('/api/feedback/admin-password',body,signature?{'X-Feedback-Config-Signature':signature}:{}),env,kv,{now});
  assert.equal((await post(credential)).status,403);assert.equal(kv.data.size,0);
  const signature=sign('learning-station:feedback-password-config:v1\n'+JSON.stringify(credential));
  assert.equal((await post(credential,signature)).status,200);assert.equal((await post(credential,signature)).status,200);
  assert.equal((await post({...credential,hash:'0'.repeat(64)},signature)).status,403);
  const older={...credential,updatedAt:now-1};assert.equal((await post(older,sign('learning-station:feedback-password-config:v1\n'+JSON.stringify(older)))).status,409);
  assert.equal([...kv.data.values()].some(v=>v.includes(developerPassword)),false);
  const login=await loginDeveloper({request:edge(kv,now),env,kv,origin,now});assert.ok(login.cookie);
  assert.equal((await edge(kv,now)('/api/feedback/admin-login',{data:{code:sign('learning-station:feedback-admin-access:v1\n')}})).status,401);
});
