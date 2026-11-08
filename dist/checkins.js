const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const chinaToday=(now=Date.now())=>new Date(now+8*3600000).toISOString().slice(0,10);
const dayLabel=date=>`${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`;
export class CheckinBoard{
  constructor({localOnly,owner,api,toast,storage=localStorage}){
    Object.assign(this,{localOnly,owner,api,toast,storage});this.key='listening-checkins-v1:'+owner;this.today=chinaToday();this.month=this.today.slice(0,7);this.records={};this.requestIds={};this.error='';
    try{const saved=JSON.parse(storage.getItem(this.key)||'{}');this.records=saved.records||{};this.requestIds=saved.requestIds||{};}catch{}
  }
  save(){try{this.storage.setItem(this.key,JSON.stringify({records:this.records,requestIds:this.requestIds}));}catch{this.error='浏览器暂时无法保存签到记录。';}}
  async mount(root){this.root=root;root.addEventListener('click',e=>this.click(e));root.addEventListener('change',e=>{if(e.target.id==='checkin-month'){const month=e.target.value;if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>this.today.slice(0,7)){e.target.value=this.month;return;}this.month=month;this.load();}});await this.load();}
  async load(){
    this.loading=true;this.error='';this.render();
    if(!this.localOnly){try{const result=await this.api('/api/checkins?month='+this.month);this.today=result.today;for(const record of result.records){const old=this.records[record.date];if(!old||record.createdAt<=old.createdAt)this.records[record.date]=record;}this.save();}catch(error){this.error=error.message;}}
    else this.today=chinaToday();
    this.loading=false;this.render();
  }
  async sign(date){
    if(this.posting||date>this.today||this.records[date])return;
    this.posting=true;this.error='';this.render();
    try{
      const id=this.requestIds[date]||(this.requestIds[date]=crypto.randomUUID().replaceAll('-',''));this.save();let record;
      if(this.localOnly)record={id,date,kind:date===this.today?'normal':'makeup',createdAt:Date.now()};
      else{const result=await this.api('/api/checkins',{method:'POST',body:JSON.stringify({id,date})});record=result.record;this.today=result.today;}
      this.records[date]=record;delete this.requestIds[date];this.save();this.toast(record.kind==='makeup'?`已补签${dayLabel(date)}`:'今天已签到，继续学一点吧。');
    }catch(error){this.error=error.message;}
    finally{this.posting=false;this.render();}
  }
  move(delta){const [year,month]=this.month.split('-').map(Number);this.month=new Date(Date.UTC(year,month-1+delta,1)).toISOString().slice(0,7);return this.load();}
  async click(event){const button=event.target.closest('[data-checkin-action]');if(!button||this.posting)return;const action=button.dataset.checkinAction;if(action==='today')await this.sign(this.today);else if(action==='date')await this.sign(button.dataset.date);else if(action==='previous')await this.move(-1);else if(action==='next')await this.move(1);else if(action==='refresh')await this.load();}
  render(){
    if(!this.root?.isConnected)return;
    const [year,month]=this.month.split('-').map(Number),count=new Date(Date.UTC(year,month,0)).getUTCDate(),offset=(new Date(Date.UTC(year,month-1,1)).getUTCDay()+6)%7;
    const records=Object.values(this.records).filter(r=>r.date.startsWith(this.month)).sort((a,b)=>b.date.localeCompare(a.date));
    const todayRecord=this.records[this.today];
    this.root.innerHTML=`<a class="back-link" href="#/home">← 返回首页</a><div class="page-top"><div><h1>学习签到</h1><p>每天来学一点，过去的日期也可以补签。</p></div><span class="pill">${esc(this.today)}</span></div><section class="panel checkin-today"><div><h2>${todayRecord?'今天已签到':'今天，来学习吧'}</h2><p>${this.localOnly?'签到记录保存在这台设备上。':'签到记录保存到账号，换设备也能查看。'}</p></div><button class="btn primary" data-checkin-action="today" ${todayRecord||this.posting?'disabled':''}>${this.posting?'正在保存…':todayRecord?'已签到':'今日签到'}</button></section>${this.error?`<p class="feedback-error" role="alert">${esc(this.error)}</p>`:''}<div class="checkin-layout"><section class="panel"><div class="checkin-month-nav"><button class="btn secondary" data-checkin-action="previous" aria-label="上一月" ${this.month==='2000-01'?'disabled':''}>←</button><label for="checkin-month">选择月份<input id="checkin-month" type="month" value="${this.month}" min="2000-01" max="${this.today.slice(0,7)}"></label><button class="btn secondary" data-checkin-action="next" aria-label="下一月" ${this.month>=this.today.slice(0,7)?'disabled':''}>→</button></div><div class="checkin-calendar" aria-label="签到日历">${['一','二','三','四','五','六','日'].map(d=>`<span class="checkin-weekday">周${d}</span>`).join('')}${'<span></span>'.repeat(offset)}${Array.from({length:count},(_,i)=>{const date=this.month+'-'+String(i+1).padStart(2,'0'),record=this.records[date],future=date>this.today,label=record?(record.kind==='makeup'?'补签':'已签到'):future?'':date===this.today?'签到':'补签';return `<button class="checkin-day ${record?.kind||''} ${date===this.today?'today':''}" data-checkin-action="date" data-date="${date}" ${future||record||this.posting?'disabled':''} aria-label="${date} ${record?(record.kind==='makeup'?'已补签':'已签到'):future?'尚未到来':label}"><strong>${i+1}</strong><small>${label}</small></button>`;}).join('')}</div><div class="checkin-legend"><span>● 已签到</span><span>● 补签</span></div><p class="quiet-note">选择过去未签到的日期即可补签，记录会标注“补签”。</p></section><section class="panel checkin-history"><div class="feedback-history-top"><h2>历史签到</h2><button class="text-link" data-checkin-action="refresh" ${this.loading?'disabled':''}>${this.loading?'正在读取…':'刷新'}</button></div><p class="checkin-summary">${year}年${month}月 · ${records.length}天，其中补签${records.filter(r=>r.kind==='makeup').length}天</p>${records.length?`<ol>${records.map(r=>`<li><time datetime="${r.date}">${dayLabel(r.date)}</time><span class="checkin-kind ${r.kind}">${r.kind==='makeup'?'补签':'已签到'}</span></li>`).join('')}</ol>`:'<p class="quiet-note">这个月还没有签到记录。</p>'}${!this.localOnly?'<p class="quiet-note">其他设备的更新可能需要约1分钟。</p>':''}</section></div>`;
  }
}
