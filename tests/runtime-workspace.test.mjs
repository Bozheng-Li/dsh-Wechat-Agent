import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { StateStore } from '../lib/testing.js';

const temporary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const owner = { principal: { kind: 'owner' } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('real plugin workers switch the complete workspace, recover a failed move and reload the persisted location', async t => {
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporary, 'runtime-workspace-'));
  const home = path.join(fixture, 'dsh'), bootstrap = path.join(home, 'wechat-agent'), target = path.join(fixture, 'chosen-root');
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const initial = new StateStore(bootstrap);
  initial.setPersona({ name: '迁移测试', aliases: [], prompt: '保留这段人设' });
  const storeId = initial.data.storeId, workers = [];
  let dispose, rpc;
  const start = async () => {
    const ctx = { effect: factory => { dispose = factory(); }, connection: { register: (_ctx, _channel, handler) => { rpc = handler; } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) }, llm: {} };
    await apply(ctx);
    const response = await rpc('status', {}, undefined, owner); assert(response.ok); assert(!response.value.startupError, JSON.stringify(response.value.startupError));
    const lock = JSON.parse(fs.readFileSync(path.join(bootstrap, 'owner.lock'), 'utf8')); workers.push(lock.workerPid);
    return response.value;
  };
  t.after(async () => {
    await dispose?.();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    for (const pid of workers) assert(!alive(pid), 'temporary plugin child must exit');
    assert.equal(path.dirname(fixture), temporary); assert(path.basename(fixture).startsWith('runtime-workspace-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const first = await start(); assert.equal(first.storage.basePath, bootstrap);
  const identity = await rpc('identity.get', {}, undefined, owner); assert(identity.ok);
  assert((await rpc('identity.save', { markdown: '# 全局身份\n这是实际迁移测试。', revision: identity.value.revision }, undefined, owner)).ok);
  const migrated = await rpc('storage.save', { storage: { basePath: target } }, undefined, owner);
  assert(migrated.ok, JSON.stringify(migrated.error)); assert.equal(migrated.value.storage.basePath, target);
  assert.equal(migrated.value.persona.name, '迁移测试'); assert.equal(migrated.value.scheduler.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'storage/state/channel.json'), 'utf8')).storeId, storeId);
  assert(fs.readFileSync(path.join(target, 'AGENT.md'), 'utf8').includes('实际迁移测试'));
  assert(fs.existsSync(path.join(bootstrap, 'storage/state/channel.json')), 'old data is retained');
  assert(!alive(workers[0]));
  workers.push(JSON.parse(fs.readFileSync(path.join(bootstrap, 'owner.lock'), 'utf8')).workerPid);
  assert(fs.existsSync(path.join(target, 'owner.lock')), 'active destination has its own cross-profile lock');
  const conflict = path.join(fixture, 'occupied'); fs.mkdirSync(conflict); fs.writeFileSync(path.join(conflict, 'keep.txt'), 'do not replace');
  const failed = await rpc('storage.save', { storage: { basePath: conflict } }, undefined, owner);
  assert.equal(failed.ok, false);
  const recovered = await rpc('status', {}, undefined, owner); assert(recovered.ok); assert(!recovered.value.startupError);
  assert.equal(recovered.value.storage.basePath, target); assert.equal(fs.readFileSync(path.join(conflict, 'keep.txt'), 'utf8'), 'do not replace');
  assert(!alive(workers[1])); workers.push(JSON.parse(fs.readFileSync(path.join(bootstrap, 'owner.lock'), 'utf8')).workerPid);
  await dispose(); dispose = undefined;
  assert(!fs.existsSync(path.join(target, 'owner.lock'))); assert(!fs.existsSync(path.join(bootstrap, 'owner.lock')));
  const restarted = await start(); assert.equal(restarted.storage.basePath, target); assert.equal(restarted.persona.name, '迁移测试');
  assert((await rpc('identity.get', {}, undefined, owner)).value.markdown.includes('实际迁移测试'));
});
