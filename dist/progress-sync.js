// No credentials in browser storage. The HttpOnly cookie belongs to the server.
export const RECORD_KEY = 'little-listening-sync-v2';
export function mergeFields(target, incoming) {
  for (const [name, f] of Object.entries(incoming || {})) {
    const old = target[name];
    if (!old || f.clock > old.clock || (f.clock === old.clock && f.actor > old.actor)) target[name] = f;
  }
  return target;
}
export class ProgressSync {
  constructor({ storage = localStorage, api, apply, notify, localOnly = false }) {
    Object.assign(this, { storage, api, apply, notify, localOnly });
    this.actor = crypto.randomUUID().replaceAll('-', ''); this.fields = {}; this.sequence = Date.now();
    try {
      const saved = JSON.parse(storage.getItem(RECORD_KEY) || 'null');
      if (saved?.fields && typeof saved.fields === 'object') {
        for (const [name, f] of Object.entries(saved.fields)) {
          if (/^(w\d{3}|position)$/.test(name) && Number.isSafeInteger(f?.clock) && f.clock > 0 && /^[a-f0-9]{32}$/.test(f.actor)) this.fields[name] = f;
        }
        this.pending = saved.pending;
      }
    } catch { this.notify(this.localOnly?'本机记录无法读取，请在设置中导入备份。':'本机记录无法读取，请连接云端恢复。'); }
  }
  cache() {
    try { this.storage.setItem(RECORD_KEY, JSON.stringify({ fields: this.fields, pending: this.pending || null })); }
    catch { this.notify(this.localOnly?'浏览器无法保存记录，请在设置中导出备份。':'浏览器无法保存本机记录，请保持联网并等待云端保存。'); }
  }
  change(name, value, schedule = true) {
    if (JSON.stringify(this.fields[name]?.value) === JSON.stringify(value)) return;
    const clock = Math.max(0, ...Object.values(this.fields).map(f => f.clock)) + 1;
    this.fields[name] = { value, clock, actor: this.actor };
    this.sequence = Math.max(Date.now(), this.sequence + 1);
    this.pending = { writer: this.actor, sequence: this.sequence, fields: structuredClone(this.fields) };
    this.cache(); this.notify(this.localOnly?'记录已保存在这台设备':'记录已保存在本机，等待同步');
    if (schedule && !this.localOnly) this.schedule();
  }
  schedule(delay = 1000) { if(this.localOnly)return; clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), delay); }
  async start(legacy) {
    if (!Object.keys(this.fields).length && legacy) {
      for (const [id, value] of Object.entries(legacy.status || {})) if (/^w\d{3}$/.test(id) && ['learned', 'practice'].includes(value)) this.change(id, value, false);
      if (legacy.lastDay !== 1 || legacy.lastIndex !== 0) this.change('position', { lastDay: legacy.lastDay, lastIndex: legacy.lastIndex }, false);
    }
    if(this.localOnly){
      this.cache();this.apply(this.fields);this.notify('记录保存在这台设备 · 云端同步暂未启用');return;
    }
    await this.pull();
    if (this.pending) await this.flush();
    this.apply(this.fields);
  }
  async pull() {
    if (this.localOnly || this.stopped || this.pulling) return;
    this.pulling = true;
    try {
      const remote = await this.api('/api/progress');
      if (this.stopped) return;
      mergeFields(this.fields, remote.fields); this.cache(); this.apply(this.fields);
      this.notify(this.pending ? '本机有记录等待同步' : '已读取云端记录 · 跨设备更新可能需约 1 分钟');
    } catch (e) { if (!this.stopped) this.notify(e.status === 401 ? '登录已过期，请重新登录' : '云端暂时无法连接，本机记录会保留'); }
    finally { this.pulling = false; }
  }
  async flush({ keepalive = false } = {}) {
    if (this.localOnly || this.stopped || this.uploading || !this.pending) return;
    this.uploading = true; const sent = this.pending;
    this.notify('正在保存到云端…');
    try {
      // Keepalive has a browser-wide ~64 KiB limit; the bounded 526-field record
      // can exceed it, so pagehide relies on the already persisted queue instead.
      const payload = JSON.stringify(sent);
      await this.api('/api/progress', { method: 'POST', body: payload, keepalive: keepalive && new TextEncoder().encode(payload).length < 60000 });
      if (this.stopped) return;
      if (this.pending === sent) this.pending = null;
      this.retry = 0; this.cache(); this.notify(this.pending ? '继续保存新记录…' : '云端已保存 · 其他设备约 1 分钟内可更新');
    } catch (e) {
      if (!this.stopped) {
        this.notify(e.status === 401 ? '登录已过期，请重新登录' : '本机已保存，联网后会继续同步');
        this.retry = Math.min((this.retry || 0) + 1, 6);
      }
    } finally {
      this.uploading = false;
      if (!this.stopped && this.pending) this.schedule(this.retry ? Math.min(60000, 2000 * 2 ** this.retry) : 1000);
    }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
