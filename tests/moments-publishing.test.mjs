import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore, MomentsAutomation, MomentsService, MomentsPublishing, momentsPlanSettings, momentsPublishingSettings, momentsLocalInstant,
  nextMomentsOccurrence, similarMomentsText, momentsPublishingTools, createPluginService, rpcHandler, ChannelError } from '../lib/testing.js';
const accountId = 'publishing-bot', scope = { accountId, chatType: 'private', peerId: 'alice', senderId: 'alice' };
const utc = value => Date.parse(value + 'Z'), signal = () => new AbortController().signal;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-publishing-')), store = new StateStore(root), models = [], writes = [], searches = [], images = [];
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: [], prompt: '' });
  const config = store.config.snapshot(store.data); config.remote = { globalAdminIds: ['alice'] }; store.config.commit(config);
  for (const peerId of ['alice', 'bob']) store.setConversationSettings(accountId, 'private', peerId, { ...store.conversationSettings(accountId, 'private', peerId), remoteEnabled: true });
  let clock = utc('2026-11-10T00:59:00'), serial = 10;
  const status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true, momentsAudienceReady: true };
  const audience = { accountId, membershipComplete: true, source: 'wechat-contacts-live', fetchedAt: new Date(clock).toISOString(), unavailableCount: 0,
    contacts: [{ id: 'alice', name: 'Alice', labelIds: ['1'] }], labels: [{ id: '1', name: '同事', userIds: ['alice'], memberCount: 1 }] };
  const png = fs.readFileSync(path.join(import.meta.dirname, '../assets/stickers', fs.readdirSync(path.join(import.meta.dirname, '../assets/stickers'), { recursive: true }).find(file => file.endsWith('.png'))));
  const channel = { now: () => clock, store, transport: { status: () => status,
    readMomentsAudience: async () => structuredClone(audience),
    writeMoments: async args => { writes.push(args); return { accountId, action: 'publish', postId: String(++serial), text: args.query.text, imageCount: args.query.images?.length ?? 0, delivery: 'server-ack',
      ...(args.query.blockedLabelIds?.length || args.query.blockedUserIds?.length ? { audienceConfirmed: true, audienceSource: audience.source, audienceFetchedAt: audience.fetchedAt,
        audienceSelection: { blockedLabelIds: args.query.blockedLabelIds, blockedUserIds: args.query.blockedUserIds }, blockedLabelIds: args.query.blockedLabelIds, blockedUserIds: ['alice'] } : {}) }; } },
    runner: { run: async input => { models.push(input); const data = JSON.parse(input.text); return { text: JSON.stringify({ theme: data.themes[0], text: '今天的小笑话编号' + models.length + '：冰箱里为什么不热闹？因为大家都很冷静。', imagePrompt: data.image ? '一只开心的卡通小狗，无文字' : '' }) }; },
      search: { forConfig: () => ({ search: async args => { searches.push(args); return { content: '公开搜索材料', sources: [{ title: '公开资料', url: 'https://example.com/fact', snippet: '有来源的事实' }] }; } }) } },
    work: { imageGeneration: { catalog: () => ({ enabled: true, defaultProviderId: '0809', providers: [{ providerId: '0809', defaultModel: 'image-default' }] }),
      generate: async input => { images.push(input); return { bytes: png, extension: '.png', providerName: '0809', model: input.model }; } } } };
  channel.moments = new MomentsService(channel); channel.momentsAutomation = new MomentsAutomation(channel);
  const manager = channel.momentsAutomation.publishing, advance = ms => { clock += ms; };
  const configure = () => { manager.configure(accountId, { enabled: true, minGapMinutes: 0, maxPostsPer24Hours: 24 }); manager.stopped = false; };
  const plan = async settings => { await manager.savePlan(accountId, { enabled: true, ...settings }, undefined, 'plan-' + ++serial, signal()); return manager.list(accountId).plans.at(-1); };
  t.after(async () => { await manager.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-moments-publishing-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, channel, manager, status, models, writes, searches, images, configure, plan, advance, now: () => clock };
}

test('calendar validates dates, hours, limits, timezone and duplicate slots', () => {
  assert.equal(momentsPublishingSettings().enabled, false);
  for (const value of [{ maxPostsPer24Hours: 0 }, { minGapMinutes: -1 }, { enabled: 'true' }, { unknown: true }]) assert.throws(() => momentsPublishingSettings(value));
  for (const value of [{ themes: [] }, { maxChars: 29 }, { graceMinutes: 0 }, { schedule: { timezone: 'invalid-zone' } }, { schedule: { times: ['25:00'] } },
    { schedule: { type: 'once', onceAt: '2026-02-30T09:00' } }, { schedule: { type: 'weekly', weekdays: [] } }, { image: { mode: 'video' } }, { extra: true }]) assert.throws(() => momentsPlanSettings(value));
  const plan = momentsPlanSettings({ themes: [' A ', 'A'], schedule: { times: ['18:00', '09:00', '09:00'] } });
  assert.deepEqual(plan.themes, ['A']); assert.deepEqual(plan.schedule.times, ['09:00', '18:00']);
  assert.equal(nextMomentsOccurrence(plan, utc('2026-11-10T01:00:00')), utc('2026-11-10T10:00:00'));
  assert.equal(momentsLocalInstant('2026-11-10T09:00', 'Asia/Shanghai'), utc('2026-11-10T01:00:00'));
});
test('weekly and once calendars cross month/year boundaries without repeating a slot', () => {
  const weekly = momentsPlanSettings({ schedule: { type: 'weekly', weekdays: [1, 7], times: ['09:00'] } });
  assert.equal(nextMomentsOccurrence(weekly, utc('2026-12-31T12:00:00')), utc('2027-01-03T01:00:00'));
  const once = momentsPlanSettings({ schedule: { type: 'once', onceAt: '2026-11-10T09:00' } }), at = utc('2026-11-10T01:00:00');
  assert.equal(nextMomentsOccurrence(once, at - 1), at); assert.equal(nextMomentsOccurrence(once, at), 0);
});
test('DST skips absent times and publishes at most one occurrence on a repeated wall-clock hour', () => {
  assert.equal(momentsLocalInstant('2026-03-08T02:30', 'America/New_York'), null);
  const spring = momentsPlanSettings({ schedule: { timezone: 'America/New_York', times: ['02:30'] } });
  assert.equal(nextMomentsOccurrence(spring, utc('2026-03-08T05:00:00')), utc('2026-03-09T06:30:00'));
  const fall = momentsPlanSettings({ schedule: { timezone: 'America/New_York', times: ['01:30'] } }), first = nextMomentsOccurrence(fall, utc('2026-11-01T00:00:00'));
  assert(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'].includes(new Date(first).toISOString()));
  assert.equal(nextMomentsOccurrence(fall, first), utc('2026-11-02T06:30:00'));
});
test('disabled defaults and saving a future plan do not call AI or publish', async t => {
  const f = fixture(t); await f.plan(); f.advance(60000); await f.manager.tick(); assert.equal(f.models.length, 0);
  f.configure(); await f.manager.tick(); assert.equal(f.writes.length, 1);
  assert.equal(f.models[0].mode, 'moments-publish'); assert.equal(f.models[0].allowEmptyReply,true); assert.deepEqual(f.models[0].tools, []); assert(f.models[0].systemOverride.includes('外部材料')); assert(f.models[0].systemOverride.includes('中文'));
});
test('concurrent ticks and restart reuse the consumed occurrence, with one AI call and one confirmed post', async t => {
  const f = fixture(t); f.configure(); await f.plan(); f.advance(60000); await Promise.all([f.manager.tick(), f.manager.tick()]);
  assert.equal(f.writes.length, 1); assert.equal(f.models.length, 1); assert.equal(f.manager.list(accountId).runs[0].state, 'published');
  const restart = new MomentsPublishing(f.channel); restart.stopped = false; await restart.tick(); assert.equal(f.writes.length, 1);
  assert.equal(f.manager.list('other').runs.length, 0); assert.equal(f.manager.list('other').plans.length, 0);
});
test('offline expiration is recorded as skipped and recovery never catches up multiple old slots', async t => {
  const f = fixture(t); f.configure(); await f.plan({ schedule: { times: ['09:00', '10:00'] }, graceMinutes: 10 });
  f.status.online = false; f.advance(86400000); await f.manager.tick(); assert.equal(f.models.length, 0);
  f.status.online = true; await f.manager.tick(); assert.equal(f.manager.list(accountId).runs[0].state, 'skipped'); assert.equal(f.models.length, 0);
  assert(f.manager.list(accountId).plans[0].nextRunAt > f.now());
});
test('account change and global pause stop generation before any write', async t => {
  for (const action of ['account', 'pause']) {
    const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); f.configure(); await f.plan(); f.advance(60000);
    const run = f.channel.runner.run; f.channel.runner.run = async input => { entered.resolve(); await release.promise; return run(input); };
    const pending = f.manager.tick(); await entered.promise;
    if (action === 'account') f.status.account.id = 'other'; else f.store.configure(accountId, { ...f.store.settings(accountId), enabled: false });
    release.resolve(); await pending; assert.equal(f.writes.length, 0); assert.equal(f.manager.list(accountId).runs[0].state, 'failed');
  }
});
test('plan edits, disabling and removal cancel an in-flight generation; its slot stays consumed', async t => {
  for (const action of ['edit', 'disable', 'delete']) {
    const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers(); f.configure(); const plan = await f.plan(); f.advance(60000);
    const run = f.channel.runner.run; f.channel.runner.run = async input => { entered.resolve(); await release.promise; return run(input); };
    const pending = f.manager.tick(); await entered.promise;
    if (action === 'edit') await f.manager.savePlan(accountId, { ...plan.settings, style: '新风格' }, plan.id, 'edit', signal());
    else if (action === 'disable') f.manager.setEnabled(accountId, plan.id, false); else f.manager.removePlan(accountId, plan.id);
    release.resolve(); await pending; assert.equal(f.writes.length, 0); assert.equal(f.manager.list(accountId).runs[0].state, 'failed');
  }
});
test('scheduled review creates a durable draft, edits it and explicit publish is idempotent', async t => {
  const f = fixture(t); f.configure(); await f.plan({ reviewRequired: true }); f.advance(60000); await f.manager.tick();
  const draft = f.manager.list(accountId).runs[0]; assert.equal(draft.state, 'draft'); assert.equal(f.writes.length, 0);
  f.manager.editDraft(accountId, draft.id, '修改后的一个小笑话。'); await f.manager.publishDraft(accountId, draft.id, signal()); await f.manager.publishDraft(accountId, draft.id, signal());
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.text, '修改后的一个小笑话。');
  let allowed = false; await assert.rejects(f.manager.publishDraft(accountId, draft.id, signal(), () => { if (!allowed) throw Error('权限已撤销'); }));
});
test('previews reuse a stable operation; failed or discarded previews never generate automatically again', async t => {
  const f = fixture(t), first = await f.manager.preview(accountId, {}, 'preview', signal()), second = await f.manager.preview(accountId, {}, 'preview', signal());
  assert.equal(first.id, second.id); assert.equal(f.models.length, 1); assert.equal(f.writes.length, 0); assert.equal(first.query, undefined);
  f.manager.discard(accountId, first.id); assert.equal((await f.manager.preview(accountId, {}, 'preview', signal())).state, 'discarded');
  await assert.rejects(f.manager.preview(accountId, { themes: ['不同'] }, 'preview', signal()));
  f.channel.runner.run = async () => { throw new Error('AI 不可用'); };
  await assert.rejects(f.manager.preview(accountId, {}, 'failure', signal())); assert.equal((await f.manager.preview(accountId, {}, 'failure', signal())).state, 'failed');
});
test('invalid AI JSON, changed themes, excess length and duplicates never submit', async t => {
  const f = fixture(t); const invalid = ['', 'not json', JSON.stringify({ theme: '错误主题', text: '正文', imagePrompt: '' }), JSON.stringify({ theme: '日常心情与小笑话', text: '长'.repeat(301), imagePrompt: '' })];
  for (const [i, text] of invalid.entries()) { f.channel.runner.run = async () => ({ text }); await assert.rejects(f.manager.preview(accountId, {}, 'invalid-' + i, signal()), error => error.code === 'MOMENTS_CONTENT_INVALID'); }
  f.channel.runner.run = async () => ({ text: JSON.stringify({ theme: '日常心情与小笑话', text: '完全相同的笑话', imagePrompt: '' }) });
  f.channel.momentsAutomation.remember(accountId, [{ id: '77', author: { userId: accountId }, createdAt: f.now() / 1000, text: '完全相同的笑话' }]);
  await assert.rejects(f.manager.preview(accountId, {}, 'duplicate', signal()), error => error.code === 'MOMENTS_CONTENT_DUPLICATE'); assert.equal(f.writes.length, 0);
  assert(similarMomentsText('你好，今天！', '你好今天')); assert(!similarMomentsText('短文甲', '短文乙'));
});
test('unknown and rejected submissions do not retry; an unknown scheduled post pauses the plan after restart', async t => {
  for (const delivery of ['unknown', 'rejected']) {
    const f = fixture(t); f.configure(); const plan = await f.plan(); f.advance(60000);
    f.channel.transport.writeMoments = async args => { f.writes.push(args); throw new ChannelError('WECHAT_WRITE', '没有成功回执', { snsDelivery: delivery }); };
    await f.manager.tick(); const run = f.manager.list(accountId).runs[0]; assert.equal(run.state, delivery); assert.equal(f.writes.length, 1);
    await assert.rejects(f.manager.publishDraft(accountId, run.id, signal()));
    const restart = new MomentsPublishing(f.channel); restart.stopped = false; await restart.tick(); assert.equal(f.writes.length, 1);
    if (delivery === 'unknown') { assert.equal(restart.plan(accountId, plan.id).settings.enabled, false); assert.equal(restart.reconcile(accountId, run.id).confirmed, false); }
  }
});
test('saved successful ACK survives cancellation and a sending record is recovered by read-only reconciliation', async t => {
  const f = fixture(t), draft = await f.manager.preview(accountId, {}, 'ack', signal()), original = f.channel.transport.writeMoments;
  let allowed = true; f.channel.transport.writeMoments = async args => { const result = await original(args); allowed = false; return result; };
  await assert.rejects(f.manager.publishDraft(accountId, draft.id, signal(), () => { if (!allowed) throw Error('已取消'); }));
  assert.equal(f.manager.list(accountId).runs[0].state, 'published'); assert.equal(f.writes.length, 1);
  const run = f.manager.run(accountId, draft.id), query = f.writes[0].query; run.state = 'sending'; run.query = query; f.manager.save();
  const restart = new MomentsPublishing(f.channel); assert.equal(restart.run(accountId, run.id).state, 'unknown');
  assert.equal(restart.reconcile(accountId, run.id).confirmed, true); assert.equal(f.writes.length, 1);
  assert.throws(() => f.channel.moments.lookupOwnerReceipt({ ...query, text: '篡改正文' }, accountId, run.requestId));
});
test('24h cap and minimum gap wait without calling AI and expired waiting slots are skipped', async t => {
  const f = fixture(t); f.configure(); await f.plan({ schedule: { times: ['09:00', '09:01', '09:02'] }, graceMinutes: 2 }); f.advance(60000); await f.manager.tick();
  f.manager.configure(accountId, { enabled: true, minGapMinutes: 10, maxPostsPer24Hours: 2 }); f.advance(60000); await f.manager.tick();
  assert(f.manager.list(accountId).plans[0].waitingReason.includes('间隔')); assert.equal(f.models.length, 1);
  f.manager.configure(accountId, { enabled: true, minGapMinutes: 0, maxPostsPer24Hours: 1 }); await f.manager.tick(); assert(f.manager.list(accountId).plans[0].waitingReason.includes('上限'));
  f.advance(180000); await f.manager.tick(); assert(f.manager.list(accountId).runs.some(run => run.state === 'skipped')); assert.equal(f.models.length, 1);
});
test('AI images use 0809 by default, preview safely and retain byte integrity through publication', async t => {
  const f = fixture(t), draft = await f.manager.preview(accountId, { image: { mode: 'ai' } }, 'image', signal());
  assert.equal(f.images[0].providerId, '0809'); assert.equal(draft.hasImage, true); assert.equal(draft.image.path, undefined); assert.equal(draft.query, undefined);
  const content = f.manager.contentImage(accountId, draft.id); assert.equal(content.mediaType, 'image/png');
  await f.manager.publishDraft(accountId, draft.id, signal()); assert.equal(f.writes[0].query.images[0].data, content.data);
  const other = await f.manager.preview(accountId, { image: { mode: 'ai' } }, 'tamper', signal());
  fs.appendFileSync(path.join(f.root, f.manager.run(accountId, other.id).image.path), 'changed');
  await assert.rejects(f.manager.publishDraft(accountId, other.id, signal()), error => error.code === 'MOMENTS_IMAGE_CHANGED'); assert.equal(f.writes.length, 1);
});
test('failed images do not fall back, repeat charge or publish a text-only post', async t => {
  const f = fixture(t); f.configure(); await f.plan({ image: { mode: 'ai' } }); f.advance(60000);
  f.channel.work.imageGeneration.generate = async input => { f.images.push(input); throw new ChannelError('IMAGE_EMPTY', '生图为空'); };
  await f.manager.tick(); const run = f.manager.list(accountId).runs[0]; assert.equal(run.state, 'failed'); assert(run.text); assert.equal(f.writes.length, 0);
  await assert.rejects(f.manager.publishDraft(accountId, run.id, signal()), error => error.code === 'MOMENTS_IMAGE_UNAVAILABLE'); await f.manager.tick(); assert.equal(f.images.length, 1);
});
test('research passes only public topics to search and fails closed without verified sources', async t => {
  const f = fixture(t); await f.manager.preview(accountId, { research: true, researchQuery: '公开科技新闻' }, 'research', signal());
  assert.equal(f.searches[0].query, '公开科技新闻'); const request = JSON.parse(f.models[0].text); assert.equal(request.research.sources.length, 1); assert.deepEqual(f.models[0].tools, []);
  f.channel.runner.search.forConfig = () => ({ search: async () => ({ content: '无来源', sources: [] }) });
  await assert.rejects(f.manager.preview(accountId, { research: true }, 'empty-research', signal()), error => error.code === 'MOMENTS_RESEARCH_EMPTY'); assert.equal(f.writes.length, 0);
});
test('plans validate actual audience IDs and publish the saved selection', async t => {
  const f = fixture(t); f.configure(); await assert.rejects(f.plan({ blockedLabelIds: ['99'] }));
  await f.plan({ blockedLabelIds: ['1'], blockedUserIds: ['alice'] }); f.advance(60000); await f.manager.tick();
  assert.deepEqual(f.writes[0].query.blockedLabelIds, ['1']); assert.equal(f.manager.list(accountId).runs[0].state, 'published');
});
test('bad durable state disables only publishing and preserves original bytes', async t => {
  const f = fixture(t), file = f.manager.file(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{broken');
  const broken = new MomentsPublishing(f.channel); broken.start(); await broken.tick(); assert(broken.error); assert.equal(fs.readFileSync(file, 'utf8'), '{broken'); assert.equal(f.channel.closed, undefined);
});
test('late AI completion retains its text, avoids image charges and does not publish an expired slot', async t => {
  const f = fixture(t); f.configure(); await f.plan({ graceMinutes: 1, image: { mode: 'ai' } }); f.advance(60000);
  const original = f.channel.runner.run; f.channel.runner.run = async input => { const value = await original(input); f.advance(120000); return value; };
  await f.manager.tick(); const run = f.manager.list(accountId).runs[0]; assert.equal(run.state,'failed'); assert(run.text); assert(run.error.includes('超过'));
  assert.equal(f.images.length,0); assert.equal(f.writes.length,0); await f.manager.tick(); assert.equal(f.models.length,1);
});
test('partial plan edits keep timing, review and audience settings; tampered durable media records stop publishing', async t => {
  const f=fixture(t), plan=await f.plan({schedule:{type:'weekly',weekdays:[2],times:['12:00']},reviewRequired:true,blockedLabelIds:['1']});
  await f.manager.savePlan(accountId,{themes:['新主题']},plan.id,'edit',signal()); const updated=f.manager.plan(accountId,plan.id);
  assert.deepEqual(updated.settings.schedule,plan.settings.schedule); assert.equal(updated.settings.reviewRequired,true); assert.deepEqual(updated.settings.blockedLabelIds,['1']);
  f.manager.configure(accountId,{enabled:false,maxPostsPer24Hours:7,minGapMinutes:45});f.manager.configure(accountId,{enabled:true});
  assert.equal(f.manager.list(accountId).settings.maxPostsPer24Hours,7);assert.equal(f.manager.list(accountId).settings.minGapMinutes,45);
  const once=await f.plan({schedule:{type:'once',onceAt:'2026-11-10T12:00'}});
  await f.manager.savePlan(accountId,{schedule:{type:'once'}},once.id,'once-partial',signal());assert.equal(f.manager.plan(accountId,once.id).settings.schedule.onceAt,'2026-11-10T12:00');
  await assert.rejects(f.manager.savePlan(accountId,{schedule:null},plan.id,'null-edit',signal()));
  await assert.rejects(f.manager.savePlan(accountId,{schedule:{timezone:'invalid'}},plan.id,'invalid-edit',signal()));
  const draft=await f.manager.preview(accountId,{image:{mode:'ai'}},'tampered-state',signal());
  f.manager.run(accountId,draft.id).image.path='../outside.png'; f.manager.save();
  const bytes=fs.readFileSync(f.manager.file()),restart=new MomentsPublishing(f.channel);assert(restart.error);assert.deepEqual(fs.readFileSync(f.manager.file()),bytes);
});
test('owner RPC checks identity, account, operation ID and can manage previews and drafts without publishing', async t => {
  const f = fixture(t), service = createPluginService({ root: f.root, store: f.store, worker: f.channel.transport, channel: f.channel }), rpc = rpcHandler(service), owner = { principal: { kind: 'owner' } };
  const payload = { accountId, settings: {}, requestId: 'ui-moments-12345678-1234-1234-1234-123456789012' };
  assert.equal((await rpc('moments.plans.preview', payload, signal(), { principal: { kind: 'remote' } })).ok, false);
  assert.equal((await rpc('moments.plans.preview', { ...payload, accountId: 'other' }, signal(), owner)).ok, false);
  assert.equal((await rpc('moments.plans.preview', { ...payload, requestId: 'fake' }, signal(), owner)).ok, false); assert.equal(f.models.length, 0);
  const result = await rpc('moments.plans.preview', payload, signal(), owner); assert(result.ok); assert.equal(result.value.state, 'draft'); assert.equal(f.writes.length, 0);
  assert.equal((await rpc('moments.drafts.edit', { accountId, id: result.value.id, text: '改过的草稿' }, signal(), owner)).ok, true);
  assert.equal((await rpc('moments.drafts.discard', { accountId, id: result.value.id }, signal(), owner)).ok, true); await service.drain();
});
test('model plan and draft tools bind actual administrator and stable message operation IDs', async t => {
  const f = fixture(t), operations = [], tools = momentsPublishingTools({ manage: (args, abort, key) => f.channel.moments.managePublishing(args, scope, 'message', abort, () => {}, key), onOperation: op => operations.push(op) });
  const plan = tools.find(tool => tool.name === 'wechat_moments_plan'), draft = tools.find(tool => tool.name === 'wechat_moments_draft'), exec = { signal: signal() };
  assert.equal(JSON.parse(await plan.execute({ action: 'save', settings: { themes: ['小笑话'] }, operationKey: 'first' }, exec)).ok, true);
  await plan.execute({ action: 'save', settings: { themes: ['小笑话'] }, operationKey: 'first' }, exec); assert.equal(f.manager.list(accountId).plans.length, 1);
  await plan.execute({ action: 'save', settings: { themes: ['科技'] }, operationKey: 'second' }, exec); assert.equal(f.manager.list(accountId).plans.length, 2);
  const preview = JSON.parse(await draft.execute({ action: 'preview', settings: {} }, exec)); assert(preview.ok); assert.equal(f.writes.length, 0);
  assert.equal(JSON.parse(await draft.execute({ action: 'list', text: '无效字段' }, exec)).ok, false);
  assert.equal(JSON.parse(await plan.execute({ action: 'enable', id: 'fake', enabled: true }, exec)).ok, false);
  assert.equal(operations[0].tool, 'wechat_moments_plan'); assert.match(operations[0].inputHash, /^[a-f0-9]{64}$/);
  await assert.rejects(f.channel.moments.managePublishing({ action: 'list' }, { ...scope, peerId: 'bob', senderId: 'bob' }, 'forged', signal()), error => error.code === 'REMOTE_NOT_AUTHORIZED');
});
