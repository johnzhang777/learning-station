// Durable feedback uses the existing private KV binding. UI gestures never grant reply privileges.
const FB_ADMIN_AGE = 3600;
const FB_CHUNK = 192 * 1024;
const FB_MAX_FILE = 5 * 1024 * 1024;
const FB_MAX_TOTAL = 10 * 1024 * 1024;
const FB_UPLOAD_AGE = 24 * 3600 * 1000;
const FB_UUID = /^[a-f0-9]{32}$/;
const FB_THREAD = /^t\d{13}[a-f0-9]{32}$/;
const FB_REPLY = /^r\d{13}[a-f0-9]{32}$/;
const FB_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const FB_COOKIE_DOMAIN = 'learning-station:feedback-admin-session:v2\n';
const FB_CONFIG_DOMAIN = 'learning-station:feedback-password-config:v1\n';
const FB_TICKET_DOMAIN = 'learning-station:feedback-password-ticket:v1\n';
const FB_BIND_DOMAIN = 'learning-station:feedback-password-binding:v1\n';
const FB_PROOF_DOMAIN = 'learning-station:feedback-password-proof:v1\n';
const FB_CREDENTIAL_KEY = 'feedback_admin_password_v1';
const FB_ITERATIONS = 600000;
const fbHex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const fbBytes = hex => Uint8Array.from(hex.match(/../g),pair=>parseInt(pair,16));
const fbRandom = n => crypto.getRandomValues(new Uint8Array(n));
function fbCredentialShape(value) {
  return value && /^[a-f0-9]{64}$/.test(value.salt||'') && /^[a-f0-9]{64}$/.test(value.hash||'') &&
    value.iterations===FB_ITERATIONS && FB_UUID.test(value.version||'') && Number.isSafeInteger(value.updatedAt) && value.updatedAt>0;
}
async function fbCredential(kv,ctx) {
  const value=await fbGet(kv,FB_CREDENTIAL_KEY,ctx);
  if(!fbCredentialShape(value))ctx.fail('开发者密码尚未配置，请联系管理员。',503);
  return value;
}
function fbCookieName(request, ctx) { return ctx.local(request) ? 'feedback_admin' : '__Host-feedback_admin'; }
function fbCookie(request, value, ctx, age = FB_ADMIN_AGE) { return `${fbCookieName(request, ctx)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${ctx.local(request) ? '' : '; Secure'}`; }
async function fbAdmin(request, env, kv, ctx) {
  const name = fbCookieName(request, ctx);
  const token = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);
  if (!token || token.length > 1024) return null;
  const [value, signature, extra] = token.split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(signature || '') || !ctx.constantEqual(signature, await ctx.sign(FB_COOKIE_DOMAIN + value, env.SESSION_SECRET))) return null;
  let payload; try { payload = JSON.parse(atob(value)); } catch { return null; }
  if (payload.sub !== 'developer' || !FB_UUID.test(payload.nonce) || !FB_UUID.test(payload.version||'') || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(ctx.now / 1000) || payload.exp > Math.floor(ctx.now / 1000) + FB_ADMIN_AGE + 60) return null;
  const credential=await fbCredential(kv,ctx);
  if(!ctx.constantEqual(payload.version,credential.version))return null;
  return { owner: 'developer', role: 'developer', csrf: payload.nonce, expiresAt: payload.exp * 1000 };
}
async function fbIdentity(request, env, kv, ctx, guest = false) {
  const admin = await fbAdmin(request, env, kv, ctx); if (admin) return admin;
  try { const s = await ctx.session(request, env, ctx.now); return { owner: s.sub, role: 'user', csrf: s.nonce, expiresAt: s.exp * 1000 }; }
  catch (error) { if (guest && error?.status === 401) return { role: 'guest', csrf: null }; throw error; }
}
async function fbJSON(request, limit, ctx) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') ctx.fail('请求格式无效。', 415);
  const value = await ctx.body(request, limit);
  if (!value || typeof value !== 'object' || Array.isArray(value)) ctx.fail('留言格式无效。', 400);
  return value;
}
async function fbGet(kv, key, ctx) {
  const raw = await ctx.cloudOperation('FEEDBACK_READ', () => kv.get(key));
  if (!raw) return null;
  return ctx.cloudOperation('FEEDBACK_PARSE', () => JSON.parse(raw));
}
const fbPut = (kv, key, value, ctx) => ctx.cloudOperation('FEEDBACK_WRITE', () => kv.put(key, JSON.stringify(value)));
async function fbList(kv, prefix, cursor, limit, ctx) {
  if (cursor && (typeof cursor !== 'string' || cursor.length > 1024)) ctx.fail('分页位置无效。', 400);
  return ctx.cloudOperation('FEEDBACK_LIST', async () => {
    const page = await kv.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
    // Native empty lists can serialize their empty keys collection as null or
    // omit it. Keep pagination validation: an unfinished page must advance.
    const keys = page?.keys ?? [];
    if (!page || !Array.isArray(keys) || typeof page.complete !== 'boolean' || keys.some(item => !item || typeof item.key !== 'string') ||
        (!page.complete && (typeof page.cursor !== 'string' || !page.cursor || page.cursor === cursor))) throw TypeError('Invalid feedback pagination');
    return { keys, complete:page.complete, cursor:page.complete ? null : page.cursor };
  });
}
async function fbRate(kv, owner, ctx, max = 80) {
  const key = 'feedback_rate_' + (await ctx.digest(owner)).slice(0, 32);
  let rate = await fbGet(kv, key, ctx);
  if (!rate || rate.until <= ctx.now) rate = { count: 0, until: ctx.now + 3600000 };
  if (rate.count >= max) ctx.fail('发送较频繁，请稍后再试。', 429);
  rate.count++; await fbPut(kv, key, rate, ctx);
}
function fbSafeName(name, ctx) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200) ctx.fail('附件名称无效。', 400);
  const cleaned = name.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim();
  if (!cleaned) ctx.fail('附件名称无效。', 400); return cleaned;
}
function fbDecode(text, ctx) {
  if (typeof text !== 'string' || !text || text.length > Math.ceil(FB_CHUNK / 3) * 4 || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) ctx.fail('附件分片格式无效。', 400);
  let raw; try { raw = atob(text); } catch { ctx.fail('附件分片格式无效。', 400); }
  const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); return bytes;
}
function fbMagic(bytes, type) {
  const ascii = (start, n) => String.fromCharCode(...bytes.slice(start, start + n));
  if (type === 'application/pdf') return ascii(0, 5) === '%PDF-';
  if (type === 'image/png') return [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b);
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/gif') return ['GIF87a','GIF89a'].includes(ascii(0, 6));
  return type === 'image/webp' && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP';
}
function fbText(input, ctx) {
  if (typeof input.text !== 'string' || input.text.length > 5000) ctx.fail('留言最多5000字。', 400);
  if (!Array.isArray(input.attachments) || input.attachments.length > 3 || new Set(input.attachments).size !== input.attachments.length || input.attachments.some(id => !FB_UUID.test(id))) ctx.fail('每次最多添加3个附件。', 400);
  const text = input.text.trim(); if (!text && !input.attachments.length) ctx.fail('请填写文字或添加附件。', 400); return text;
}
async function fbThread(kv, id, identity, ctx) {
  if (!FB_THREAD.test(id || '')) ctx.fail('留言不存在。', 404);
  const thread = await fbGet(kv, 'feedback_thread_' + id, ctx);
  if (!thread || (identity.role !== 'developer' && thread.owner !== identity.owner)) ctx.fail('留言不存在。', 404);
  return thread;
}
function fbPublicMessage(message) {
  return { id: message.id, ...(message.threadId ? { threadId: message.threadId } : {}), text: message.text, createdAt: message.createdAt,
    role: message.role, attachments: message.attachments.map(({ id, name, type, size }) => ({ id, name, type, size })) };
}
async function fbAttachments(ids, threadId, identity, kv, ctx) {
  const metas = []; let total = 0;
  for (const id of ids) {
    const meta = await fbGet(kv, 'feedback_upload_' + id, ctx);
    if (!meta || meta.owner !== identity.owner || meta.role !== identity.role || (!meta.threadId && meta.createdAt + FB_UPLOAD_AGE < ctx.now)) ctx.fail('附件已失效，请重新选择。', 400);
    if (meta.threadId && meta.threadId !== threadId) ctx.fail('附件已用于其他留言，请重新选择。', 409);
    for (let start = 0; start < meta.chunks; start += 8) {
      const chunks = await Promise.all(Array.from({ length: Math.min(8, meta.chunks - start) }, (_, i) => fbGet(kv, `feedback_chunk_${id}_${String(start+i).padStart(3,'0')}`, ctx)));
      if (chunks.some(x => !x || typeof x.data !== 'string')) ctx.fail('附件尚未传完，请重试。', 409);
    }
    total += meta.size; metas.push(meta);
  }
  if (total > FB_MAX_TOTAL) ctx.fail('附件总大小最多10MB。', 413);
  for (const meta of metas) if (!meta.threadId) { meta.threadId = threadId; await fbPut(kv, 'feedback_upload_' + meta.id, meta, ctx); }
  return metas.map(({ id, name, type, size }) => ({ id, name, type, size }));
}
export async function handleFeedback(request, env, kv, ctx) {
  const url = new URL(request.url), route = url.pathname.replace(/\/$/, '');
  if (route === '/api/feedback/admin-password' && request.method === 'POST') {
    const input=await fbJSON(request,1024,ctx);
    if(!fbCredentialShape(input)||Math.abs(input.updatedAt-ctx.now)>120000)ctx.fail('密码配置请求无效。',400);
    const credential={salt:input.salt,hash:input.hash,iterations:input.iterations,version:input.version,updatedAt:input.updatedAt};
    const signature=request.headers.get('x-feedback-config-signature')||'';
    if(!/^[a-f0-9]{64}$/.test(signature)||!ctx.constantEqual(signature,await ctx.sign(FB_CONFIG_DOMAIN+JSON.stringify(credential),env.SESSION_SECRET)))ctx.fail('没有修改密码的权限。',403);
    const old=await fbGet(kv,FB_CREDENTIAL_KEY,ctx);
    if(old&&old.updatedAt>=credential.updatedAt){
      if(JSON.stringify(old)===JSON.stringify(credential))return ctx.json({ok:true,version:old.version});
      ctx.fail('密码配置版本已过期。',409);
    }
    await fbPut(kv,FB_CREDENTIAL_KEY,credential,ctx);return ctx.json({ok:true,version:credential.version});
  }
  if (route === '/api/feedback/admin-login-ticket' && request.method === 'POST') {
    const input = await fbJSON(request, 1024, ctx);
    const owner = 'admin-login:' + (ctx.clientIp || request.eo?.clientIp || 'account');
    await fbRate(kv, owner, ctx, 8);
    if(typeof input.password!=='string'||!input.password||input.password.length>128)ctx.fail('开发者密码不正确。',401);
    const credential=await fbCredential(kv,ctx),nonce=fbHex(fbRandom(16)),exp=Math.floor(ctx.now/1000)+60;
    const payload={...credential,nonce,exp,origin:url.origin,binding:await ctx.sign(FB_BIND_DOMAIN+input.password,env.SESSION_SECRET)};
    const encoder=new TextEncoder(),iv=fbRandom(12);
    const ticket=await ctx.cloudOperation('FEEDBACK_TICKET',async()=>{
      const key=await crypto.subtle.importKey('raw',fbBytes(await ctx.sign(FB_TICKET_DOMAIN,env.SESSION_SECRET)),{name:'AES-GCM'},false,['encrypt']);
      const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(FB_TICKET_DOMAIN),tagLength:128},key,encoder.encode(JSON.stringify(payload))));
      const bytes=new Uint8Array(iv.length+cipher.length);bytes.set(iv);bytes.set(cipher,iv.length);
      return btoa(String.fromCharCode(...bytes));
    });
    return ctx.json({ticket});
  }
  if (route === '/api/feedback/admin-login' && request.method === 'POST') {
    const input=await fbJSON(request,2048,ctx),proof=input.proof;
    if(typeof proof!=='string'||proof.length>1024)ctx.fail('开发者验证已失效，请重新输入密码。',401);
    const [encoded,signature,extra]=proof.split('.');
    if(extra||!/^[a-f0-9]{64}$/.test(signature||'')||!ctx.constantEqual(signature,await ctx.sign(FB_PROOF_DOMAIN+encoded,env.SESSION_SECRET)))ctx.fail('开发者验证已失效，请重新输入密码。',401);
    let payload;try{payload=JSON.parse(atob(encoded));}catch{ctx.fail('开发者验证已失效，请重新输入密码。',401);}
    const credential=await fbCredential(kv,ctx);
    if(payload.sub!=='developer'||!FB_UUID.test(payload.nonce||'')||payload.version!==credential.version||payload.origin!==url.origin||!Number.isSafeInteger(payload.exp)||payload.exp<=Math.floor(ctx.now/1000)||payload.exp>Math.floor(ctx.now/1000)+65)ctx.fail('开发者验证已失效，请重新输入密码。',401);
    const nonce=fbHex(fbRandom(16));
    const value = btoa(JSON.stringify({ sub:'developer', nonce, version:credential.version,exp:Math.floor(ctx.now/1000)+FB_ADMIN_AGE }));
    const token = value + '.' + await ctx.sign(FB_COOKIE_DOMAIN + value, env.SESSION_SECRET);
    return ctx.json({ role:'developer', canManage:true, canPost:true, csrf:nonce, expiresAt:(Math.floor(ctx.now/1000)+FB_ADMIN_AGE)*1000 },200,{'Set-Cookie':fbCookie(request,token,ctx)});
  }
  const identity = await fbIdentity(request, env, kv, ctx, route === '/api/feedback/session' && request.method === 'GET');
  if (route === '/api/feedback/session' && request.method === 'GET') return ctx.json({ role:identity.role, account:identity.role==='user'?identity.owner:null, canManage:identity.role==='developer', canPost:identity.role!=='guest', csrf:identity.csrf, expiresAt:identity.expiresAt });
  if (request.method === 'POST' && !ctx.constantEqual(request.headers.get('x-csrf-token') || '', identity.csrf || '')) ctx.fail('请刷新留言页后再试。',403);
  if (route === '/api/feedback/admin-logout' && request.method === 'POST') return ctx.json({ok:true},200,{'Set-Cookie':fbCookie(request,'',ctx,0)});
  if (route === '/api/feedback/uploads' && request.method === 'POST') {
    const input = await fbJSON(request, 1024, ctx), name = fbSafeName(input.name, ctx);
    if (!FB_UUID.test(input.id || '') || !FB_TYPES.has(input.type) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > FB_MAX_FILE) ctx.fail('附件仅支持PDF或常见图片，每个最多5MB。',400);
    const key = 'feedback_upload_' + input.id, existing = await fbGet(kv,key,ctx);
    if (existing) {
      if (existing.owner !== identity.owner || existing.role !== identity.role || existing.name !== name || existing.size !== input.size || existing.type !== input.type || existing.createdAt+FB_UPLOAD_AGE<ctx.now) ctx.fail('附件编号已失效，请重新选择。',409);
      return ctx.json({id:existing.id,chunkSize:FB_CHUNK,chunks:existing.chunks});
    }
    await fbRate(kv,'upload:'+identity.owner,ctx,120);
    const meta={id:input.id,name,size:input.size,type:input.type,owner:identity.owner,role:identity.role,createdAt:ctx.now,chunks:Math.ceil(input.size/FB_CHUNK)};
    await fbPut(kv,key,meta,ctx);return ctx.json({id:meta.id,chunkSize:FB_CHUNK,chunks:meta.chunks},201);
  }
  let match = /^\/api\/feedback\/uploads\/([a-f0-9]{32})\/chunks\/(\d{1,3})$/.exec(route);
  if (match && request.method === 'POST') {
    const id=match[1],index=Number(match[2]),meta=await fbGet(kv,'feedback_upload_'+id,ctx);
    if (!meta || meta.owner!==identity.owner || meta.role!==identity.role || meta.threadId || meta.createdAt+FB_UPLOAD_AGE<ctx.now) ctx.fail('附件已失效，请重新选择。',409);
    if(index>=meta.chunks)ctx.fail('附件分片编号无效。',400);
    const input=await fbJSON(request,270000,ctx), bytes=fbDecode(input.data,ctx);
    const expected=index===meta.chunks-1?meta.size-index*FB_CHUNK:FB_CHUNK;
    if(bytes.length!==expected || (index===0&&!fbMagic(bytes,meta.type)))ctx.fail('附件内容与文件类型不符。',400);
    const key=`feedback_chunk_${id}_${String(index).padStart(3,'0')}`,old=await fbGet(kv,key,ctx);
    if(old&&old.data!==input.data)ctx.fail('附件分片已变化，请重新选择。',409);
    if(!old)await fbPut(kv,key,{data:input.data},ctx);return ctx.json({ok:true,index});
  }
  if (route === '/api/feedback/threads' && request.method === 'POST') {
    const input=await fbJSON(request,24000,ctx),text=fbText(input,ctx);
    if(!FB_THREAD.test(input.id||''))ctx.fail('留言编号无效。',400);
    const key='feedback_thread_'+input.id,existing=await fbGet(kv,key,ctx);
    if(existing){if(existing.owner!==identity.owner||existing.role!==identity.role||existing.text!==text||JSON.stringify(existing.attachments.map(a=>a.id))!==JSON.stringify(input.attachments))ctx.fail('留言编号已使用，请重新发送。',409);return ctx.json({thread:fbPublicMessage(existing)});}
    await fbRate(kv,'post:'+identity.owner,ctx);
    const attachments=await fbAttachments(input.attachments,input.id,identity,kv,ctx);
    const thread={id:input.id,owner:identity.owner,role:identity.role,text,attachments,createdAt:ctx.now};
    await fbPut(kv,key,thread,ctx);return ctx.json({thread:fbPublicMessage(thread)},201);
  }
  if (route === '/api/feedback/threads' && request.method === 'GET') {
    const page=await fbList(kv,'feedback_thread_',url.searchParams.get('cursor'),20,ctx),items=[];
    for(let i=0;i<page.keys.length;i+=8){
      const docs=await Promise.all(page.keys.slice(i,i+8).map(x=>fbGet(kv,x.key,ctx)));
      for(const thread of docs){if(!thread||(identity.role!=='developer'&&thread.owner!==identity.owner))continue;
        const replies=await fbList(kv,'feedback_reply_'+thread.id+'_',null,1,ctx);
        items.push({...fbPublicMessage(thread),hasReply:replies.keys.length>0});}
    }
    items.sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));return ctx.json({threads:items,cursor:page.complete?null:page.cursor});
  }
  match=/^\/api\/feedback\/threads\/(t\d{13}[a-f0-9]{32})(?:\/(replies))?$/.exec(route);
  if(match){
    const thread=await fbThread(kv,match[1],identity,ctx);
    if(!match[2]&&request.method==='GET'){
      const page=await fbList(kv,'feedback_reply_'+thread.id+'_',url.searchParams.get('cursor'),30,ctx);
      const replies=[];for(let i=0;i<page.keys.length;i+=8)replies.push(...await Promise.all(page.keys.slice(i,i+8).map(x=>fbGet(kv,x.key,ctx))));
      return ctx.json({thread:fbPublicMessage(thread),replies:replies.filter(Boolean).map(fbPublicMessage).sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)),cursor:page.complete?null:page.cursor});
    }
    if(match[2]&&request.method==='POST'){
      const input=await fbJSON(request,24000,ctx),text=fbText(input,ctx);
      if(!FB_REPLY.test(input.id||''))ctx.fail('回复编号无效。',400);
      const key='feedback_reply_'+thread.id+'_'+input.id,existing=await fbGet(kv,key,ctx);
      if(existing){if(existing.owner!==identity.owner||existing.role!==identity.role||existing.text!==text||JSON.stringify(existing.attachments.map(a=>a.id))!==JSON.stringify(input.attachments))ctx.fail('回复编号已使用，请重新发送。',409);return ctx.json({reply:fbPublicMessage(existing)});}
      await fbRate(kv,'reply:'+identity.owner,ctx);
      const attachments=await fbAttachments(input.attachments,thread.id,identity,kv,ctx);
      const reply={id:input.id,threadId:thread.id,owner:identity.owner,role:identity.role,text,attachments,createdAt:ctx.now};
      await fbPut(kv,key,reply,ctx);return ctx.json({reply:fbPublicMessage(reply)},201);
    }
  }
  match=/^\/api\/feedback\/attachments\/([a-f0-9]{32})$/.exec(route);
  if(match&&request.method==='GET'){
    const meta=await fbGet(kv,'feedback_upload_'+match[1],ctx);
    if(!meta?.threadId)ctx.fail('附件不存在。',404);
    await fbThread(kv,meta.threadId,identity,ctx);
    const bytes=new Uint8Array(meta.size);let offset=0;
    for(let start=0;start<meta.chunks;start+=8){
      const chunks=await Promise.all(Array.from({length:Math.min(8,meta.chunks-start)},(_,i)=>fbGet(kv,`feedback_chunk_${meta.id}_${String(start+i).padStart(3,'0')}`,ctx)));
      for(const chunk of chunks){
        if(!chunk)ctx.fail('附件正在同步，请稍后重试。',503);
        const piece=fbDecode(chunk.data,ctx);if(offset+piece.length>bytes.length)throw Error('Corrupt feedback attachment');bytes.set(piece,offset);offset+=piece.length;
      }
    }
    if(offset!==meta.size||!fbMagic(bytes,meta.type))throw Error('Corrupt feedback attachment');
    const filename=encodeURIComponent(meta.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
    return new Response(bytes,{headers:{'Content-Type':meta.type,'Content-Length':String(bytes.length),'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':`${meta.type==='application/pdf'?'attachment':'inline'}; filename*=UTF-8''${filename}`}});
  }
  return ctx.json({error:'留言接口不存在。'},404);
}
