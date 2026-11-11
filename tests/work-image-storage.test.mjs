import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../modules/media/image-format.mjs';
import { StateStore, WorkStore, WechatChannel, ChannelError, readWorkArtifact, archiveWorkImages, mergeImageArchives, imageArchiveMetadata } from '../lib/testing.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function image(red, padding = 0) {
  const chunk = (name, data) => {
    const tag = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
    return Buffer.concat([size, tag, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...(padding ? [chunk('tEXt', Buffer.concat([Buffer.from('fixture\0'), Buffer.alloc(padding, 97)]))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 100, 100, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const puppy = image(200), changedPuppy = image(20);
const scope = { accountId: 'image-storage-owner', chatType: 'private', peerId: 'alice', senderId: 'alice' };
function fixture(t, run = async () => ({ text: '已完成' })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-image-storage-')), store = new StateStore(root), sent = [];
  store.configure(scope.accountId, { enabled: true, privatePeers: ['alice'], groups: [], prompt: '' });
  store.setConversationSettings(scope.accountId, 'private', 'alice', { ...store.conversationSettings(scope.accountId, 'private', 'alice'), executionMode: 'work' });
  const channel = new WechatChannel({ store, runner: { run: async input => ({ text: JSON.parse(input.text).result }) },
    workRunner: { run }, transport: {
      status: () => ({ online: true, account: { id: scope.accountId } }),
      send: async payload => {
        sent.push(payload);
        const deliveryParts = payload.message.map((part, index) => ({ index, type: part.type, state: 'acknowledged', serverMessageId: `ack-${sent.length}-${index}`,
          ...(part.type === 'text' ? {} : { name: part.data.name, bytes: Buffer.from(part.data.base64, 'base64').length, sha256: digest(Buffer.from(part.data.base64, 'base64')) }) }));
        return { delivery: 'server-ack', serverMessageIds: deliveryParts.map(part => part.serverMessageId), deliveryParts };
      },
    } });
  t.after(async () => {
    await channel.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^wechat-image-storage-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const start = async (request = '生成图片', previousId) => {
    const created = channel.work.create(scope, request, previousId); await channel.work.whenIdle(); return channel.work.get(created.id, scope);
  };
  const directJob = id => {
    const workspaceRoot = store.storageSettings().workspacePath, folder = `微信agent/work/${id}`, cwd = path.join(workspaceRoot, folder);
    fs.mkdirSync(cwd, { recursive: true }); return { id, workspaceRoot, folder, cwd };
  };
  return { root, store, channel, sent, start, directJob };
}
function assertSaved(job, archive, expected) {
  assert.equal(archive.state, 'saved'); assert(imageArchiveMetadata(archive, job.id));
  assert.deepEqual(fs.readFileSync(path.join(job.workspaceRoot, archive.path)), expected);
  assert.equal(archive.sha256, digest(expected));
}
function assertImageMemory(f, job, expected, deliveryState) {
  const selector = { ...scope, collection: 'generated' },
    items = f.channel.imageMemory.list(selector).items.filter(item => item.generation.jobId === job.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].digest, digest(expected));
  assert.equal(items[0].generation.deliveryState, deliveryState);
  assert.deepEqual(Buffer.from(f.channel.imageMemory.content(selector, items[0].id).data, 'base64'), expected);
  return items[0];
}

test('parallel same-name images get independent main-directory copies and return the original bytes', async t => {
  const gate = Promise.withResolvers(); let count = 0;
  const f = fixture(t, async input => {
    const bytes = ++count === 1 ? puppy : changedPuppy;
    if (count === 2) gate.resolve(); await gate.promise;
    fs.writeFileSync(path.join(input.cwd, 'puppy.png'), bytes);
    const artifact = readWorkArtifact(input.cwd, 'puppy.png').metadata;
    await input.onOperation({ tool: 'wechat_work_generate_image', result: { ok: true, artifacts: [artifact] } });
    return { text: '小狗图片已生成。\n![小狗](puppy.png)', artifacts: [artifact] };
  });
  f.channel.work.create(scope, '生成第一张图片'); f.channel.work.create(scope, '生成第二张图片'); await f.channel.work.whenIdle();
  const jobs = new WorkStore(f.store).list(scope); assert.equal(jobs.length, 2);
  assert.equal(new Set(jobs.map(job => job.imageArchives[0].path)).size, 2);
  for (const job of jobs) {
    const original = fs.readFileSync(path.join(job.workspaceRoot, job.folder, 'puppy.png'));
    assert.equal(job.imageArchives.length, 1); assertSaved(job, job.imageArchives[0], original);
    assert.equal(job.result.artifacts[0].path, 'puppy.png'); assert.equal(job.delivery.state, 'sent');
    assertImageMemory(f, job, original, 'sent');
  }
  assert.equal(f.sent.length, 2);
  for (const payload of f.sent) {
    assert(!payload.message[0].data.text.includes('!['));
    const bytes = Buffer.from(payload.message[1].data.base64, 'base64'); assert([digest(puppy), digest(changedPuppy)].includes(digest(bytes)));
  }
  assert(!fs.readFileSync(f.channel.work.store.file, 'utf8').includes('base64'));
});

test('a generated image is archived immediately and survives a later DSH execution failure', async t => {
  const started = Promise.withResolvers(), released = Promise.withResolvers();
  const f = fixture(t, async input => {
    fs.writeFileSync(path.join(input.cwd, 'puppy.png'), puppy);
    await input.onOperation({ tool: 'wechat_work_generate_image', result: { ok: true, artifacts: [readWorkArtifact(input.cwd, 'puppy.png').metadata] } });
    started.resolve(); await released.promise; throw new ChannelError('FIXTURE_DSH_FAILED', '测试后续执行失败');
  });
  const created = f.channel.work.create(scope, '生成图片后执行一个失败步骤'); await started.promise;
  const running = f.channel.work.get(created.id, scope); assert.equal(running.state, 'running'); assertSaved(running, running.imageArchives[0], puppy);
  assertImageMemory(f, running, puppy, 'not-confirmed');
  released.resolve(); await f.channel.work.whenIdle();
  const job = new WorkStore(f.store).get(created.id); assert.equal(job.state, 'failed'); assertSaved(job, job.imageArchives[0], puppy);
  assert.equal(job.result.artifacts[0].sha256, digest(puppy)); assert.equal(job.delivery.state, 'sent');
  assert.deepEqual(Buffer.from(f.sent[0].message.find(part => part.type === 'image').data.base64, 'base64'), puppy);
  assert.deepEqual(fs.readFileSync(path.join(created.cwd, 'puppy.png')), puppy);
  assertImageMemory(f, job, puppy, 'sent');
});

test('cancellation after native file creation still archives the image without sending or rerunning', async t => {
  const started = Promise.withResolvers(), released = Promise.withResolvers(); let runs = 0;
  const f = fixture(t, async input => {
    assert(input.imageMemoryTools.some(tool => tool.name === 'wechat_generated_image_memory'));
    runs++; await input.onSession('native-cancelled-image', { native: true });
    fs.writeFileSync(path.join(input.cwd, 'puppy.png'), puppy); started.resolve(); await released.promise; input.signal.throwIfAborted();
  });
  const created = f.channel.work.create(scope, '生成一张小狗图片'); await started.promise;
  f.channel.work.cancel(created.id, scope); released.resolve(); await f.channel.work.whenIdle();
  const job = new WorkStore(f.store).get(created.id); assert.equal(job.state, 'cancelled'); assert.equal(job.delivery.state, 'suppressed');
  assertSaved(job, job.imageArchives[0], puppy); assert.equal(f.sent.length, 0); assert.equal(runs, 1);
  assertImageMemory(f, job, puppy, 'not-confirmed');
});

test('changed registered image retains both versions while stale delivery stops before the text', async t => {
  const f = fixture(t, async input => {
    fs.writeFileSync(path.join(input.cwd, 'puppy.png'), puppy);
    const artifact = readWorkArtifact(input.cwd, 'puppy.png').metadata;
    await input.onOperation({ tool: 'wechat_work_output', result: { ok: true, artifacts: [artifact] } });
    fs.writeFileSync(path.join(input.cwd, 'puppy.png'), changedPuppy);
    return { text: '等待回传', artifacts: [artifact] };
  });
  const job = await f.start(); assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'failed'); assert.equal(f.sent.length, 0);
  assert.equal(job.result.artifacts[0].sha256, digest(puppy)); assert.equal(job.imageArchives.length, 2);
  assertSaved(job, job.imageArchives.find(value => value.sha256 === digest(puppy)), puppy);
  assertSaved(job, job.imageArchives.find(value => value.sha256 === digest(changedPuppy)), changedPuppy);
  assert.equal(new Set(job.imageArchives.map(value => value.path)).size, 2); new WorkStore(f.store);
});

test('continuing a task does not archive its unchanged old image as a new generation', async t => {
  let runs = 0;
  const f = fixture(t, async input => {
    if (++runs > 1) return { text: '旧图片保持原样，检查已完成。' };
    fs.writeFileSync(path.join(input.cwd, 'puppy.png'), puppy);
    return { text: '图片已生成', artifacts: [readWorkArtifact(input.cwd, 'puppy.png').metadata] };
  });
  const first = await f.start(), second = await f.start('只检查原图，不重新生成', first.id);
  assert.equal(first.imageArchives.length, 1); assert.equal(second.imageArchives, undefined);
  assert.equal(second.folder, first.folder); assertSaved(first, first.imageArchives[0], puppy);
  assertImageMemory(f, first, puppy, 'sent');
  assert.equal(f.channel.imageMemory.list({ ...scope, collection: 'generated' }).storedCount, 1);
});

test('archive directory junctions fail visibly while retaining and delivering the task original', async t => {
  const f = fixture(t, async input => {
    fs.writeFileSync(path.join(input.cwd, 'puppy.png'), puppy);
    return { text: '图片已生成', artifacts: [readWorkArtifact(input.cwd, 'puppy.png').metadata] };
  });
  const outside = path.join(f.root, 'outside'), archiveRoot = path.join(f.store.storageSettings().workspacePath, '微信agent/generated-images');
  fs.mkdirSync(outside); fs.mkdirSync(path.dirname(archiveRoot), { recursive: true }); fs.symlinkSync(outside, archiveRoot, 'junction');
  const job = await f.start(); assert.equal(job.state, 'succeeded'); assert.equal(job.delivery.state, 'sent');
  assert.equal(job.imageArchives[0].state, 'failed'); assert.match(job.imageArchives[0].error.message, /目录链接/);
  assert.deepEqual(fs.readdirSync(outside), []); assert.deepEqual(fs.readFileSync(path.join(job.cwd, 'puppy.png')), puppy); new WorkStore(f.store);
});

test('preexisting different archive contents are never overwritten and repeated saving is idempotent', t => {
  const f = fixture(t), job = f.directJob('abcdef012345'); fs.writeFileSync(path.join(job.cwd, 'puppy.png'), puppy);
  const existing = path.join(job.workspaceRoot, `微信agent/generated-images/${job.id}/puppy.png`);
  fs.mkdirSync(path.dirname(existing), { recursive: true }); fs.writeFileSync(existing, changedPuppy);
  const artifact = readWorkArtifact(job.cwd, 'puppy.png').metadata, [saved] = archiveWorkImages(job, job.cwd, [artifact]);
  assertSaved(job, saved, puppy); assert.notEqual(path.join(job.workspaceRoot, saved.path), existing); assert.deepEqual(fs.readFileSync(existing), changedPuppy);
  job.imageArchives = [saved]; const again = archiveWorkImages(job, job.cwd, [artifact]);
  assert.deepEqual(mergeImageArchives(job.imageArchives, again), [saved]);
  assert.equal(fs.readdirSync(path.dirname(existing)).length, 2);
});

test('an original image above 20 MiB keeps exact bytes in generated memory and uses a file attachment automatically', async t => {
  const f = fixture(t), job = f.directJob('abcdef012346'), large = image(200, 21 * 1024 * 1024 + 1);
  fs.writeFileSync(path.join(job.cwd, 'large.png'), large);
  const artifact = readWorkArtifact(job.cwd, 'large.png').metadata;
  const [saved] = archiveWorkImages(job, job.cwd, [artifact]); assertSaved(job, saved, large);
  assert.equal(saved.kind, 'file'); assert.equal(artifact.path, 'large.png'); assert.equal(saved.bytes, large.length);
  const generated = { ...job, ...scope, operations: [], imageArchives: [saved], request: '合成大图', createdAt: Date.now() };
  assert.equal((await f.channel.work.generatedImages.captureJob(generated)).saved, 1);
  const item = assertImageMemory(f, job, large, 'not-confirmed');
  assert(item.hasThumbnail, item.thumbnailError);
  await assert.rejects(f.channel.imageMemory.capture(scope, { messageId: 'large-received' },
    { resourceId: 'large-received' }, { data: large.toString('base64'), mediaType: 'image/png', quality: 'original' }), { code: 'IMAGE_MEMORY_INVALID' });
});
