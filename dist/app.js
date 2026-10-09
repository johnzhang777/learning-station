import { ProgressSync } from './progress-sync.js';
// Normal URLs use account login; ?local=1 keeps public listening available.
const LOCAL_MODE = new URL(location.href).searchParams.get('local') === '1';
function learningModeUrl(local = false) {
  const url = new URL(location.href);
  url.searchParams.delete('login'); url.searchParams.delete('local');
  if (local) url.searchParams.set('local', '1');
  return url.href;
}
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  play:'<path d="m9 5 10 7-10 7z"/>', pause:'<path d="M8 5v14M16 5v14"/>',
  speaker:'<path d="M4 9h4l5-4v14l-5-4H4zM17 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>', left:'<path d="m14 5-7 7 7 7"/>',
  down:'<path d="m6 9 6 6 6-6"/>', search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  check:'<path d="m5 12 4 4 10-10"/>', star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>',
  repeat:'<path d="M20 8a8 8 0 0 0-14-2L3 9m0-6v6h6M4 16a8 8 0 0 0 14 2l3-3m0 6v-6h-6"/>',
  book:'<path d="M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15M6 8h3M6 12h3M15 8h3M15 12h3"/>',
  chat:'<path d="M4 4h16v12H9l-5 4zM8 8h8M8 12h5"/>', calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18M7 14h2M13 14h2M7 17h2"/>',
  headphones:'<path d="M4 13v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="12" width="5" height="9" rx="2"/><rect x="17" y="12" width="5" height="9" rx="2"/>'
};
const I = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.play}</svg>`;
const STORAGE = 'little-listening-station-v1';
const defaults = {accent:'uk',rate:1,gap:3,lastDay:1,lastIndex:0,status:{}};
let state;
try { state = {...defaults, ...JSON.parse(localStorage.getItem(STORAGE) || '{}')}; } catch { state = {...defaults}; }
if(!['uk','us'].includes(state.accent)) state.accent = 'uk';
state.rate = normalizePlaybackRate(state.rate);
if(![2,3,5,8].includes(Number(state.gap))) state.gap = 3;
if(!state.status || typeof state.status !== 'object' || Array.isArray(state.status)) state.status = {};
let data, audioMap, entries, days, wordBack = '#/english', currentView = {};
let reviewType = 'week', reviewWeek = 1, reviewMonth = 0, hideEnglish = false, revealed = new Set();
let toastTimer;
let account = null, recordSync = null, syncMessage = '正在读取云端记录…';
let authGeneration = 0;
function saveDeviceState(){
  try{localStorage.setItem(STORAGE,JSON.stringify(state));}catch{toast(LOCAL_MODE?'浏览器无法保存记录，请在设置中导出备份。':'浏览器无法保存本机记录，请等待云端同步完成。');}
}
function persist(){
  saveDeviceState();
  if(recordSync && (LOCAL_MODE || account)){
    const known=new Set([...Object.keys(recordSync.fields).filter(id=>id!=='position'),...Object.keys(state.status)]);
    for(const id of known)recordSync.change(id,state.status[id]||null);
    recordSync.change('position',{lastDay:state.lastDay,lastIndex:state.lastIndex});
  }
}
function toast(text){const el=$('#toast');el.textContent=text;el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,3200);}
function dateLabel(date){return `${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`;}
function shortDate(date){return `${Number(date.slice(5,7))}/${Number(date.slice(8,10))}`;}
const accentName = a => a === 'uk' ? '英式' : '美式';
const weekdayName = n => ['周一','周二','周三','周四','周五','周六','周日'][n];
function safeDay(){const d=days.get(Number(state.lastDay));return d?.kind==='learn'?d:days.get(1);}
function routeTo(hash){if(location.hash===hash)renderRoute();else location.hash=hash;}
function moduleNav(active){return `<nav class="module-nav" aria-label="英语资料导航"><a class="${active==='catalog'?'active':''}" href="#/english">周次 / 日期</a><a class="${active==='review'?'active':''}" href="#/review">周月复习</a><a class="${active==='practice'?'active':''}" href="#/practice">再练词 <span>${Object.values(state.status).filter(s=>s==='practice').length || ''}</span></a></nav>`;}
function backLink(text,hash){return `<a class="back-link" href="${esc(hash)}">${I('left')}${esc(text)}</a>`;}
function pageTop(title,description,badge=''){return `<div class="page-top"><div><h1>${esc(title)}</h1>${description?`<p>${esc(description)}</p>`:''}</div>${badge?`<span class="pill">${esc(badge)}</span>`:''}</div>`;}
function lessonHash(d,index=0){return `#/day/${d.id}/${index}`;}

function normalizePlaybackRate(value){
  const rate = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(rate) && rate >= .5 && rate <= 1.5 ? Math.round(rate * 20) / 20 : 1;
}
const playbackRateText = (rate = state.rate) => `${rate.toFixed(2)} 倍`;
function playbackSpeedControl(id){
  return `<div class="playback-speed" role="group" aria-label="播放速度"><div class="playback-speed-heading"><label for="${id}">播放速度</label><output for="${id}" data-rate-value aria-live="off">${playbackRateText()}</output></div><input id="${id}" data-rate-slider type="range" min="0.5" max="1.5" step="0.05" value="${state.rate}" aria-valuetext="${playbackRateText()}" aria-describedby="${id}-hint"><div class="speed-limits" aria-hidden="true"><span>0.5 倍 · 慢</span><span>1.5 倍 · 快</span></div><div class="speed-presets" role="group" aria-label="常用倍速">${[.6,.8,1].map(rate=>`<button type="button" data-action="rate" data-rate="${rate}" class="${state.rate===rate?'selected':''}" aria-pressed="${state.rate===rate}">${rate.toFixed(1)} 倍</button>`).join('')}</div><small id="${id}-hint">向左慢一点，向右快一点。会记住这台设备的选择。</small></div>`;
}
function setPlaybackRate(value){
  state.rate = normalizePlaybackRate(value);
  if(player){player.audio.playbackRate=state.rate;player.audio.preservesPitch=true;player.updateDock();}
  // Speed is a device preference. Update controls in place so dragging keeps
  // focus, the current audio position, expanded examples and the playback queue.
  $$('[data-rate-slider]').forEach(el=>{el.value=String(state.rate);el.setAttribute('aria-valuetext',playbackRateText());});
  $$('[data-rate-value]').forEach(el=>el.textContent=playbackRateText());
  $$('[data-action="rate"]').forEach(button=>{const active=Number(button.dataset.rate)===state.rate;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  saveDeviceState();
}

class ClipPlayer {
  constructor(){
    this.audio=$('#lesson-audio');this.audio.preload='metadata';this.phase='idle';this.token=0;this.queue=[];this.index=0;this.frame=0;
    this.audio.addEventListener('loadedmetadata',()=>{if(this.current&&this.phase==='loading'){this.audio.currentTime=this.current.clip.start;}});
    this.audio.addEventListener('playing',()=>{if(this.phase==='paused'){this.audio.pause();return;}if(this.current){this.phase='playing';this.updateDock();this.tick();}});
    this.audio.addEventListener('waiting',()=>{if(this.current&&this.phase!=='paused'){this.phase='loading';this.updateDock();}});
    this.audio.addEventListener('timeupdate',()=>this.checkEnd());
    this.audio.addEventListener('ended',()=>{if(this.current&&['playing','loading'].includes(this.phase))this.complete();});
    this.audio.addEventListener('error',()=>{if(this.current)this.fail();});
  }
  run(items,title){
    this.stop();this.queue=items.filter(i=>entries.has(i.entry));this.title=title;
    if(!this.queue.length)return;
    this.index=0;this.startCurrent();
  }
  startCurrent(){
    clearTimeout(this.timer);cancelAnimationFrame(this.frame);
    const item=this.queue[this.index],clip=audioMap.entries[item.entry]?.[state.accent]?.[item.part];
    if(!clip){this.current={...item,clip:null};this.fail();return;}
    this.current={...item,clip};this.phase='loading';const token=++this.token;
    syncLessonToItem(item);this.highlight();this.updateDock();
    const src=new URL(clip.src,location.href.split('#')[0]).href;
    if(this.audio.src!==src)this.audio.src=src;
    this.audio.playbackRate=Number(state.rate);this.audio.preservesPitch=true;
    try{this.audio.currentTime=clip.start;}catch{}
    // play() is initiated in the tap handler. The same element is reused for the queue.
    this.audio.play().then(()=>{
      if(token!==this.token)return;
      if(this.phase==='paused'){this.audio.pause();return;}
      if(this.audio.currentTime<clip.start-.08)this.audio.currentTime=clip.start;
      this.phase='playing';this.updateDock();this.tick();
    }).catch(()=>{if(token===this.token)this.fail();});
  }
  checkEnd(){if(this.phase==='playing'&&this.current?.clip&&this.audio.currentTime>=this.current.clip.end-.02)this.complete();}
  tick(){cancelAnimationFrame(this.frame);if(this.phase!=='playing')return;this.checkEnd();if(this.phase==='playing'){this.updateProgress();this.frame=requestAnimationFrame(()=>this.tick());}}
  complete(){
    if(!this.current||!['playing','loading'].includes(this.phase))return;
    this.audio.pause();cancelAnimationFrame(this.frame);
    if(this.index+1>=this.queue.length){this.phase='finished';this.clearHighlights();this.updateDock();this.timer=setTimeout(()=>this.stop(),2300);return;}
    this.phase='gap';this.gapLeft=Number(state.gap)*1000;this.gapDeadline=performance.now()+this.gapLeft;
    this.updateDock();this.scheduleGap();
  }
  scheduleGap(){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(this.phase==='gap'){this.index++;this.startCurrent();}},this.gapLeft);}
  toggle(){
    if(this.phase==='error'){this.startCurrent();return;}
    if(this.phase==='finished'){this.run(this.queue,this.title);return;}
    if(this.phase==='paused'){
      if(this.pausedFrom==='gap'){this.phase='gap';this.gapDeadline=performance.now()+this.gapLeft;this.scheduleGap();this.updateDock();}
      else{this.phase='loading';const token=this.token;this.updateDock();this.audio.play().then(()=>{if(token===this.token){if(this.phase==='paused'){this.audio.pause();return;}this.phase='playing';this.updateDock();this.tick();}}).catch(()=>{if(token===this.token)this.fail();});}
    }else if(['playing','loading','gap'].includes(this.phase)){
      this.pausedFrom=this.phase;this.audio.pause();cancelAnimationFrame(this.frame);clearTimeout(this.timer);
      if(this.phase==='gap')this.gapLeft=Math.max(0,this.gapDeadline-performance.now());
      this.phase='paused';this.updateDock();
    }
  }
  fail(){this.audio.pause();cancelAnimationFrame(this.frame);clearTimeout(this.timer);this.phase='error';this.updateDock();toast(navigator.onLine?'音频没加载好，点播放器的重试按钮再听。':'现在没有网络，连接后再点重试。');}
  stop(){this.token++;clearTimeout(this.timer);cancelAnimationFrame(this.frame);this.audio.pause();this.phase='idle';this.current=null;this.queue=[];this.clearHighlights();$('#player-dock').hidden=true;document.body.classList.remove('has-player');}
  clearHighlights(){$$('.is-playing').forEach(el=>el.classList.remove('is-playing'));}
  highlight(){
    this.clearHighlights();if(!this.current)return;
    const {entry,part}=this.current;
    $$(`[data-sound-entry="${entry}"][data-sound-part="${part}"],.review-card[data-entry="${entry}"]`).forEach(el=>el.classList.add('is-playing'));
    if(part==='ex2')$('#example-two')?.setAttribute('open','');
  }
  updateProgress(){if(!this.current?.clip)return;const c=this.current.clip,p=Math.min(100,Math.max(0,(this.audio.currentTime-c.start)/(c.end-c.start)*100));$('#player-progress').style.width=p+'%';}
  updateDock(){
    if(!this.current)return;
    const dock=$('#player-dock'),e=entries.get(this.current.entry),part=this.current.part;
    dock.hidden=false;document.body.classList.add('has-player');dock.className='player-dock '+this.phase;
    $('#player-title').textContent=part==='word'?e.word:e.examples[part==='ex1'?0:1].en;
    let label=`${accentName(state.accent)} · ${part==='word'?'单词':part==='ex1'?'例句①':'例句②'} · ${playbackRateText()}`;
    if(this.phase==='loading')label+=' · 正在加载';
    if(this.phase==='paused')label+=' · 已暂停';
    if(this.phase==='gap')label=`轮到你读啦 · ${state.gap}秒后继续`;
    if(this.phase==='finished')label='听完啦，再读一遍给自己听。';
    if(this.phase==='error')label=navigator.onLine?'点右边重试':'连接网络后点重试';
    if(this.queue.length>1&&!['finished','gap','error'].includes(this.phase))label+=` · ${this.index+1}/${this.queue.length}`;
    $('#player-status').textContent=label;
    const togg=$('#player-toggle');togg.innerHTML=I(['paused','error','finished'].includes(this.phase)?'play':'pause');
    togg.setAttribute('aria-label',this.phase==='error'?'重试音频':this.phase==='paused'?'继续播放':this.phase==='finished'?'再听一次':'暂停播放');
    if(this.phase==='loading')$('#player-progress').style.width='0%';
    if(['gap','finished'].includes(this.phase))$('#player-progress').style.width='100%';
  }
}
let player;

function home(){
  const d=safeDay(),w=data.weeks[d.week-1],learned=Object.values(state.status).filter(s=>s==='learned').length;
  currentView={type:'home'};
  return `<section class="hero"><div class="hero-copy"><div class="eyebrow">每天五个词 · 英语听读手册</div><h1>听一听，<br><em>就会读。</em></h1><p>单词不会读？点一下就能听。<br>拿着你的手册，跟着声音慢慢来。</p><div class="hero-actions"><a class="btn primary" href="${lessonHash(d,Number(state.lastIndex)||0)}">${I('play')}继续学习</a><a class="btn ghost" href="#/english">选择日期${I('arrow')}</a></div><div class="hero-note">上次的位置：第${d.week}周 · Day ${d.id} · ${dateLabel(d.date)}</div></div><div class="hero-art" aria-hidden="true"><div class="art-circle"><svg viewBox="0 0 160 160"><path d="M39 73V62a41 41 0 0 1 82 0v11" stroke="#23695d" stroke-width="9"/><rect x="27" y="69" width="27" height="47" rx="12" fill="#23695d" stroke="#23695d"/><rect x="106" y="69" width="27" height="47" rx="12" fill="#23695d" stroke="#23695d"/><path d="M56 79q24-8 24 3 0-11 24-3v45q-24-8-24 3 0-11-24-3z" fill="#fffefb" stroke="#23695d"/><path d="M80 83v43M62 91l12 2M86 94l12-3M62 102l12 2M86 105l12-3" stroke="#23695d"/><path d="m124 25 3 9 9 3-9 3-3 9-3-9-9-3 9-3z" fill="#fffefb" stroke="#fffefb"/></svg></div><div class="art-float one"><div class="mini-wave"><i></i><i></i><i></i><i></i></div><span>英式 / 美式<br><small>两种声音都能听</small></span></div><div class="art-float two"><span><b>Hello!</b><small>每次进步一点点</small></span>🌿</div></div></section><div class="section-heading"><div><h2>从这里开始</h2><small>按自己的进度，一次学五个。</small></div><a class="text-link" href="#/library">全部资料${I('arrow')}</a></div><div class="home-grid"><section class="panel lesson-preview"><div class="meta"><span class="pill">${esc(w.icon)} 第${d.week}周</span><span>Day ${d.id} · ${shortDate(d.date)}</span></div><h3>${esc(w.theme)}</h3><div class="words-preview">${d.entryIds.map((id,i)=>`<a class="word-chip" href="${lessonHash(d,i)}">${esc(entries.get(id).word)}</a>`).join('')}</div><div class="note">${I('headphones')}听单词，也听两句不同场景的例句。</div></section><section class="panel quick-links"><a class="quick-link" href="#/english"><span class="quick-icon">📅</span><span>按日期找<small>与纸质手册对照</small></span>${I('arrow')}</a><a class="quick-link" href="#/review"><span class="quick-icon">🔁</span><span>周月复习<small>把学过的再听一遍</small></span>${I('arrow')}</a><a class="quick-link" href="#/practice"><span class="quick-icon">🌱</span><span>再练词<small>${Object.values(state.status).filter(s=>s==='practice').length}个词，慢慢练</small></span>${I('arrow')}</a></section></div><div class="gentle-strip"><span class="strip-icon">✏️</span><div><strong>${learned?`你已经给 ${learned} 个词标了“会读了”。`:'纸上写一写，网页听一听。'}</strong><p>忘了很正常，想听几遍就听几遍。</p></div></div>`;
}
function library(){currentView={type:'library'};return `${pageTop('我的学习资料','选一份资料，开始今天的小练习。')}<article class="collection-card"><div class="collection-cover"><svg viewBox="0 0 24 24" aria-hidden="true">${icons.headphones}</svg><div><small>ENGLISH · LISTEN & LEARN</small><strong>每天<br>五个词</strong></div></div><div class="collection-copy"><span class="pill">英语听读 · 英美双口音</span><h2 style="margin-top:15px">四年级英语陪伴手册</h2><p>与已经打印的手册配套。听单词、听例句，按周次和日期找到正在学习的内容。</p><div class="collection-stats"><span><b>21</b> 周主题</span><span><b>525</b> 个词条</span><span><b>1050</b> 句例句</span></div><a class="btn primary" href="#/english">打开手册${I('arrow')}</a></div></article><p class="quiet-note">2026年9月7日—2027年1月31日<br>以后新增的学习资料，也会出现在这里。</p>`;}
function weekCard(w){return `<details class="week-card" ${w.number===safeDay().week?'open':''}><summary><span class="week-label">${esc(w.icon)} 第 ${w.number} 周</span><h3>${esc(w.theme)}</h3><span class="week-date">${dateLabel(w.startDate)}开始 · 25个词</span>${I('down')}</summary><div class="week-days">${w.dayIds.map(id=>{const d=days.get(id);return `<a class="day-button ${d.kind}" href="${lessonHash(d)}">${weekdayName(d.weekday)} · ${shortDate(d.date)}<span>Day ${d.id} · ${d.kind==='learn'?'5个词':d.kind==='review'?'复习25词':'休息'}</span></a>`;}).join('')}</div></details>`;}
function catalog(){currentView={type:'catalog'};return `${backLink('学习资料','#/library')}${pageTop('每天五个词','找纸上的 Day，或者直接搜单词。','21周 · 英美双口音')}${moduleNav('catalog')}<div class="catalog-toolbar"><label class="search-box">${I('search')}<input id="word-search" type="search" placeholder="搜英文单词或中文意思，如 library / 图书馆" autocomplete="off" aria-label="搜索英文单词或中文意思"></label><form id="day-jump" class="day-jump"><label for="jump-number">跳到 Day</label><input id="jump-number" type="number" inputmode="numeric" min="1" max="147" placeholder="32" required><button type="submit" class="btn secondary">前往${I('arrow')}</button></form></div><section id="catalog-content"><div class="week-grid">${data.weeks.map(weekCard).join('')}</div></section>`;}
function searchResults(query){
  const q=query.trim().toLowerCase();if(!q){$('#catalog-content').innerHTML=`<div class="week-grid">${data.weeks.map(weekCard).join('')}</div>`;return;}
  const matches=data.entries.filter(e=>e.word.toLowerCase().includes(q)||e.meaning.includes(q));
  $('#catalog-content').innerHTML=`<p class="search-results-count">找到 ${matches.length} 个词条</p>${matches.length?`<div class="search-results">${matches.map(e=>`<button class="search-result" data-action="open-word" data-entry="${e.id}"><strong>${esc(e.word)}</strong><span class="result-zh">${esc(e.meaning)}</span><small>第${e.week}周 · Day ${e.day} · ${dateLabel(e.date)}</small></button>`).join('')}</div>`:`<div class="empty"><span class="empty-icon">🔎</span><h2>这本手册里暂时没找到</h2><p>试试英文的一部分，或者换一个中文意思。</p></div>`}`;
}
const posName = p => ({'n.':'名词','v.':'动词','adj.':'形容词','adv.':'副词','pron.':'代词','det.':'限定词','num.':'数词','prep.':'介词','conj.':'连词'}[p] || p);
function exampleHtml(e,index){const x=e.examples[index],part=`ex${index+1}`;return `<section class="example"><div class="example-head"><span class="example-tag">例句 ${index?'② · 换个场景':'① · 先练这一句'}</span><button class="play-small" data-action="play" data-entry="${e.id}" data-part="${part}" aria-label="用${accentName(state.accent)}朗读例句${index+1}">${I('speaker')}听${accentName(state.accent)}</button></div><p class="example-en soundtarget" data-sound-entry="${e.id}" data-sound-part="${part}">${esc(x.en)}</p><p class="example-zh">${esc(x.zh)}</p><p class="example-scene">${I('chat')}${esc(x.scene)}</p></section>`;}
function lesson(d,index,back){
  if(d.kind==='review'){reviewType='week';reviewWeek=d.week;return review();}
  if(d.kind==='rest'){currentView={type:'rest'};return `${backLink('周次 / 日期','#/english')}${pageTop(`Day ${d.id} · 周日休息`,`${d.date.slice(0,4)}年${dateLabel(d.date)} · 第${d.week}周`)}<section class="empty"><span class="rest-art">🌿</span><h2>今天，去玩一会儿吧。</h2><p>休息也是计划的一部分。想听学过的词，随时回来。</p><a href="#/practice" class="btn secondary">看看再练词${I('arrow')}</a></section>`;}
  index=Math.max(0,Math.min(d.entryIds.length-1,Number(index)||0));
  const e=entries.get(d.entryIds[index]),w=data.weeks[d.week-1];
  currentView={type:'lesson',day:d.id,index,entry:e.id};state.lastDay=d.id;state.lastIndex=index;persist();
  return `${backLink(back?'返回刚才的列表':'周次 / 日期',back||'#/english')}${pageTop(w.theme,`第${d.week}周 · Day ${d.id} · ${d.date.slice(0,4)}年${dateLabel(d.date)} ${weekdayName(d.weekday)}`)}<div class="lesson-layout"><aside class="lesson-side"><p>这一天的五个词</p><nav class="word-tabs" aria-label="这一天的单词">${d.entryIds.map((id,n)=>{const word=entries.get(id);return `<a class="word-tab ${n===index?'selected':''}" href="${lessonHash(d,n)}" ${n===index?'aria-current="page"':''}><span class="tab-number">${n+1}</span><span class="tab-word">${esc(word.word)}</span>${state.status[id]==='learned'?`<small>${I('check')}</small>`:''}</a>`;}).join('')}</nav><p class="day-note">先听一遍，再跟着读。<br>例句①学会了，再试例句②。<br>不用一下子背完。</p><button class="btn secondary wide" style="margin-top:17px;font-size:12px" data-action="day-audio" data-day="${d.id}">${I('headphones')}听这天的5个词</button><button class="btn secondary wide" style="margin-top:9px;font-size:12px" data-action="day-full" data-day="${d.id}">${I("play")}连听词和例句</button></aside><div class="lesson-main"><div class="lesson-meta"><span>看单词，听声音，再跟读。</span><span class="lesson-counter">第 ${index+1} / 5 个</span></div><article class="word-card"><div class="word-title-row"><div><h2 class="word-heading">${esc(e.word)}</h2><p class="word-meaning"><span class="pos">${esc(posName(e.pos))}</span>${esc(e.meaning)}</p></div><button class="star-button ${state.status[e.id]==='practice'?'selected':''}" data-action="status" data-entry="${e.id}" data-status="practice" aria-pressed="${state.status[e.id]==='practice'}" aria-label="${state.status[e.id]==='practice'?'移出再练词':'加入再练词'}">${I('star')}</button></div><div class="pronunciation-grid soundtarget" data-sound-entry="${e.id}" data-sound-part="word">${['uk','us'].map(a=>`<button class="pronunciation ${state.accent===a?'active':''}" data-action="play" data-entry="${e.id}" data-part="word" data-accent="${a}" aria-label="听${accentName(a)}单词读音"><span><small>${accentName(a)} · ${a==='uk'?'UK':'US'}</small><span class="ipa">${esc(a==='uk'?e.ipaUK:e.ipaUS)}</span></span><span class="speaker">${I('speaker')}</span></button>`).join('')}</div>${exampleHtml(e,0)}<details id="example-two" class="second-example"><summary>${I('down')}例句② · 再换一个场景</summary>${exampleHtml(e,1)}</details><div class="practice-controls"><button class="btn primary" data-action="group" data-entry="${e.id}">${I('headphones')}听一组并跟读</button></div>${playbackSpeedControl('lesson-rate')}<div class="accent-row"><span>这次跟读：</span>${['uk','us'].map(a=>`<button data-action="accent" data-accent="${a}" class="${state.accent===a?'selected':''}" aria-pressed="${state.accent===a}">${accentName(a)}</button>`).join('')}<span>留 ${state.gap} 秒跟读</span></div></article><div class="status-buttons"><button class="status-button learned ${state.status[e.id]==='learned'?'selected':''}" data-action="status" data-entry="${e.id}" data-status="learned" aria-pressed="${state.status[e.id]==='learned'}">${I('check')}会读了</button><button class="status-button practice ${state.status[e.id]==='practice'?'selected':''}" data-action="status" data-entry="${e.id}" data-status="practice" aria-pressed="${state.status[e.id]==='practice'}">${I('repeat')}还想练</button></div><div class="lesson-pagination"><button class="btn" data-action="previous" ${index===0?'disabled':''}>${I('left')}上一个</button>${index===4?`<button class="btn" data-action="next-day" data-day="${d.id}">学完这天，选下一天${I('arrow')}</button>`:`<button class="btn" data-action="next">下一个${I('arrow')}</button>`}</div><p class="tip">“会读了”是你给自己的标记。听过一次，也可以再练一练。</p></div></div>`;
}
function reviewCard(e){const concealed=hideEnglish&&!revealed.has(e.id);return `<article class="review-card" data-entry="${e.id}"><p class="review-zh">${esc(e.meaning)}</p>${concealed?`<button class="reveal-button" data-action="reveal" data-entry="${e.id}">点开核对英文</button>`:`<p class="review-en soundtarget" data-sound-entry="${e.id}" data-sound-part="word">${esc(e.word)}</p>`}<div class="review-card-bottom"><button class="text-link" data-action="open-word" data-entry="${e.id}">看例句${I('arrow')}</button><button class="icon-button" data-action="${concealed?'reveal-play':'play'}" data-entry="${e.id}" data-part="word" aria-label="${concealed?'核对并听':`听${accentName(state.accent)}`} ${esc(e.word)}">${I('speaker')}</button></div></article>`;}
function review(){
  currentView={type:'review'};const w=data.weeks[Math.max(0,Math.min(20,reviewWeek-1))],m=data.monthlyReviews[reviewMonth]||data.monthlyReviews[0];
  const ids=reviewType==='week'?days.get(w.number*7-1).entryIds:m.entryIds;
  currentView.entryIds=ids;
  return `${backLink('学习资料','#/library')}${pageTop('把学过的，再听一遍','先看中文想一想，再核对英文和读音。')}${moduleNav('review')}<div class="month-tabs"><button data-action="review-type" data-type="week" class="${reviewType==='week'?'selected':''}">周六复习</button><button data-action="review-type" data-type="month" class="${reviewType==='month'?'selected':''}">月度复习</button></div><div class="review-controls">${reviewType==='week'?`<select id="review-week" aria-label="选择复习周次">${data.weeks.map(x=>`<option value="${x.number}" ${x.number===w.number?'selected':''}>第${x.number}周 · ${esc(x.theme)}</option>`).join('')}</select>`:`<select id="review-month" aria-label="选择复习月份">${data.monthlyReviews.map((x,n)=>`<option value="${n}" ${n===reviewMonth?'selected':''}>${x.year}年${x.month}月 · ${x.count}词</option>`).join('')}</select>`}<button class="btn primary" data-action="review-audio">${I('play')}顺序听${ids.length}词</button><label class="review-mode"><input id="hide-english" type="checkbox" ${hideEnglish?'checked':''}>先看中文，自己回想</label></div><div class="accent-row" style="margin-bottom:17px"><span>当前声音：</span>${['uk','us'].map(a=>`<button data-action="accent" data-accent="${a}" class="${state.accent===a?'selected':''}">${accentName(a)}</button>`).join('')}</div>${reviewType==='week'?`<div class="review-grid">${ids.map(id=>reviewCard(entries.get(id))).join('')}</div>`:m.groups.map(g=>`<h3 class="review-group-label">${esc(g.theme)} · ${g.entryIds.length}词</h3><div class="review-grid">${g.entryIds.map(id=>reviewCard(entries.get(id))).join('')}</div>`).join('')}`;
}
function practice(){
  const ids=data.entries.filter(e=>state.status[e.id]==='practice').map(e=>e.id);currentView={type:'practice',entryIds:ids};
  return `${backLink('学习资料','#/library')}${pageTop('再练词','想听多少遍都可以，每次会一点。',`${ids.length}个词`)}${moduleNav('practice')}${ids.length?`<div class="practice-summary"><span>这些是你选的“还想练”。</span><button class="text-link" data-action="review-audio">${I('play')}顺序听一遍</button></div><div class="review-grid">${ids.map(id=>reviewCard(entries.get(id))).join('')}</div><p class="quiet-note">会读了？打开词卡，给它标一下“会读了”，它就会从这里移出。</p>`:`<section class="empty"><span class="empty-icon">🌱</span><h2>这里等着你想再练的词</h2><p>学习时点“还想练”或小星星，就能把单词放到这里。</p><a class="btn primary" href="${lessonHash(safeDay(),state.lastIndex)}">继续学五个词${I('arrow')}</a></section>`}`;
}
function settings(){currentView={type:'settings'};return `${pageTop('按你喜欢的方式听',LOCAL_MODE?'声音、速度和学习记录保存在这台设备上。':'声音和速度记在本机；学习记录会同步到你的账号。')}<section class="panel account-panel"><div><strong>${LOCAL_MODE?'本机学习模式':'当前账号：'+esc(account.username)}</strong><p id="sync-status" role="status" aria-live="polite">${esc(syncMessage)}</p></div>${LOCAL_MODE?`<div class="export-row"><a class="btn secondary" href="${esc(learningModeUrl())}">账号登录</a></div>`:'<div class="export-row"><button class="btn secondary" data-action="sync-now">立即同步</button><button class="btn secondary" data-action="logout">退出登录</button></div>'}</section><div class="settings-grid"><section class="panel settings-list"><div class="field"><label for="set-accent">常用口音<small>单词和两句例句都有英式、美式。</small></label><select id="set-accent"><option value="uk" ${state.accent==='uk'?'selected':''}>英式 UK</option><option value="us" ${state.accent==='us'?'selected':''}>美式 US</option></select></div><div class="field speed-setting">${playbackSpeedControl('set-rate')}</div><div class="field"><label for="set-gap">留多久跟读<small>“听一组”和连续播放之间的停顿。</small></label><select id="set-gap">${[2,3,5,8].map(n=>`<option value="${n}" ${Number(state.gap)===n?'selected':''}>${n} 秒</option>`).join('')}</select></div><div class="field"><div><label>我的学习记录</label><small>会读了 ${Object.values(state.status).filter(s=>s==='learned').length} 词 · 再练 ${Object.values(state.status).filter(s=>s==='practice').length} 词<br>${LOCAL_MODE?'刷新后记录仍保留。登录账号后可同步本机记录；免登录时跨设备可用“保存记录”和“恢复记录”。':'登录同一账号即可在其他设备查看。网络中断时先保存在本机，联网后继续同步。'}</small><div class="export-row"><button class="btn secondary" data-action="export">保存记录</button><label class="btn secondary" for="import-records" style="cursor:pointer">恢复记录</label><input id="import-records" type="file" accept="application/json,.json" hidden></div></div></div></section><aside class="panel about-panel"><h3>给家长的小提示</h3><p>网页与纸质手册按 Day、日期和词序对应。首页会继续上次的位置，不强制追赶日历。</p><p>音源：Microsoft 在线合成语音，英式 Sonia / 美式 Aria。正常音频保留完整句的语调；慢速用于辅助听清。不需要麦克风，不录制孩子声音。</p><p>单词与例句来自配套手册。“会读了”是孩子自评标记，不是自动评分。</p><div class="install-note"><strong>像小应用一样打开</strong><br>把这个网页加入浏览器书签。iPhone 可在 Safari 的分享菜单中选择“添加到主屏幕”；安卓在支持的浏览器菜单中添加到桌面。外部聊天中的链接，可以选择用系统浏览器打开。</div><button class="btn secondary wide" data-action="copy-link" style="margin-top:18px">复制学习站链接${I('arrow')}</button></aside></div>`;}
function syncLessonToItem(item){
  if(currentView.type!=='lesson')return;
  const e=entries.get(item.entry);if(e?.day!==currentView.day)return;
  const d=days.get(e.day),idx=d.entryIds.indexOf(item.entry);
  if(idx!==currentView.index){history.replaceState(null,'',lessonHash(d,idx));renderRoute({stop:false,scroll:false});}
}
function renderRoute({stop=true,scroll=true}={}){
  if(!data)return;if(!LOCAL_MODE&&!account){showLogin();return;}if(stop)player.stop();
  const path=(location.hash.slice(1)||'/home').split('/').filter(Boolean),page=path[0];
  let html,nav='library';
  if(page==='home'){html=home();nav='home';}
  else if(page==='library')html=library();
  else if(page==='english')html=catalog();
  else if(page==='review')html=review();
  else if(page==='practice')html=practice();
  else if(page==='settings'){html=settings();nav='settings';}
  else if(page==='day'&&days.has(Number(path[1])))html=lesson(days.get(Number(path[1])),path[2]);
  else if(page==='word'&&entries.has(path[1])){const e=entries.get(path[1]),d=days.get(e.day);html=lesson(d,d.entryIds.indexOf(e.id),wordBack);}
  else html=`${pageTop('这页暂时找不到','回到目录，重新选择一个 Day 吧。')}<a class="btn primary" href="#/english">打开目录${I('arrow')}</a>`;
  $('#main').innerHTML=`<div class="page-enter">${html}</div>`;
  $$('[data-nav]').forEach(a=>{const active=a.dataset.nav===nav;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  document.title=`${currentView.type==='lesson'?entries.get(currentView.entry).word+' · ':''}听听学堂 · 每天五个词`;
  if(scroll){window.scrollTo({top:0,behavior:'instant'});$('#main').focus({preventScroll:true});}
  else player.highlight();
}
function setAccent(a){if(!['uk','us'].includes(a))return;player.stop();state.accent=a;persist();renderRoute({stop:false,scroll:false});}
function setStatus(id,status){if(!entries.has(id)||!['learned','practice'].includes(status))return;if(state.status[id]===status)delete state.status[id];else state.status[id]=status;persist();renderRoute({stop:false,scroll:false});toast(state.status[id]==='learned'?'会读了，给自己一个小勾。':state.status[id]==='practice'?'放进再练词，下次再听。':'已取消这个标记。');}
function one(id,part='word',accent){if(accent&&accent!==state.accent)setAccent(accent);player.run([{entry:id,part}],entries.get(id).word);}
document.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button||!data||(!LOCAL_MODE&&!account))return;
  const a=button.dataset.action,id=button.dataset.entry;
  if(a==='logout'){logout();}
  else if(a==='sync-now'){recordSync?.flush().then(()=>recordSync?.pull()).then(()=>{if(account)renderRoute({stop:false,scroll:false});});}
  else if(a==='search'){routeTo('#/english');setTimeout(()=>$('#word-search')?.focus(),50);}
  else if(a==='play')one(id,button.dataset.part,button.dataset.accent);
  else if(a==='group')player.run(['word','ex1','ex2'].map(part=>({entry:id,part})),entries.get(id).word);
  else if(a==='day-audio'){const d=days.get(Number(button.dataset.day));player.run(d.entryIds.map(entry=>({entry,part:'word'})),`Day ${d.id} · 5个词`);}
  else if(a==='day-full'){const d=days.get(Number(button.dataset.day));player.run(d.entryIds.flatMap(entry=>['word','ex1','ex2'].map(part=>({entry,part}))),`Day ${d.id} · 词和例句`);}
  else if(a==='review-audio')player.run(currentView.entryIds.map(entry=>({entry,part:'word'})),'顺序听单词');
  else if(a==='pause')player.toggle();
  else if(a==='stop')player.stop();
  else if(a==='accent')setAccent(button.dataset.accent);
  else if(a==='rate')setPlaybackRate(button.dataset.rate);
  else if(a==='status')setStatus(id,button.dataset.status);
  else if(a==='previous'||a==='next'){const d=days.get(currentView.day);routeTo(lessonHash(d,currentView.index+(a==='next'?1:-1)));}
  else if(a==='next-day'){const n=Number(button.dataset.day)+1;if(days.has(n))routeTo(lessonHash(days.get(n)));else routeTo('#/review');}
  else if(a==='open-word'){wordBack=location.hash;routeTo(`#/word/${id}`);}
  else if(a==='review-type'){reviewType=button.dataset.type;revealed.clear();renderRoute();}
  else if(a==='reveal'||a==='reveal-play'){revealed.add(id);renderRoute({stop:false,scroll:false});if(a==='reveal-play')one(id);}
  else if(a==='export'){
    const blob=new Blob([JSON.stringify({format:'listening-station-v1',collection:data.id,savedAt:new Date().toISOString(),state},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='听听学堂-学习记录.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('学习记录备份已准备好。');
  }else if(a==='copy-link'){
    const link=location.href.split('#')[0]+'#/home';navigator.clipboard?.writeText(link).then(()=>toast('链接已复制，可以收藏或发给家人。')).catch(()=>toast('请在浏览器菜单中收藏这个网页。'));
    if(!navigator.clipboard)toast('请在浏览器菜单中收藏这个网页。');
  }
});
document.addEventListener('input',event=>{
  if(event.target.id==='word-search')searchResults(event.target.value);
  else if(event.target.matches('[data-rate-slider]') && data && (LOCAL_MODE || account))setPlaybackRate(event.target.value);
});
document.addEventListener('submit',event=>{if(event.target.id==='day-jump'){event.preventDefault();const n=Number($('#jump-number').value);if(days.has(n))routeTo(lessonHash(days.get(n)));else toast('请输入 Day 1 到 Day 147。');}});
document.addEventListener('change',async event=>{
  const el=event.target;
  if(el.id==='review-week'){reviewWeek=Number(el.value);revealed.clear();renderRoute();}
  else if(el.id==='review-month'){reviewMonth=Number(el.value);revealed.clear();renderRoute();}
  else if(el.id==='hide-english'){hideEnglish=el.checked;revealed.clear();renderRoute();}
  else if(el.id==='set-accent')setAccent(el.value);
  else if(el.matches('[data-rate-slider]') && data && (LOCAL_MODE || account))setPlaybackRate(el.value);
  else if(el.id==='set-gap'){state.gap=Number(el.value);persist();}
  else if(el.id==='import-records'&&el.files[0]){
    try{
      if(el.files[0].size>200000)throw Error('File too large');
      const imported=JSON.parse(await el.files[0].text());if(imported.format!=='listening-station-v1'||imported.collection!==data.id)throw Error('Format mismatch');
      const s=imported.state,valid={};if(!s||typeof s.status!=='object')throw Error('Missing state');
      for(const [id,value]of Object.entries(s.status))if(entries.has(id)&&['learned','practice'].includes(value))valid[id]=value;
      state.status={...state.status,...valid};if(days.get(Number(s.lastDay))?.kind==='learn'){state.lastDay=Number(s.lastDay);state.lastIndex=Math.max(0,Math.min(4,Number(s.lastIndex)||0));}
      persist();renderRoute();toast('记录已恢复，并保留了本机已有标记。');
    }catch{toast('这份文件不是本手册的学习记录，请重新选择。');}
  }
});
window.addEventListener('hashchange',()=>renderRoute());
window.addEventListener('pagehide',()=>player?.stop());
function updateSyncMessage(message){
  syncMessage=message;
  const el=$('#sync-status');if(el)el.textContent=message;
}
function setAuthChrome(loggedIn){
  document.body.classList.toggle('signed-out',!loggedIn);
  $$('.desktop-nav,.mobile-nav,.header-search').forEach(el=>el.hidden=!loggedIn);
}
function showLogin(message=''){
  player?.stop();setAuthChrome(false);currentView={type:'login'};
  $('#main').innerHTML=`<section class="login-card panel"><span class="login-mark">${I('headphones')}</span><div class="eyebrow">欢迎回到听听学堂</div><h1>登录，接着学。</h1><p class="login-description">用姓名拼音和验证码登录，换一台设备，也能找回学习记录。</p><form id="login-form"><label for="login-name">姓名拼音</label><input id="login-name" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="请输入姓名拼音" maxlength="40" required><label for="login-code">身份证后六位</label><input id="login-code" name="password" type="password" inputmode="numeric" autocomplete="current-password" placeholder="请输入六位验证码" minlength="6" maxlength="6" pattern="[0-9]{6}" required><p id="login-error" class="login-error" role="alert">${esc(message)}</p><button class="btn primary wide" type="submit">登录并继续学习${I('arrow')}</button></form><p class="login-note">这台设备会记住登录 30 天。只输入后六位，无需提供完整身份证号码。</p><p class="login-note"><a class="btn secondary wide" href="${esc(learningModeUrl(true))}">暂时免登录学习</a><br>免登录时，记录保存在这台设备上；登录后可同步到账号。</p></section>`;
  try{$('#login-name').value=localStorage.getItem('listening-username')||'';}catch{}
  $('#login-form').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=$('button',form);button.disabled=true;button.textContent='正在登录…';
    const username=$('#login-name').value.trim().toLowerCase(),password=$('#login-code').value;
    $('#login-error').textContent='';
    try{
      const {ticket}=await api('/api/login-ticket',{method:'POST',body:JSON.stringify({username,password})});
      const {proof}=await api('/auth/login',{method:'POST',body:JSON.stringify({username,password,ticket})});
      const user=await api('/api/login-complete',{method:'POST',body:JSON.stringify({proof})});
      $('#login-code').value='';try{localStorage.setItem('listening-username',username);}catch{}
      await signedIn(user);
    }catch(e){$('#login-error').textContent=e.message;$('#login-code').value='';button.disabled=false;button.innerHTML=`登录并继续学习${I('arrow')}`;}
  });
}
async function api(url,options={}){
  if(LOCAL_MODE)throw Error('本机学习模式暂未启用云端服务。');
  const response=await fetch(url,{...options,credentials:'same-origin',cache:'no-store',headers:{[options.method?'Content-Type':'Accept']:'application/json',...(account&&options.method?{'X-CSRF-Token':account.csrf}:{}),...options.headers}});
  let result;try{result=await response.json();}catch{throw Error('登录服务未启动，请联系家长完成部署。');}
  if(!response.ok){
    if(response.status===401&&account){account=null;authGeneration++;recordSync?.stop();showLogin('登录已过期，请重新登录。');}
    throw Object.assign(new Error(result.error||'网络暂时无法连接，请稍后再试。'),{status:response.status});
  }
  return result;
}
async function signedIn(user){
  account=user;const generation=++authGeneration;setAuthChrome(true);
  $('#main').innerHTML='<div class="loading"><span class="spinner"></span><p>正在找回你的学习记录…</p></div>';
  recordSync?.stop();
  recordSync=new ProgressSync({api,apply:fields=>{
    if(generation!==authGeneration||!account)return;
    const status={};for(const [id,f]of Object.entries(fields))if(entries.has(id)&&['learned','practice'].includes(f.value))status[id]=f.value;
    state.status=status;
    const position=fields.position?.value;if(days.get(position?.lastDay)?.kind==='learn'){state.lastDay=position.lastDay;state.lastIndex=Math.max(0,Math.min(4,position.lastIndex));}
    try{localStorage.setItem(STORAGE,JSON.stringify(state));}catch{}
  },notify:updateSyncMessage});
  const legacy=structuredClone(state);await recordSync.start(legacy);
  if(generation!==authGeneration||!account)return;
  reviewWeek=safeDay().week;renderRoute();
}
async function startLocalRecords(){
  recordSync?.stop();
  recordSync=new ProgressSync({localOnly:true,api,apply:fields=>{
    const status={};for(const [id,f]of Object.entries(fields))if(entries.has(id)&&['learned','practice'].includes(f.value))status[id]=f.value;
    state.status=status;
    const position=fields.position?.value;if(days.get(position?.lastDay)?.kind==='learn'){state.lastDay=position.lastDay;state.lastIndex=Math.max(0,Math.min(4,Number(position.lastIndex)||0));}
    try{localStorage.setItem(STORAGE,JSON.stringify(state));}catch{toast('浏览器无法保存记录，请在设置中导出备份。');}
  },notify:updateSyncMessage});
  await recordSync.start(structuredClone(state));
  setAuthChrome(true);reviewWeek=safeDay().week;renderRoute();
}
async function restoreSession(){
  if(LOCAL_MODE)return startLocalRecords();
  try{await signedIn(await api('/api/session'));}
  catch(e){showLogin(e.status===401?'':e.message);}
}
async function logout(){
  await recordSync?.flush();
  if(!account)return;
  try{await api('/api/logout',{method:'POST',body:'{}'});}
  catch(e){toast('暂时无法退出，请联网后再试。');return;}
  recordSync?.stop();recordSync=null;account=null;authGeneration++;showLogin();
}
window.addEventListener('online',()=>{if(account)recordSync?.flush().then(()=>recordSync?.pull());});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&account)recordSync?.flush().then(()=>recordSync?.pull());});
window.addEventListener('pagehide',()=>recordSync?.flush({keepalive:true}));
setInterval(()=>{if(account&&document.visibilityState==='visible')recordSync?.pull();},65000);

async function init(){
  try{
    const results=await Promise.all(['data.json','audio-manifest.json'].map(async f=>{const r=await fetch(f);if(!r.ok)throw Error(`Cannot load ${f}`);return r.json();}));
    [data,audioMap]=results;entries=new Map(data.entries.map(e=>[e.id,e]));days=new Map(data.days.map(d=>[d.id,d]));
    state.status=Object.fromEntries(Object.entries(state.status).filter(([id,s])=>entries.has(id)&&['practice','learned'].includes(s)));
    reviewWeek=safeDay().week;const m=Number(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',month:'numeric'}).format(new Date()));reviewMonth=Math.max(0,data.monthlyReviews.findIndex(x=>x.month===m));
    player=new ClipPlayer();
    if('serviceWorker'in navigator){
      try{
        const registration=await navigator.serviceWorker.register('./sw.js');
        const worker=registration.installing||registration.waiting;
        if(worker&&worker.state!=='activated')await new Promise(resolve=>{
          const timer=setTimeout(resolve,8000);
          worker.addEventListener('statechange',()=>{if(['activated','redundant'].includes(worker.state)){clearTimeout(timer);resolve();}});
        });
      }catch{}
    }
    await restoreSession();
  }catch{
    $('#main').innerHTML='<section class="empty"><span class="empty-icon">📖</span><h2>手册还没打开</h2><p>请确认网络连接，然后重新打开这个网页。</p><button class="btn primary" id="retry-load">再试一次</button></section>';
    $('#retry-load').addEventListener('click',init);
  }
}
init();
