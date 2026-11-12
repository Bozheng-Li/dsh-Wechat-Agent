import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { StateStore, ImageGenerationService, IMAGE_GENERATION_CREDENTIAL, imageGenerationCredential, imageGenerationSettings, workTools, ChannelError } from '../lib/testing.js';
import { stickerPng } from './fixtures/stickers.mjs';

const png = stickerPng();
const signal = () => new AbortController().signal;
const response = () => Response.json({ data: [{ b64_json: png.toString('base64') }] });
const provider = (id, extra = {}) => ({ id, name: '接口 ' + id, endpoint: `https://${id}-image.invalid/v1`, models: ['shared-image', id + '-image'], defaultModel: 'shared-image', ...extra });
const settings = () => ({ enabled: true, defaultProviderId: 'first', providers: [provider('first'), provider('second', { defaultModel: 'second-image', size: '1536x1024', quality: 'high', responseFormat: 'b64_json', timeoutSeconds: 600 })] });
function fixture(t, fetchImpl = async () => response()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-image-providers-')), store = new StateStore(root);
  const save = value => { const next = store.config.snapshot(store.data); next.imageGeneration = value; store.config.commit(next); };
  save(settings());
  const credentials = new Map(store.config.section('imageGeneration').providers.map(item => [imageGenerationCredential(item), item.id + '-private-key']));
  const resolved = [], written = [];
  const ctx = { credentials: {
    resolve: async ref => { resolved.push(ref); return { value: credentials.get(ref) }; },
    describe: async ref => ({ configured: credentials.has(ref) }),
    set: async (ref, key) => { written.push(ref); credentials.set(ref, key); },
  } };
  const service = new ImageGenerationService(ctx, store, { fetchImpl });
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^wechat-image-providers-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store, service, save, credentials, resolved, written, ctx };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('old single-interface YAML retains its default model, options and dedicated credential through reload', async t => {
  const f = fixture(t);
  f.save({ enabled: true, endpoint: 'https://old-image.invalid/v1/', model: 'old-image', size: '2048x2048', quality: 'medium', responseFormat: 'url', timeoutSeconds: 600 });
  const migrated = f.service.settings();
  assert.equal(migrated.defaultProviderId, 'default'); assert.equal(migrated.providers.length, 1);
  assert.deepEqual(migrated.providers[0].models, ['old-image']); assert.equal(migrated.providers[0].timeoutSeconds, 600);
  assert.equal(imageGenerationCredential(migrated.providers[0]), IMAGE_GENERATION_CREDENTIAL);
  f.credentials.set(IMAGE_GENERATION_CREDENTIAL, 'legacy-private-key');
  assert.equal((await f.service.generate({ prompt: '旧配置生成图片' }, signal())).model, 'old-image');
  assert.equal(f.resolved.at(-1), IMAGE_GENERATION_CREDENTIAL);
  const reopened = new StateStore(f.root); assert.deepEqual(new ImageGenerationService(f.ctx, reopened).settings(), migrated);
});

for (const [name, change] of [
  ['duplicate interfaces', value => value.providers.push({ ...value.providers[0] })],
  ['duplicate models', value => value.providers[0].models.push(' shared-image ')],
  ['unknown default interface', value => { value.defaultProviderId = 'unknown'; }],
  ['null enabled state', value => { value.enabled = null; }],
  ['null default interface', value => { value.defaultProviderId = null; }],
  ['unknown default model', value => { value.providers[0].defaultModel = 'unknown'; }],
  ['embedded API key', value => { value.providers[0].apiKey = 'private-key'; }],
  ['arbitrary credential reference', value => { value.providers[0].credentialRef = 'CHAT_API_KEY'; }],
  ['mixed old and new settings', value => { value.model = 'ambiguous'; }],
  ['non-string endpoint', value => { value.providers[0].endpoint = {}; }],
]) test(`multiple image settings reject ${name}`, () => {
  const value = settings(); change(value); assert.throws(() => imageGenerationSettings(value), { code: 'IMAGE_GENERATION_CONFIG' });
});

test('one interface supports multiple explicit models using the same credential and its defaults', async t => {
  const calls = [], f = fixture(t, async (url, options) => { calls.push({ url, options }); return response(); });
  const result = await f.service.generate({ prompt: '绘制默认图片' }, signal());
  const alternate = await f.service.generate({ prompt: '绘制其他模型图片', model: 'first-image', size: '2048x2048' }, signal());
  assert.equal(result.providerId, 'first'); assert.equal(result.model, 'shared-image'); assert.equal(alternate.model, 'first-image');
  assert(calls.every(call => call.url === 'https://first-image.invalid/v1/images/generations' && call.options.headers.authorization === 'Bearer first-private-key'));
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body).model), ['shared-image', 'first-image']);
  assert.equal(JSON.parse(calls[1].options.body).size, '2048x2048'); assert.equal(new Set(f.resolved).size, 1);
});

test('image interfaces accept and preserve an explicit one-hour timeout without exceeding it', async t => {
  const f = fixture(t), value = f.service.settings(), deadlines = [];
  value.providers[0].timeoutSeconds = 3600; f.save(value);
  assert.equal(new ImageGenerationService(f.ctx, new StateStore(f.root)).settings().providers[0].timeoutSeconds, 3600);
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadlines.push(milliseconds); return new AbortController().signal; });
  await f.service.generate({ prompt: '一小时预算的图片' }, signal()); assert.deepEqual(deadlines, [3600000]);
  value.providers[0].timeoutSeconds = 3601; assert.throws(() => imageGenerationSettings(value), { code: 'IMAGE_GENERATION_CONFIG' });
});

test('cross-interface selection uses the chosen model, options and key, including identically named models', async t => {
  const calls = [], f = fixture(t, async (url, options) => { calls.push({ url, options }); return response(); });
  await f.service.generate({ prompt: '第二接口', providerId: 'second' }, signal());
  await f.service.generate({ prompt: '同名模型', providerId: 'second', model: 'shared-image' }, signal());
  assert(calls.every(call => call.url === 'https://second-image.invalid/v1/images/generations' && call.options.headers.authorization === 'Bearer second-private-key'));
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'second-image', prompt: '第二接口', n: 1, size: '1536x1024', quality: 'high', response_format: 'b64_json' });
  assert.equal(JSON.parse(calls[1].options.body).model, 'shared-image');
  const current = f.service.settings(); current.defaultProviderId = 'second'; f.save(current);
  assert.equal((await f.service.generate({ prompt: '更换默认接口' }, signal())).providerId, 'second');
});

for (const [args, code] of [[{ providerId: 'missing' }, 'IMAGE_GENERATION_PROVIDER'], [{ model: 'second-image' }, 'IMAGE_GENERATION_MODEL'], [{ providerId: 'second', model: 'missing' }, 'IMAGE_GENERATION_MODEL']])
  test(`invalid image selection is rejected before credentials or HTTP: ${JSON.stringify(args)}`, async t => {
    let calls = 0; const f = fixture(t, async () => { calls++; return response(); });
    await assert.rejects(() => f.service.generate({ prompt: '生成图片', ...args }, signal()), { code });
    assert.equal(calls, 0); assert.equal(f.resolved.length, 0);
  });

test('a selected interface without a key never borrows another interface credential', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return response(); });
  const ref = imageGenerationCredential(f.service.settings().providers[1]); f.credentials.delete(ref);
  await assert.rejects(() => f.service.generate({ prompt: '生成图片', providerId: 'second' }, signal()), { code: 'IMAGE_GENERATION_CREDENTIAL' });
  assert.deepEqual(f.resolved, [ref]); assert.equal(calls, 0);
});

test('credentials remain separate for different interfaces at the same address and for a changed address', async t => {
  const f = fixture(t), value = f.service.settings();
  value.providers[1].endpoint = value.providers[0].endpoint; f.save(value);
  const [first, second] = f.service.settings().providers;
  assert.notEqual(imageGenerationCredential(first), imageGenerationCredential(second));
  await f.service.configureCredential('second-new-key', signal(), { providerId: second.id, endpoint: second.endpoint });
  assert.equal(f.credentials.get(imageGenerationCredential(first)), 'first-private-key');
  value.providers[1].endpoint = 'https://changed-image.invalid/v1'; f.save(value);
  await f.service.refreshCredential();
  assert.equal(f.service.status().providers[0].credentialConfigured, true); assert.equal(f.service.status().providers[1].credentialConfigured, false);
  await assert.rejects(() => f.service.generate({ prompt: '生成图片', providerId: 'second' }, signal()), { code: 'IMAGE_GENERATION_CREDENTIAL' });
  await assert.rejects(() => f.service.configureCredential('incorrect-address-key', signal(), { providerId: 'second', endpoint: second.endpoint }), { code: 'IMAGE_GENERATION_CHANGED' });
  assert.equal(f.written.length, 1);
});

test('configuration changes while resolving a key stop the old request before HTTP', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return response(); });
  const started = deferred(), key = deferred(); f.ctx.credentials.resolve = async () => { started.resolve(); return key.promise; };
  const pending = f.service.generate({ prompt: '生成图片' }, signal()); await started.promise;
  const value = f.service.settings(); value.defaultProviderId = 'second'; f.save(value); key.resolve({ value: 'first-private-key' });
  await assert.rejects(() => pending, { code: 'IMAGE_GENERATION_CHANGED' }); assert.equal(calls, 0);
});

test('changing a selected key while generating prevents the old image from being accepted', async t => {
  const started = deferred(), image = deferred();
  const f = fixture(t, async () => { started.resolve(); return image.promise; });
  const pending = f.service.generate({ prompt: '生成图片', providerId: 'second' }, signal()); await started.promise;
  await f.service.configureCredential('replacement-key', signal(), { providerId: 'second' }); image.resolve(response());
  await assert.rejects(() => pending, { code: 'IMAGE_GENERATION_CHANGED' });
  assert.equal(f.credentials.get(imageGenerationCredential(f.service.settings().providers[0])), 'first-private-key');
});

test('removing an interface during credential saving cannot apply its key to the remaining interface', async t => {
  const f = fixture(t), started = deferred(), write = deferred(), old = f.service.settings().providers[1];
  f.ctx.credentials.set = async (ref, key) => { started.resolve(); await write.promise; f.credentials.set(ref, key); };
  const pending = f.service.configureCredential('removed-interface-key', signal(), { providerId: 'second' }); await started.promise;
  const value = f.service.settings(); value.providers.pop(); f.save(value); write.resolve();
  await assert.rejects(() => pending, { code: 'IMAGE_GENERATION_CHANGED' });
  assert.equal(f.credentials.get(imageGenerationCredential(old)), 'removed-interface-key');
  assert.equal(f.credentials.get(imageGenerationCredential(f.service.settings().providers[0])), 'first-private-key');
});

test('the work tool publishes an accurate model directory and records the actual interface with API bytes', async t => {
  const f = fixture(t), operations = [], control = new AbortController();
  const tool = workTools({ cwd: f.root, limits: {}, imageGeneration: f.service, assertAllowed() {}, onOperation: operation => operations.push(operation) }).find(item => item.name === 'wechat_work_generate_image');
  assert.deepEqual(tool.parameters.properties.providerId.enum, ['first', 'second']);
  assert.deepEqual(tool.parameters.properties.model.enum, ['shared-image', 'first-image', 'second-image']);
  assert(tool.description.includes('second-image') && tool.description.includes('defaultProviderId')); assert(!tool.description.includes('private-key'));
  const result = JSON.parse(await tool.execute({ prompt: '使用第二接口绘制', path: 'result.png', providerId: 'second', model: 'shared-image' }, { signal: control.signal }));
  assert.equal(result.ok, true); assert.equal(result.providerId, 'second'); assert.equal(result.model, 'shared-image');
  assert.deepEqual(fs.readFileSync(path.join(f.root, result.artifacts[0].path)), png);
  assert(!JSON.stringify(operations).includes('private-key')); assert(!JSON.stringify(operations).includes('b64_json'));
  f.service.fetchImpl = async () => { control.abort(new ChannelError('CANCELLED', '取消')); return response(); };
  await assert.rejects(() => tool.execute({ prompt: '迟到结果', path: 'late.png', providerId: 'second' }, { signal: control.signal }));
  assert(!fs.existsSync(path.join(f.root, 'late.png')));
});

test('HTTP failures do not automatically retry or switch to another interface or model', async t => {
  const calls = [], f = fixture(t, async (url, options) => { calls.push({ url, options }); return new Response('second-private-key', { status: 401 }); });
  await assert.rejects(() => f.service.generate({ prompt: '生成图片', providerId: 'second', model: 'shared-image' }, signal()), error => error.code === 'IMAGE_GENERATION_HTTP' && !error.message.includes('private-key'));
  assert.equal(calls.length, 1); assert.match(calls[0].url, /second-image/); assert.equal(JSON.parse(calls[0].options.body).model, 'shared-image');
});

test('real HTTP requests route different interfaces and models using separate keys without exposing them in status or YAML', async t => {
  const requests = [], server = createServer(async (request, reply) => {
    let body = ''; for await (const bytes of request) body += bytes.toString('utf8');
    requests.push({ path: request.url, key: request.headers.authorization, body: JSON.parse(body) });
    reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const f = fixture(t, globalThis.fetch), value = f.service.settings();
  value.providers.forEach(item => { item.endpoint = `http://127.0.0.1:${server.address().port}/${item.id}/v1`; }); f.save(value);
  for (const item of f.service.settings().providers) await f.service.configureCredential(item.id + '-http-key', signal(), { providerId: item.id });
  for (const [providerId, model] of [['first', 'shared-image'], ['first', 'first-image'], ['second', 'shared-image']])
    assert.deepEqual((await f.service.generate({ prompt: '真实 HTTP 图片', providerId, model }, signal())).bytes, png);
  assert.deepEqual(requests.map(item => [item.path, item.key, item.body.model]), [
    ['/first/v1/images/generations', 'Bearer first-http-key', 'shared-image'], ['/first/v1/images/generations', 'Bearer first-http-key', 'first-image'],
    ['/second/v1/images/generations', 'Bearer second-http-key', 'shared-image'],
  ]);
  assert(f.service.status().providers.every(item => item.credentialConfigured));
  assert(!JSON.stringify(f.service.status()).includes('http-key')); assert(!fs.readFileSync(f.store.config.file, 'utf8').includes('http-key'));
});
