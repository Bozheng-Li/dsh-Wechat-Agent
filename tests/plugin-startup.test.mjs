import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { apply } from '../lib/index.js';
import { afterAppReady, startupWait } from '../backend/app/startup.mjs';

const base = fileURLToPath(new URL('../storage/tmp/', import.meta.url));
const owner = { principal: { kind: 'owner' } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function hostReadiness(committed = false) {
  const listeners = new Set();
  return {
    onReady(listener) {
      if (committed) listener();
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commit() {
      committed = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
    get pending() { return listeners.size; },
  };
}

async function until(read, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(20);
  }
  assert.fail(message);
}

function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'plugin-startup-'));
  const home = path.join(root, 'home'), bootstrap = path.join(home, 'wechat-agent');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const instances = [], release = [];
  t.after(async () => {
    for (const callback of release) callback();
    for (const instance of instances.reverse()) await instance.dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    await nextTurn();
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(base));
    assert(path.basename(target).startsWith('plugin-startup-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return {
    root, home, bootstrap, release,
    async mount({ create = async (_directory, title) => ({ title }), committed = false } = {}) {
      const ready = hostReadiness(committed);
      let dispose, rpc;
      const ctx = {
        get: name => name === 'appReady' ? ready : undefined,
        effect: factory => { dispose = factory(); },
        connection: { register: (_ctx, _channel, handler) => { rpc = handler; } },
        workspaceRegistry: { create },
        agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
        llm: {},
      };
      await apply(ctx);
      const instance = {
        ready, dispose,
        rpc: (endpoint, payload = {}) => rpc(endpoint, payload, undefined, owner),
        async status() {
          const response = await rpc('status', {}, undefined, owner);
          assert(response.ok, JSON.stringify(response.error));
          return response.value;
        },
        settled() { return until(async () => { const value = await instance.status(); return !value.starting && value; }, 'plugin did not finish starting'); },
      };
      instances.push(instance);
      return instance;
    },
  };
}

test('host boot returns before WeChat starts; status stays responsive during initialization', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  f.release.push(() => gate.resolve());
  const app = await f.mount({ create: async (_directory, title) => { entered.resolve(); await gate.promise; return { title }; } });
  assert(!fs.existsSync(f.bootstrap), 'mount must not create storage or start a worker');
  assert.equal(app.ready.pending, 1);
  const before = await app.status();
  assert.equal(before.starting, true);
  assert.equal(before.startupSlow, false);
  assert.equal(before.state, 'starting');
  assert.equal(before.runtimeReady, false);
  assert.equal((await app.rpc('connect')).error.code, 'PLUGIN_STARTING');
  assert.equal((await app.rpc('identity.get')).error.code, 'PLUGIN_STARTING');
  assert.equal((await app.rpc('changelog')).ok, true);
  app.ready.commit();
  assert(!fs.existsSync(f.bootstrap), 'the readiness callback itself must remain synchronous and light');
  await entered.promise;
  assert.equal((await app.status()).starting, true, 'the host API remains usable while workspace registration waits');
  const workerPid = JSON.parse(fs.readFileSync(path.join(f.bootstrap, 'owner.lock'), 'utf8')).workerPid;
  assert(alive(workerPid));
  gate.resolve();
  const ready = await app.settled();
  assert.equal(ready.startupError, undefined);
  assert.equal(ready.startupSlow, false);
  assert.equal(ready.scheduler.enabled, true);
  await app.dispose();
  assert(!alive(workerPid));
  assert(!fs.existsSync(path.join(f.bootstrap, 'owner.lock')));
});

for (const commitFirst of [false, true]) test(`disabling ${commitFirst ? 'just after' : 'before'} host readiness cancels startup`, async t => {
  const f = fixture(t), app = await f.mount();
  if (commitFirst) app.ready.commit();
  await app.dispose();
  app.ready.commit();
  await nextTurn();
  assert.equal(app.ready.pending, 0);
  assert(!fs.existsSync(f.bootstrap));
  assert.equal((await app.rpc('status')).error.code, 'PLUGIN_STOPPING');
});

test('a real startup failure clears the slow notice and re-enabling after host readiness recovers', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  f.release.push(() => gate.resolve());
  const broken = await f.mount({ create: async () => { entered.resolve(); await gate.promise; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.doesNotThrow(() => broken.ready.commit());
  await entered.promise;
  t.mock.timers.tick(60_000);
  assert.equal((await broken.status()).startupSlow, true);
  t.mock.timers.reset();
  gate.reject(new Error('secret=not-for-the-ui'));
  const error = await broken.settled();
  assert.equal(error.state, 'error');
  assert.equal(error.startupSlow, false);
  assert(error.startupError);
  assert(!JSON.stringify(error).includes('not-for-the-ui'));
  assert.equal((await broken.rpc('identity.get')).error.code, error.startupError.code);
  await until(() => !fs.existsSync(path.join(f.bootstrap, 'owner.lock')), 'failed startup did not release its lock');
  await broken.dispose();
  const restored = await f.mount({ committed: true });
  assert.equal((await restored.status()).starting, true);
  assert.equal((await restored.settled()).startupError, undefined);
});

for (const slow of [false, true]) test(`disposal during ${slow ? 'slow' : 'pending'} startup reaps the worker and ignores late readiness`, async t => {
  const f = fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  f.release.push(() => gate.resolve());
  let registrations = 0;
  const app = await f.mount({ create: async (_directory, title) => { registrations++; entered.resolve(); await gate.promise; return { title }; } });
  if (slow) t.mock.timers.enable({ apis: ['setTimeout'] });
  app.ready.commit();
  await entered.promise;
  if (slow) {
    t.mock.timers.tick(60_000);
    assert.equal((await app.status()).startupSlow, true);
    t.mock.timers.reset();
  }
  const workerPid = JSON.parse(fs.readFileSync(path.join(f.bootstrap, 'owner.lock'), 'utf8')).workerPid;
  await app.dispose();
  assert(!alive(workerPid));
  assert(!fs.existsSync(path.join(f.bootstrap, 'owner.lock')));
  gate.resolve();
  await nextTurn();
  assert.equal(registrations, 1, 'late completion must not start the next registration or reconnect');
  assert.equal((await app.rpc('connect')).error.code, 'PLUGIN_STOPPING');
});

test('sixty seconds is a slow notice, not a startup deadline; late completion still succeeds', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), gate = Promise.withResolvers();
  f.release.push(() => gate.resolve());
  const app = await f.mount({ create: async (_directory, title) => { entered.resolve(); await gate.promise; return { title }; } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.timers.tick(120_000);
  assert.equal((await app.status()).startupSlow, false, 'waiting for Harness readiness does not count as slow WeChat startup');
  app.ready.commit();
  await entered.promise;
  const workerPid = JSON.parse(fs.readFileSync(path.join(f.bootstrap, 'owner.lock'), 'utf8')).workerPid;
  t.mock.timers.tick(59_999);
  assert.equal((await app.status()).startupSlow, false);
  t.mock.timers.tick(1);
  const slow = await app.status();
  assert.equal(slow.startupSlow, true);
  assert.equal(slow.starting, true);
  assert.equal(slow.state, 'starting');
  assert.equal(slow.startupError, undefined);
  assert.equal((await app.rpc('connect')).error.code, 'PLUGIN_STARTING');
  assert.equal((await app.rpc('changelog')).ok, true);
  t.mock.timers.tick(5 * 60_000);
  assert.equal((await app.status()).starting, true, 'a long initialization is still allowed to finish');
  assert(alive(workerPid));
  assert(fs.existsSync(path.join(f.bootstrap, 'owner.lock')));
  t.mock.timers.reset();
  gate.resolve();
  const ready = await app.settled();
  assert.equal(ready.starting, false);
  assert.equal(ready.startupSlow, false);
  assert.equal(ready.startupError, undefined);
  assert.equal(ready.scheduler.enabled, true);
});

test('readiness is one-shot, deferred even for an already ready host, and owns async rejection', async () => {
  let starts = 0;
  const reported = Promise.withResolvers(), signal = new AbortController().signal;
  const ready = hostReadiness(true);
  const cancel = afterAppReady({ appReady: ready }, async () => { starts++; throw new Error('fixture startup'); }, reported.resolve, signal);
  assert.equal(starts, 0);
  ready.commit(); ready.commit();
  assert.match((await reported.promise).message, /fixture startup/);
  assert.equal(starts, 1);
  cancel();
});

test('a host without readiness support reports a plugin error without starting work', () => {
  let error, started = false;
  const cancel = afterAppReady({}, () => { started = true; }, value => { error = value; }, new AbortController().signal);
  assert.equal(error.code, 'HARNESS_READY_UNAVAILABLE');
  assert.equal(started, false);
  cancel();
});

test('cancelling startup observes a late service rejection', async () => {
  const late = Promise.withResolvers(), controller = new AbortController();
  const result = startupWait(late.promise, controller.signal);
  controller.abort(new Error('fixture cancellation'));
  await assert.rejects(result, /fixture cancellation/);
  late.reject(new Error('late fixture failure'));
  await nextTurn();
});
