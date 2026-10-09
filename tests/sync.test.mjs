import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressSync, RECORD_KEY } from '../dist/progress-sync.js';
const makeStorage = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }; };
const options = (storage, api, apply = () => {}) => ({ storage, api, apply, notify: () => {} });
test('offline changes survive refresh and retry; newest local changes remain queued during an upload', async () => {
  const storage = makeStorage(); let offline = true, received;
  const api = async (url, options) => { if (offline) throw Error('offline'); if (options?.method) { received = JSON.parse(options.body); return { ok: true }; } return { fields: {} }; };
  let sync = new ProgressSync(options(storage, api)); sync.change('w001', 'learned'); await sync.flush(); sync.stop();
  assert.ok(JSON.parse(storage.getItem(RECORD_KEY)).pending);
  sync = new ProgressSync(options(storage, api)); offline = false; await sync.start();
  assert.equal(received.fields.w001.value, 'learned'); assert.equal(sync.pending, null); sync.stop();
  let release; const blocked = new Promise(resolve => release = resolve);
  sync = new ProgressSync(options(makeStorage(), async () => { await blocked; return { ok: true }; }));
  sync.change('w001', 'learned'); const upload = sync.flush(); sync.change('w002', 'practice'); release(); await upload;
  assert.ok(sync.pending); assert.equal(sync.pending.fields.w002.value, 'practice'); await sync.flush(); assert.equal(sync.pending, null); sync.stop();
});
test('migration merges legacy records; remote versions win; a remote tombstone does not resurrect a word', async () => {
  const storage = makeStorage(), actor = 'f'.repeat(32); let applied;
  const sync = new ProgressSync(options(storage, async (url, options) => options?.method ? { ok: true } : { fields: { w001: { value: null, clock: 50, actor }, position: { value: { lastDay: 8, lastIndex: 4 }, clock: 51, actor } } }, f => applied = f));
  await sync.start({ status: { w001: 'learned', w002: 'practice' }, lastDay: 2, lastIndex: 1 });
  assert.equal(applied.w001.value, null); assert.equal(applied.w002.value, 'practice'); assert.equal(applied.position.value.lastDay, 8);
  sync.change('w003', 'learned'); assert.ok(sync.fields.w003.clock > 51); sync.stop();
});
