import {createHmac,createDecipheriv,pbkdf2,timingSafeEqual} from 'node:crypto';
const ticketDomain='learning-station:feedback-password-ticket:v1\n';
const bindDomain='learning-station:feedback-password-binding:v1\n';
const proofDomain='learning-station:feedback-password-proof:v1\n';
const uuid=/^[a-f0-9]{32}$/,hex64=/^[a-f0-9]{64}$/;
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store',Vary:'Origin','X-Content-Type-Options':'nosniff'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
const invalid=()=>{throw Object.assign(new Error(),{publicStatus:401});};
const sign=(text,secret)=>createHmac('sha256',Buffer.from(secret,'hex')).update(text,'utf8').digest();
const equal=(a,b)=>a.byteLength===b.byteLength&&timingSafeEqual(a,b);
export async function handleFeedbackLogin(request,env,{now=Date.now(),derive=pbkdf2}={}){
  try{
    if(request.method!=='POST')return json({error:'接口不存在。'},404);
    if(!hex64.test(env?.SESSION_SECRET||''))return json({error:'开发者验证服务尚未配置。',code:'FEEDBACK_NODE_CONFIG'},503);
    const origin=request.headers.get('origin');
    if(!origin||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'请求来源无效。'},403);
    if((request.headers.get('content-type')||'').split(';')[0].trim()!=='application/json'||Number(request.headers.get('content-length'))>2048)return json({error:'请求格式无效。'},400);
    let input;try{input=await request.json();}catch{invalid();}
    if(!input||typeof input.password!=='string'||!input.password||input.password.length>128||typeof input.ticket!=='string'||input.ticket.length>1600||Buffer.byteLength(JSON.stringify(input))>2048)invalid();
    const bytes=Buffer.from(input.ticket,'base64');
    if(bytes.toString('base64')!==input.ticket||bytes.length<29)invalid();
    let payload;
    try{
      const decipher=createDecipheriv('aes-256-gcm',sign(ticketDomain,env.SESSION_SECRET),bytes.subarray(0,12),{authTagLength:16});
      decipher.setAAD(Buffer.from(ticketDomain));decipher.setAuthTag(bytes.subarray(-16));
      payload=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8'));
    }catch{invalid();}
    if(!hex64.test(payload.salt||'')||!hex64.test(payload.hash||'')||payload.iterations!==600000||!uuid.test(payload.version||'')||!uuid.test(payload.nonce||'')||!hex64.test(payload.binding||'')||!Number.isSafeInteger(payload.exp)||payload.exp<=Math.floor(now/1000)||payload.exp>Math.floor(now/1000)+65||payload.origin!==origin)invalid();
    let url;try{url=new URL(payload.origin);}catch{invalid();}
    const local=url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.origin!==payload.origin||(!local&&url.protocol!=='https:'))invalid();
    if(!equal(sign(bindDomain+input.password,env.SESSION_SECRET),Buffer.from(payload.binding,'hex')))invalid();
    const derived=await new Promise((resolve,reject)=>derive(input.password,Buffer.from(payload.salt,'hex'),payload.iterations,32,'sha256',(error,value)=>error?reject(error):resolve(value)));
    if(!Buffer.isBuffer(derived)||derived.length!==32)throw Error();
    const valid=equal(derived,Buffer.from(payload.hash,'hex'));derived.fill(0);if(!valid)invalid();
    const encoded=Buffer.from(JSON.stringify({sub:'developer',nonce:payload.nonce,version:payload.version,exp:payload.exp,origin:payload.origin})).toString('base64');
    return json({proof:encoded+'.'+sign(proofDomain+encoded,env.SESSION_SECRET).toString('hex')});
  }catch(error){
    if(error?.publicStatus)return json({error:'开发者密码不正确或验证已过期，请重试。'},401);
    console.error(JSON.stringify({event:'feedback_password_failure',code:'FEEDBACK_NODE_VERIFY'}));
    return json({error:'开发者验证暂时无法连接，请稍后重试。',code:'FEEDBACK_NODE_VERIFY'},503);
  }
}
