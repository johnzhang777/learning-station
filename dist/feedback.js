const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 10 * 1024 * 1024;
const TYPES = new Set(['application/pdf','image/png','image/jpeg','image/webp','image/gif']);
const id = prefix => prefix + String(9999999999999 - Date.now()).padStart(13,'0') + crypto.randomUUID().replaceAll('-','');
const time = stamp => new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(stamp));
const size = n => n < 1024*1024 ? `${Math.ceil(n/1024)} KB` : `${(n/1024/1024).toFixed(1)} MB`;
const fileType = file => file.type || ({pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[file.name.split('.').pop().toLowerCase()] || '');
export function createFeedbackGate({ interval=450, window=1800, now=()=>performance.now() }={}) {
  let count=0,first=0,last=-Infinity;
  return { tap(){const at=now();if(at-last>interval||at-first>window){count=0;first=at;}last=at;count++;if(count===5){count=0;last=-Infinity;return true;}return false;},reset(){count=0;last=-Infinity;} };
}
export class FeedbackBoard {
  constructor({toast,loginUrl}) { this.toast=toast;this.loginUrl=loginUrl;this.session=null;this.threads=[];this.drafts=new Map();this.replies=[];this.error='';this.loading=false; }
  clearIdentity() { this.threads=[];this.drafts.clear();this.threadId=null;this.thread=null;this.replies=[];this.cursor=null;this.replyCursor=null;this.threadLoading=false;this.progress=''; }
  draft() { const key=this.threadId||'new';if(!this.drafts.has(key))this.drafts.set(key,{id:id(this.threadId?'r':'t'),text:'',files:[]});return this.drafts.get(key); }
  async request(path,options={}) {
    const response=await fetch('/api/feedback'+path,{...options,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(options.method?{'Content-Type':'application/json','X-CSRF-Token':this.session?.csrf||''}:{}),...options.headers}});
    let value;try{value=await response.json();}catch{throw Error('留言服务暂时无法连接，请稍后重试。');}
    if(!response.ok)throw Object.assign(new Error(value.error||'留言暂未发送，请稍后重试。'),{status:response.status});return value;
  }
  async mount(root) {
    this.root=root;
    root.addEventListener('click',e=>this.click(e));root.addEventListener('submit',e=>this.submit(e));
    root.addEventListener('input',e=>{if(e.target.id==='feedback-text')this.draft().text=e.target.value;});
    root.addEventListener('change',e=>{if(e.target.id==='feedback-files')this.addFiles([...e.target.files]);});
    this.loading=true;this.render();
    try { const session=await this.request('/session');if(this.session?.role!==session.role||this.session?.account!==session.account)this.clearIdentity();this.session=session;if(this.session.canPost)await this.loadThreads(); }
    catch(error){this.error=error.message;}
    finally{this.loading=false;this.render();}
  }
  attachments(files) {
    return files.length?`<div class="feedback-attachments">${files.map(file=>`<a class="feedback-attachment" href="/api/feedback/attachments/${escape(file.id)}" target="_blank" rel="noopener noreferrer">${file.type.startsWith('image/')?`<img loading="lazy" src="/api/feedback/attachments/${escape(file.id)}" alt="${escape(file.name)}">`:'<span class="feedback-file-icon" aria-hidden="true">PDF</span>'}<span>${escape(file.name)}<small>${size(file.size)} · ${file.type==='application/pdf'?'下载PDF':'查看图片'}</small></span></a>`).join('')}</div>`:'';
  }
  message(message,first=false) {
    return `<article class="feedback-message ${message.role==='developer'?'developer':''}"><div class="feedback-message-meta"><strong>${message.role==='developer'?'开发者':first?'用户留言':'追加说明'}</strong><time datetime="${new Date(message.createdAt).toISOString()}">${time(message.createdAt)}</time></div>${message.text?`<p class="feedback-message-text">${escape(message.text)}</p>`:''}${this.attachments(message.attachments||[])}</article>`;
  }
  form() {
    const draft=this.draft();
    return `<form id="feedback-form" class="feedback-form"><h2>${this.threadId?(this.session.canManage?'回复这条留言':'追加说明'):'写一条留言'}</h2><label for="feedback-text">想说的话</label><textarea id="feedback-text" maxlength="5000" rows="5" placeholder="遇到的问题、希望增加的资料，或想告诉开发者的事情…" ${this.posting?'disabled':''}>${escape(draft.text)}</textarea><div class="feedback-draft-files">${draft.files.map((item,index)=>`<div class="feedback-draft-file"><span>${escape(item.file.name)}<small>${size(item.file.size)}</small></span><button type="button" data-feedback-action="remove-file" data-index="${index}" aria-label="移除 ${escape(item.file.name)}" ${this.posting?'disabled':''}>移除</button></div>`).join('')}</div><div class="feedback-form-actions"><label class="btn secondary" for="feedback-files">添加PDF / 图片</label><input id="feedback-files" type="file" multiple accept="application/pdf,image/png,image/jpeg,image/webp,image/gif,.pdf,.png,.jpg,.jpeg,.webp,.gif" hidden ${this.posting?'disabled':''}><small>最多3个附件，每个5MB，总计10MB。</small><button class="btn primary" type="submit" ${this.posting?'disabled':''}>${this.posting?'正在发送…':this.threadId?'发送回复':'发送留言'}</button></div><p class="feedback-progress" role="status" aria-live="polite">${escape(this.progress||'')}</p></form>`;
  }
  render() {
    if(!this.root?.isConnected)return;
    const canPost=this.session?.canPost,canManage=this.session?.canManage;
    const details=this.thread?`${this.message(this.thread,true)}${this.replies.map(x=>this.message(x)).join('')}${this.replyCursor?'<button class="btn secondary" data-feedback-action="more-replies">加载更多回复</button>':''}`:'';
    this.root.innerHTML=`<a class="back-link" href="#/settings">← 返回设置</a><div class="page-top"><div><h1>留言板</h1><p>${canManage?'查看用户的留言，在这里回复。':'把想法留在这里，回复也会保存在历史记录中。'}</p></div>${canManage?'<button class="btn secondary" data-feedback-action="admin-logout">退出开发者身份</button>':''}</div>${this.error?`<p class="feedback-error" role="alert">${escape(this.error)}</p>`:''}${this.loading?'<div class="loading"><span class="spinner"></span><p>正在读取留言…</p></div>':!canPost?`<section class="panel feedback-signin"><h2>登录后保存留言和附件</h2><p>登录学习账号后，可以查看这个账号的历史留言。</p><a class="btn primary" href="${escape(this.loginUrl)}">账号登录</a></section>`:`<div class="feedback-layout"><aside class="panel feedback-history"><div class="feedback-history-top"><h2>${canManage?'全部留言':'历史留言'}</h2><button class="text-link" data-feedback-action="refresh">刷新</button></div><button class="btn secondary wide" data-feedback-action="new">写留言</button><div class="feedback-thread-list">${this.threads.map(t=>`<button class="feedback-thread ${this.threadId===t.id?'selected':''}" data-feedback-action="thread" data-id="${t.id}"><strong>${escape(t.text.slice(0,65)||'附件留言')}</strong><small>${time(t.createdAt)}${t.hasReply?' · 有回复':''}${t.attachments.length?' · '+t.attachments.length+'个附件':''}</small></button>`).join('')||'<p class="quiet-note">还没有留言，写下第一条吧。</p>'}</div>${this.cursor?'<button class="text-link" data-feedback-action="more">加载更早的留言</button>':''}<p class="feedback-sync-note">刚发送的内容会先显示在这里，其他设备的更新可能需要约1分钟。</p></aside><section class="feedback-conversation">${this.threadLoading?'<div class="panel">正在读取这条留言…</div>':details}${!this.threadLoading&&(!this.threadId||this.thread)?this.form():''}</section></div>`}${!canManage?`<details class="panel feedback-admin"><summary>开发者回复</summary><form id="feedback-admin-form"><label for="feedback-admin-code">开发者管理码</label><input id="feedback-admin-code" type="password" autocomplete="off" maxlength="64" required placeholder="请输入管理码"><button class="btn secondary" type="submit">验证身份</button></form></details>`:''}`;
  }
  async loadThreads(append=false) {
    const result=await this.request('/threads'+(append&&this.cursor?'?cursor='+encodeURIComponent(this.cursor):''));
    const merged=new Map((append?this.threads:this.threads.filter(t=>t.justSent)).map(t=>[t.id,t]));for(const t of result.threads)merged.set(t.id,t);
    this.threads=[...merged.values()].sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));this.cursor=result.cursor;
  }
  async openThread(threadId,append=false) {
    if(this.threadId!==threadId){this.thread=null;this.replies=[];this.replyCursor=null;}
    this.threadId=threadId;this.threadLoading=true;this.error='';this.render();
    try {
      const result=await this.request('/threads/'+threadId+(append&&this.replyCursor?'?cursor='+encodeURIComponent(this.replyCursor):''));
      if(this.threadId!==threadId)return;
      this.thread=result.thread;const merged=new Map((append?this.replies:this.replies.filter(r=>r.justSent)).map(x=>[x.id,x]));for(const r of result.replies)merged.set(r.id,r);
      this.replies=[...merged.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));this.replyCursor=result.cursor;
    }catch(error){this.error=error.message;}
    finally{if(this.threadId===threadId){this.threadLoading=false;this.render();}}
  }
  addFiles(files) {
    const draft=this.draft();this.error='';
    for(const file of files){
      const type=fileType(file);
      if(!TYPES.has(type)){this.error='请添加PDF、JPG、PNG、WebP或GIF文件。';break;}
      if(file.size<1||file.size>MAX_FILE){this.error='每个附件最多5MB，请选择较小的文件。';break;}
      if(draft.files.length>=3||draft.files.reduce((n,x)=>n+x.file.size,0)+file.size>MAX_TOTAL){this.error='最多3个附件，总计不超过10MB。';break;}
      draft.files.push({file,type,id:crypto.randomUUID().replaceAll('-',''),uploaded:false});
    }
    this.render();
  }
  async upload(item) {
    if(item.uploaded)return item.id;
    const meta=await this.request('/uploads',{method:'POST',body:JSON.stringify({id:item.id,name:item.file.name,type:item.type,size:item.file.size})});
    for(let index=0;index<meta.chunks;index++){
      const bytes=new Uint8Array(await item.file.slice(index*meta.chunkSize,(index+1)*meta.chunkSize).arrayBuffer());let binary='';
      for(let start=0;start<bytes.length;start+=8192)binary+=String.fromCharCode(...bytes.subarray(start,start+8192));
      this.progress=`正在上传 ${item.file.name} · ${index+1}/${meta.chunks}`;this.render();
      await this.request('/uploads/'+item.id+'/chunks/'+index,{method:'POST',body:JSON.stringify({data:btoa(binary)})});
    }
    item.uploaded=true;return item.id;
  }
  async send() {
    if(this.posting||this.threadLoading||(this.threadId&&!this.thread))return;const draft=this.draft();this.error='';
    if(!draft.text.trim()&&!draft.files.length){this.error='请填写文字或添加附件。';this.render();return;}
    if(!navigator.onLine){this.error='当前没有网络，文字和附件仍留在此页。';this.render();return;}
    this.posting=true;this.progress='正在保存留言…';this.render();
    try {
      const attachments=[];for(const item of draft.files)attachments.push(await this.upload(item));
      const result=await this.request(this.threadId?'/threads/'+this.threadId+'/replies':'/threads',{method:'POST',body:JSON.stringify({id:draft.id,text:draft.text,attachments})});
      if(result.thread){this.threadId=result.thread.id;this.thread=result.thread;this.replies=[];this.replyCursor=null;this.threads=[{...result.thread,justSent:true,hasReply:false},...this.threads.filter(t=>t.id!==result.thread.id)];this.drafts.delete('new');}
      else{this.replies=[...this.replies.filter(r=>r.id!==result.reply.id),{...result.reply,justSent:true}].sort((a,b)=>a.createdAt-b.createdAt);this.drafts.delete(this.threadId);const t=this.threads.find(t=>t.id===this.threadId);if(t)t.hasReply=true;}
      this.progress='已保存到云端。';this.toast('留言已发送。');
    }catch(error){this.error=error.message;this.progress='内容仍保留，可以稍后重试。';}
    finally{this.posting=false;this.render();}
  }
  async submit(event) {
    if(event.target.id==='feedback-form'){event.preventDefault();await this.send();}
    else if(event.target.id==='feedback-admin-form'){
      event.preventDefault();const input=this.root.querySelector('#feedback-admin-code'),code=input.value.trim();input.value='';this.error='';
      try{this.session=await this.request('/admin-login',{method:'POST',body:JSON.stringify({code})});this.clearIdentity();await this.loadThreads();}
      catch(error){this.error=error.message;}this.render();
    }
  }
  async click(event) {
    const button=event.target.closest('[data-feedback-action]');if(!button||this.posting)return;
    const action=button.dataset.feedbackAction;this.error='';
    try{
      if(action==='thread')await this.openThread(button.dataset.id);
      else if(action==='new'){this.threadId=null;this.thread=null;this.replies=[];this.replyCursor=null;this.render();}
      else if(action==='remove-file'){this.draft().files.splice(Number(button.dataset.index),1);this.render();}
      else if(action==='refresh'){await this.loadThreads();if(this.threadId)await this.openThread(this.threadId);this.render();}
      else if(action==='more'){await this.loadThreads(true);this.render();}
      else if(action==='more-replies')await this.openThread(this.threadId,true);
      else if(action==='admin-logout'){await this.request('/admin-logout',{method:'POST',body:'{}'});this.session=await this.request('/session');this.clearIdentity();if(this.session.canPost)await this.loadThreads();this.render();}
    }catch(error){this.error=error.message;this.render();}
  }
}
