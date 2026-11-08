// Credentials stay in request memory. Only the signed server session is retained.
export async function signInDeveloper(password,request,fetchNative=fetch){
  const offered=await request('/admin-login-ticket',{method:'POST',body:JSON.stringify({password})});
  const response=await fetchNative('/auth/feedback-login',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({password,ticket:offered.ticket})});
  let verified;try{verified=await response.json();}catch{throw Error('开发者验证服务暂时无法连接，请稍后重试。');}
  if(!response.ok)throw Error(verified.error||'开发者密码不正确，请重试。');
  return request('/admin-login',{method:'POST',body:JSON.stringify({proof:verified.proof})});
}
