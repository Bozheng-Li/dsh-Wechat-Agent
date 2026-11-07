import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { MediaLibrary } from '../src/features/media/library.mjs';
import { SearchService, SEARCH_CREDENTIALS } from '../src/features/search/service.mjs';

const temporary = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage/tmp');
const owner = 'module-acceptance-owner';
const crc32 = bytes => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
};
function png(rgb) {
  const chunk = (kind, data) => {
    const name = Buffer.from(kind), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, ...rgb, ...rgb, 0, ...rgb, ...rgb]))), chunk('IEND', Buffer.alloc(0))]);
}
function mediaFixture(t) {
  fs.mkdirSync(temporary, { recursive: true });
  const base = fs.realpathSync(temporary), root = fs.mkdtempSync(path.join(base, 'module-acceptance-'));
  const store = { root, data: { storeId: path.basename(root) } }, library = new MediaLibrary(store);
  t.after(() => {
    library.close();
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), base); assert.match(path.basename(target), /^module-acceptance-/);
    fs.rmSync(target, { recursive: true, force: false });
  });
  return { library, store,
    add: (rgb = [255, 0, 0]) => library.import(owner, { name: '验收图.png', kind: 'image', data: png(rgb).toString('base64') }).assetIds[0],
    asset: id => library.resolveAsset(owner, id, { enabledOnly: false }) };
}
function delayedDescription(library, ids, captions) {
  const reached = Promise.withResolvers(), finish = Promise.withResolvers();
  const pending = library.describe(owner, ids, { describeImages: async () => {
    reached.resolve(); await finish.promise; return captions;
  } }, new AbortController().signal);
  return { reached: reached.promise, finish: finish.resolve, pending };
}

test('explicitly clearing an empty media description during analysis preserves the owner edit after restart', async t => {
  const f = mediaFixture(t), id = f.add();
  const job = delayedDescription(f.library, [id], ['迟到的模型说明']);
  await job.reached;
  f.library.edit(owner, id, { description: '' });
  const edited = f.asset(id);
  job.finish(); const result = await job.pending;
  assert.equal(result.skipped, 1); assert.equal(result.succeeded, 0);
  assert.deepEqual(f.asset(id), edited);
  assert.equal(new MediaLibrary(f.store).resolveAsset(owner, id).description, '');
});

test('editing a media description away and back cannot be overwritten by an older analysis', async t => {
  const f = mediaFixture(t), id = f.add();
  f.library.edit(owner, id, { description: '用户最终采用的说明' });
  const job = delayedDescription(f.library, [id], ['较早发起的模型说明']);
  await job.reached;
  f.library.edit(owner, id, { description: '修改过程中的草稿' });
  f.library.edit(owner, id, { description: '用户最终采用的说明' });
  const edited = f.asset(id);
  job.finish(); const result = await job.pending;
  assert.equal(result.skipped, 1); assert.equal(result.succeeded, 0);
  assert.deepEqual(f.asset(id), edited);
});

test('editing a different media item does not discard a valid analysis result', async t => {
  const f = mediaFixture(t), first = f.add(), second = f.add([0, 255, 0]);
  const job = delayedDescription(f.library, [first], ['红色方块']);
  await job.reached;
  f.library.edit(owner, second, { name: '绿色素材', description: '用户填写的绿色方块' });
  const edited = f.asset(second);
  job.finish(); const result = await job.pending;
  assert.equal(result.succeeded, 1); assert.equal(result.skipped, 0);
  assert.equal(f.asset(first).description, '红色方块'); assert.deepEqual(f.asset(second), edited);
});

async function searchFixture(t, handler) {
  const failures = [], paths = [], requests = [];
  const server = http.createServer(async (request, response) => {
    try {
      paths.push(request.url);
      const parts = []; for await (const part of request) parts.push(part);
      requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')));
      await handler(request, response);
    } catch (error) { failures.push(error); response.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await stopped;
    assert.deepEqual(failures, []);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const service = new SearchService({ credentials: { resolve: async ref => {
    assert.equal(ref, SEARCH_CREDENTIALS.tavily); return { value: 'fixture-local-only-key' };
  } } }, { fetchImpl: (url, options) => {
    assert.equal(url, 'https://search-fixture.invalid/api/search');
    return fetch(origin + '/search', options);
  } });
  return { search: service.forConfig({ searchProvider: 'tavily', tavilyBaseURL: 'https://search-fixture.invalid/api' }), paths, requests };
}

test('a real chunked HTTP search returns only bounded valid public sources and the explicit query', async t => {
  const responseBody = JSON.stringify({ results: [
    { title: '一', url: 'https://arxiv.org/abs/fixture-one', content: '第一条公开摘要' },
    { title: '重复', url: 'https://arxiv.org/abs/fixture-one' },
    { title: '不接受认证地址', url: 'https://user:password@example.org/private' },
    { title: '不接受本地文件', url: 'file:///private/file' },
    { title: '二', url: 'https://arxiv.org/abs/fixture-two', content: '第二条公开摘要' },
    { title: '超出请求数量', url: 'https://arxiv.org/abs/fixture-three' },
  ] });
  const f = await searchFixture(t, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const half = Math.floor(responseBody.length / 2); response.write(responseBody.slice(0, half));
    await new Promise(resolve => setTimeout(resolve, 5)); response.end(responseBody.slice(half));
  });
  const result = await f.search.search({ query: 'site:arxiv.org fixture', maxResults: 2 }, new AbortController().signal);
  assert.deepEqual(result.sources.map(source => source.url), ['https://arxiv.org/abs/fixture-one', 'https://arxiv.org/abs/fixture-two']);
  assert.deepEqual(f.requests, [{ api_key: 'fixture-local-only-key', query: 'site:arxiv.org fixture', search_depth: 'basic', max_results: 2, include_answer: false, include_raw_content: false }]);
  assert.deepEqual(f.paths, ['/search']); assert.equal(result.truncated, true);
  assert(!JSON.stringify(result).includes('fixture-local-only-key'));
});

test('the real HTTP client refuses a search redirect before forwarding the credential', async t => {
  const f = await searchFixture(t, async (_request, response) => {
    response.writeHead(307, { location: '/redirected' }); response.end();
  });
  await assert.rejects(f.search.search({ query: '公开查询', maxResults: 5 }, new AbortController().signal), error =>
    error.code === 'WEB_SEARCH_FAILED' && !error.message.includes('fixture-local-only-key'));
  assert.deepEqual(f.paths, ['/search']);
});

test('rejecting an oversized response closes the real HTTP body promptly', async t => {
  const closed = Promise.withResolvers();
  const f = await searchFixture(t, async (_request, response) => {
    response.once('close', () => closed.resolve(true));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) });
    response.write('{');
  });
  await assert.rejects(f.search.search({ query: '公开查询', maxResults: 5 }, new AbortController().signal), { code: 'WEB_SEARCH_RESPONSE_TOO_LARGE' });
  let timer;
  const released = await Promise.race([closed.promise, new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
  clearTimeout(timer);
  assert.equal(released, true, 'A rejected response must release its connection without waiting for the 45-second search timeout');
});

test('cancelling after real search response headers aborts body reading without returning a result', async t => {
  const reached = Promise.withResolvers();
  const f = await searchFixture(t, async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"results":['); reached.resolve();
  });
  const controller = new AbortController(), reason = new Error('fixture user cancellation');
  let completed = false;
  const pending = f.search.search({ query: '公开查询', maxResults: 5 }, controller.signal).then(value => { completed = true; return value; });
  await reached.promise;
  // Give fetch a chance to expose the headers and start reading the stream.
  await new Promise(resolve => setTimeout(resolve, 20)); controller.abort(reason);
  await assert.rejects(pending, error => error === reason || error.name === 'AbortError');
  assert.equal(completed, false); assert.deepEqual(f.paths, ['/search']);
});
