import assert from 'node:assert/strict';
import {pbkdf2Sync} from 'node:crypto';
import {handleFeedbackLogin} from '../../server/node-feedback-login.js';
export const developerPassword='synthetic-developer-pass-429';
export const developerCredential={salt:'ab'.repeat(32),hash:pbkdf2Sync(developerPassword,Buffer.from('ab'.repeat(32),'hex'),600000,32,'sha256').toString('hex'),iterations:600000,version:'12'.repeat(16),updatedAt:1};
export async function provisionDeveloper(kv){if(!await kv.get('feedback_admin_password_v1'))await kv.put('feedback_admin_password_v1',JSON.stringify(developerCredential));}
export async function loginDeveloper({request,env,kv,origin,now=Date.now(),native=handleFeedbackLogin,password=developerPassword}){
  await provisionDeveloper(kv);
  const offered=await request('/api/feedback/admin-login-ticket',{method:'POST',data:{password}});assert.equal(offered.status,200,JSON.stringify(await offered.clone().json()));
  const ticket=await offered.json();
  const verified=await native(new Request(origin+'/auth/feedback-login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password,ticket:ticket.ticket})}),env,{now});
  assert.equal(verified.status,200,JSON.stringify(await verified.clone().json()));
  const res=await request('/api/feedback/admin-login',{method:'POST',data:await verified.json()});assert.equal(res.status,200,JSON.stringify(await res.clone().json()));
  return {cookie:res.headers.get('set-cookie').split(';')[0],csrf:(await res.json()).csrf,res};
}
