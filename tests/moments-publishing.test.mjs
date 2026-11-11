import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StateStore, MomentsAutomation, MomentsService, MomentsPublishing, momentsPlanSettings, momentsPublishingSettings, momentsLocalInstant,
  nextMomentsOccurrence, similarMomentsText, momentsPublishingTools, createPluginService, rpcHandler, ChannelError } from '../lib/testing.js';
import { ownerPublicationRecord } from '../modules/moments/publication-recovery.mjs';
import { MOMENTS_PUBLISH_TIMEOUT_MS, MOMENTS_TEXT_FALLBACK_RESERVE_MS } from '../shared/moments-publishing.mjs';
const accountId = 'publishing-bot', scope = { accountId, chatType: 'private', peerId: 'alice', senderId: 'alice' };
const utc = value => Date.parse(value + 'Z'), signal = () => new AbortController().signal;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-publishing-')), store = new StateStore(root), models = [], reviews = [], writes = [], searches = [], images = [];
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
    runner: { run: async input => {
      if (input.mode === 'moments-content-review') { reviews.push(input); return { text: '{"ok":true,"reason":""}' }; }
      models.push(input); const data = JSON.parse(input.text); return { text: JSON.stringify({ theme: data.themes[0] || '日常小观察', text: '今天的小笑话编号' + models.length + '：冰箱里为什么不热闹？因为大家都很冷静。', imagePrompt: data.image ? '一只开心的卡通小狗，无文字' : '' }) }; },
      search: { forConfig: () => ({ search: async args => { searches.push(args); return { content: '公开搜索材料', sources: [{ title: '公开资料', url: 'https://example.com/fact', snippet: '有来源的事实' }] }; } }) } },
    work: { imageGeneration: { catalog: () => ({ enabled: true, defaultProviderId: '0809', providers: [{ providerId: '0809', defaultModel: 'image-default' }] }),
      generate: async input => { images.push(input); return { bytes: png, extension: '.png', providerName: '0809', model: input.model }; } } } };
  channel.moments = new MomentsService(channel); channel.momentsAutomation = new MomentsAutomation(channel);
  const manager = channel.momentsAutomation.publishing, advance = ms => { clock += ms; };
  const configure = () => { manager.configure(accountId, { enabled: true, minGapMinutes: 0, maxPostsPer24Hours: 24 }); manager.stopped = false; };
  const plan = async settings => { await manager.savePlan(accountId, { enabled: true, ...settings }, undefined, 'plan-' + ++serial, signal()); return manager.list(accountId).plans.at(-1); };
  t.after(async () => { await manager.close(); const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(resolved), /^wechat-moments-publishing-/); fs.rmSync(resolved, { recursive: true, force: true }); });
  return { root, store, channel, manager, status, models, reviews, writes, searches, images, configure, plan, advance, now: () => clock };
}

function timedFixture(t) {
  const f = fixture(t), deadlines = [], advance = f.advance;
  // AbortSignal.timeout uses native timers, so drive its deadlines explicitly.
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController(); deadlines.push({ controller, at: f.now() + milliseconds }); return controller.signal;
  });
  f.advance = milliseconds => {
    advance(milliseconds);
    for (const { controller, at } of deadlines) if (at <= f.now() && !controller.signal.aborted)
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  };
  return f;
}

test('proposal review rejects mismatched content before image generation and preserves the draft', async t => {
  const f = fixture(t), original = f.channel.runner.run;
  f.channel.runner.run = async input => input.mode === 'moments-content-review'
    ? { text: '{"ok":false,"reason":"机器人计费与湖景无具体关联，正文还混入配图制作说明"}' } : original(input);
  await assert.rejects(f.manager.preview(accountId, { image: { mode: 'ai' } }, 'bad-proposal', signal()), { code: 'MOMENTS_CONTENT_MISMATCH' });
  const draft = f.manager.list(accountId).runs[0]; assert(draft.text); assert.equal(draft.state, 'failed');
  assert.equal(f.models.length, 1); assert.equal(f.images.length, 0); assert.equal(f.writes.length, 0);
  await f.manager.preview(accountId, { image: { mode: 'ai' } }, 'bad-proposal', signal()); assert.equal(f.models.length, 1);
});

test('a mismatched rendered image is omitted and the standalone text is reviewed before publication', async t => {
  const f = fixture(t), original = f.channel.runner.run;
  f.channel.runner.run = async input => {
    if (input.mode === 'moments-content-review' && JSON.parse(input.text).phase === 'image') {
      assert.equal(input.images.length, 1); assert(input.images[0].data); assert.deepEqual(input.tools, []);
      return { text: '{"ok":false,"reason":"实际图片没有正文所述内容"}' };
    }
    return original(input);
  };
  const draft = await f.manager.preview(accountId, { image: { mode: 'ai' } }, 'bad-render', signal());
  assert.equal(f.images.length, 1); assert.equal(f.writes.length, 0); assert.equal(draft.hasImage, false); assert.equal(draft.textOnly, true);
  assert(f.reviews.some(row => JSON.parse(row.text).phase === 'text-only'));
  await f.manager.publishDraft(accountId, draft.id, signal());
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.images, undefined);
});

test('a successful image review is reused only for the same text and exact saved image', async t => {
  const f = fixture(t), draft = await f.manager.preview(accountId, { image: { mode: 'ai' } }, 'reviewed', signal());
  assert.equal(f.reviews.length, 2); assert.deepEqual(f.reviews.map(row => JSON.parse(row.text).phase), ['proposal', 'image']);
  await f.manager.publishDraft(accountId, draft.id, signal()); assert.equal(f.reviews.length, 2); assert.equal(f.writes.length, 1);
});

test('a missing saved image falls back to the reviewed text with the original audience and one submission', async t => {
  const f = fixture(t), draft = await f.manager.preview(accountId, { image: { mode: 'ai' }, blockedUserIds: ['alice'] }, 'missing-image-file', signal());
  const saved = f.manager.data.runs[draft.id], file = path.resolve(f.root, saved.image.path);
  assert.equal(path.dirname(file), path.resolve(f.root, 'storage/moments/publishing-media'));
  fs.unlinkSync(file);
  await f.manager.publishDraft(accountId, draft.id, signal());
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.images, undefined);
  assert.deepEqual(f.writes[0].query.blockedUserIds, ['alice']);
  const published = f.manager.list(accountId).runs[0];
  assert.equal(published.state, 'published'); assert.equal(published.textOnly, true);
  assert.equal(published.fallbacks[0].code, 'MOMENTS_IMAGE_UNAVAILABLE');
  assert(!JSON.stringify(published.fallbacks).includes(f.root));
});

test('editing a draft invalidates review approval and cannot publish a rejected edit', async t => {
  const f = fixture(t), draft = await f.manager.preview(accountId, {}, 'edit-review', signal());
  f.manager.editDraft(accountId, draft.id, '配图让 AI 画一张：林间湖水。');
  const original = f.channel.runner.run; let checked = 0;
  f.channel.runner.run = async input => {
    if (input.mode === 'moments-content-review') { checked++; assert(JSON.parse(input.text).text.includes('配图让 AI'));
      return { text: '{"ok":false,"reason":"制作说明混入正文"}' }; }
    return original(input);
  };
  await assert.rejects(f.manager.publishDraft(accountId, draft.id, signal()), { code: 'MOMENTS_CONTENT_MISMATCH' });
  assert.equal(checked, 1); assert.equal(f.writes.length, 0);
});

test('legacy drafts and failed review responses cannot bypass the new publication gate', async t => {
  for (const answer of ['{"ok":false,"reason":"图文主题无关"}', 'invalid-json']) {
    const f = fixture(t), draft = await f.manager.preview(accountId, {}, 'legacy', signal());
    delete f.manager.data.runs[draft.id].contentReviews; f.manager.save();
    const restarted = new MomentsPublishing(f.channel); f.channel.runner.run = async () => ({ text: answer });
    await assert.rejects(restarted.publishDraft(accountId, draft.id, signal()), error => ['MOMENTS_CONTENT_MISMATCH', 'MOMENTS_CONTENT_REVIEW_FAILED'].includes(error.code));
    assert.equal(f.writes.length, 0); assert.equal(restarted.list(accountId).runs[0].state, 'failed');
  }
});

test('content reviews share the one-hour operation deadline', async t => {
  const f = timedFixture(t), original = f.channel.runner.run;
  f.channel.runner.run = async input => {
    if (input.mode === 'moments-content-review') { f.advance(MOMENTS_PUBLISH_TIMEOUT_MS); input.signal.throwIfAborted(); }
    return original(input);
  };
  await assert.rejects(f.manager.preview(accountId, { image: { mode: 'ai' } }, 'review-timeout', signal()), { code: 'MOMENTS_PUBLISH_TIMEOUT' });
  assert.equal(f.images.length, 0); assert.equal(f.writes.length, 0);
});

test('calendar validates dates, hours, limits, timezone and duplicate slots', () => {
  assert.equal(momentsPublishingSettings().enabled, false);
  for (const value of [{ maxPostsPer24Hours: 0 }, { minGapMinutes: -1 }, { enabled: 'true' }, { unknown: true }]) assert.throws(() => momentsPublishingSettings(value));
  assert.deepEqual(momentsPlanSettings({ themes: [] }).themes, []);
  for (const value of [{ themes: [''] }, { maxChars: 29 }, { graceMinutes: 0 }, { schedule: { timezone: 'invalid-zone' } }, { schedule: { times: ['25:00'] } },
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

for (const origin of ['preview', 'schedule']) test(`${origin} can spend more than ten minutes on research, text and images without an earlier publishing timeout`, async t => {
  const f = timedFixture(t), settings = { research: true, image: { mode: 'ai' } };
  const search = f.channel.runner.search.forConfig().search, run = f.channel.runner.run, image = f.channel.work.imageGeneration.generate;
  f.channel.runner.search.forConfig = () => ({ search: async (request, abort) => {
    f.advance(35000); abort.throwIfAborted(); return search(request, abort);
  } });
  f.channel.runner.run = async input => { f.advance(input.mode === 'moments-publish' ? 700000 : 10000); input.signal.throwIfAborted(); return run(input); };
  f.channel.work.imageGeneration.generate = async (input, abort) => { f.advance(24999); abort.throwIfAborted(); return image(input, abort); };
  if (origin === 'schedule') { f.configure(); await f.plan(settings); f.advance(60000); await f.manager.tick(); }
  else await f.manager.preview(accountId, settings, 'slow-preview', signal());
  const result = f.manager.list(accountId).runs[0];
  assert.equal(result.state, origin === 'schedule' ? 'published' : 'draft'); assert.equal(result.hasImage, true);
  assert.equal(f.searches.length, 1); assert.equal(f.models.length, 1); assert.equal(f.images.length, 1);
  assert.equal(f.writes.length, origin === 'schedule' ? 1 : 0);
});

test('generation aborts at one hour, records failure and never retries or publishes that occurrence', async t => {
  const f = timedFixture(t), entered = Promise.withResolvers(); f.configure(); await f.plan(); f.advance(60000);
  f.channel.runner.run = input => {
    f.models.push(input); entered.resolve(input.signal);
    return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
  };
  const pending = f.manager.tick(), abort = await entered.promise;
  f.advance(MOMENTS_PUBLISH_TIMEOUT_MS - 1); assert.equal(abort.aborted, false); assert.equal(f.writes.length, 0);
  f.advance(1); assert.equal(abort.aborted, true); assert.equal(abort.reason.name, 'TimeoutError'); await pending;
  assert.equal(f.manager.list(accountId).runs[0].state, 'failed'); assert.equal(f.writes.length, 0);
  assert.equal(f.manager.list(accountId).runs[0].errorCode, 'MOMENTS_PUBLISH_TIMEOUT');
  assert.match(f.manager.list(accountId).runs[0].error, /1 小时/);
  await f.manager.tick(); assert.equal(f.models.length, 1); assert.equal(f.writes.length, 0);
});

test('an image timeout reserves time for text-only fallback and does not repeat image generation', async t => {
  const f = timedFixture(t), entered = Promise.withResolvers(), image = f.channel.work.imageGeneration.generate;
  f.channel.work.imageGeneration.generate = (input, abort) => {
    entered.resolve(); return new Promise((resolve, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true }));
  };
  const pending = f.manager.preview(accountId, { image: { mode: 'ai' } }, 'slow-image', signal());
  await entered.promise;
  const running = f.manager.list(accountId); assert.equal(running.runs[0].stage, 'image'); assert(running.runs[0].text);
  assert.equal(running.operationStartedAt, f.now()); assert.equal(f.manager.list('another-account').operationStartedAt, null);
  f.advance(MOMENTS_PUBLISH_TIMEOUT_MS - MOMENTS_TEXT_FALLBACK_RESERVE_MS);
  const completed = await pending; assert.equal(completed.state, 'draft'); assert.equal(completed.textOnly, true);
  assert.equal(completed.fallbacks[0].kind, 'image');
  const existing = await f.manager.preview(accountId, { image: { mode: 'ai' } }, 'slow-image', signal());
  assert.equal(existing.state, 'draft'); assert(existing.text); assert.equal(f.models.length, 1); assert.equal(f.writes.length, 0);
  await f.manager.publishDraft(accountId, existing.id, signal()); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.images, undefined);
  f.channel.work.imageGeneration.generate = image;
  const retry = await f.manager.preview(accountId, { image: { mode: 'ai' } }, 'explicit-image-retry', signal());
  assert.equal(retry.state, 'draft'); assert.notEqual(retry.id, existing.id); assert.equal(f.models.length, 2);
  assert.equal(f.manager.list(accountId).runs.length, 2); assert.equal(f.writes.length, 1);
});

test('a provider timeout before the overall deadline does not falsely report one hour elapsed', async t => {
  const f = fixture(t);
  f.channel.runner.run = async () => { throw new DOMException('private provider details', 'TimeoutError'); };
  await assert.rejects(f.manager.preview(accountId, {}, 'provider-timeout', signal()), { code: 'MOMENTS_REQUEST_TIMEOUT' });
  const run = f.manager.list(accountId).runs[0]; assert.equal(run.state, 'failed');
  assert(!run.error.includes('达到 1 小时')); assert(!run.error.includes('private provider')); assert.equal(f.writes.length, 0);
});

test('late receipt timeout stays unknown and pauses the plan instead of reporting a generation failure', async t => {
  const f = timedFixture(t); f.configure(); const plan = await f.plan(); f.advance(60000);
  f.channel.transport.writeMoments = async args => { f.writes.push(args); f.advance(MOMENTS_PUBLISH_TIMEOUT_MS); throw new DOMException('private provider details', 'TimeoutError'); };
  await f.manager.tick(); const run = f.manager.list(accountId).runs[0];
  assert.equal(run.state, 'unknown'); assert.match(run.error, /结果不明/); assert(!run.error.includes('private provider'));
  assert.equal(f.manager.plan(accountId, plan.id).settings.enabled, false); await f.manager.tick(); assert.equal(f.writes.length, 1);
});

test('recent context deduplicates local receipts and fetched posts and excludes deleted content', async t => {
  const f = fixture(t); f.configure(); await f.plan(); f.advance(60000); await f.manager.tick();
  const run = f.manager.list(accountId).runs[0];
  assert.deepEqual(f.manager.recent(accountId), [run.text]);
  f.channel.momentsAutomation.remember(accountId, [{ id: run.postId, author: { userId: accountId }, text: run.text, createdAt: f.now() / 1000, deleted: true }]);
  assert.deepEqual(f.manager.recent(accountId), []);
});

test('emoji and short or long paragraphs remain valid while invisible text and duplicate symbols cannot publish', async t => {
  const f = fixture(t), theme = momentsPlanSettings().themes[0];
  const review = f.channel.runner.run;
  assert(similarMomentsText('🌤️', '🌤')); assert(!similarMomentsText('🙂', '🙃')); assert(similarMomentsText('……', '……'));
  for (const [i, text] of ['🌤️', '嗯。', '这段文字保留完整的想法。'.repeat(12) + '\n\n最后一句。'].entries()) {
    f.channel.runner.run = async input => input.mode === 'moments-content-review' ? review(input) : ({ text: JSON.stringify({ theme, text, imagePrompt: '' }) });
    assert.equal((await f.manager.preview(accountId, {}, 'length-' + i, signal())).text, text);
  }
  for (const [i, text] of ['\u200b\u200d', '\u0301', '\u0000正文'].entries()) {
    f.channel.runner.run = async input => input.mode === 'moments-content-review' ? review(input) : ({ text: JSON.stringify({ theme, text, imagePrompt: '' }) });
    await assert.rejects(f.manager.preview(accountId, {}, 'invisible-' + i, signal()), { code: 'MOMENTS_CONTENT_INVALID' });
  }
  const draft = f.manager.list(accountId).runs.find(row => row.state === 'draft');
  assert.throws(() => f.manager.editDraft(accountId, draft.id, '\u200b'), { code: 'MOMENTS_DRAFT_INVALID' });
  f.manager.editDraft(accountId, draft.id, '   🌤️   '); assert.equal(f.manager.run(accountId, draft.id).text, '🌤️');
  f.channel.momentsAutomation.remember(accountId, [{ id: '777', author: { userId: accountId }, text: '🌤', createdAt: f.now() / 1000 }]);
  await assert.rejects(f.manager.publishDraft(accountId, draft.id, signal()), { code: 'MOMENTS_CONTENT_DUPLICATE' }); assert.equal(f.writes.length, 0);
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
test('invalid AI JSON, empty themes, excess length and duplicates never submit', async t => {
  const f = fixture(t); const invalid = ['', 'not json', JSON.stringify({ theme: '', text: '正文', imagePrompt: '' }), JSON.stringify({ theme: '日常心情与小笑话', text: '长'.repeat(301), imagePrompt: '' })];
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
    if (delivery === 'unknown') { assert.equal(restart.plan(accountId, plan.id).settings.enabled, false); assert.equal((await restart.reconcile(accountId, run.id)).confirmed, false); }
  }
});
test('saved successful ACK survives cancellation and a sending record is recovered by read-only reconciliation', async t => {
  const f = fixture(t), draft = await f.manager.preview(accountId, {}, 'ack', signal()), original = f.channel.transport.writeMoments;
  let allowed = true; f.channel.transport.writeMoments = async args => { const result = await original(args); allowed = false; return result; };
  await assert.rejects(f.manager.publishDraft(accountId, draft.id, signal(), () => { if (!allowed) throw Error('已取消'); }));
  assert.equal(f.manager.list(accountId).runs[0].state, 'published'); assert.equal(f.writes.length, 1);
  const run = f.manager.run(accountId, draft.id), query = f.writes[0].query; run.state = 'sending'; run.query = query; f.manager.save();
  const restart = new MomentsPublishing(f.channel); assert.equal(restart.run(accountId, run.id).state, 'unknown');
  assert.equal((await restart.reconcile(accountId, run.id)).confirmed, true); assert.equal(f.writes.length, 1);
  assert.throws(() => f.channel.moments.lookupOwnerReceipt({ ...query, text: '篡改正文' }, accountId, run.requestId));
});

async function uncertainPublication(t, { evidence = true, labels = true } = {}) {
  const f = fixture(t), settings = { blockedLabelIds: labels ? ['1'] : [], blockedUserIds: labels ? [] : ['alice'] };
  const draft = await f.manager.preview(accountId, settings, 'uncertain-privacy', signal());
  const post = { accountId, postId: '91001', createdAt: Math.floor(f.now() / 1000), text: draft.text,
    imageCount: 0, contentAvailable: true, deleted: false, audienceComplete: true, blockedUserIds: ['alice'] };
  f.channel.transport.writeMoments = async args => {
    f.writes.push(args);
    throw new ChannelError('ERR_MOMENTS_WRITE_PROTOCOL', '微信已返回动态，屏蔽范围未确认', { snsDelivery: 'unknown', ...(evidence ? { publication: {
      accountId, postId: post.postId, createdAt: post.createdAt, textHash: createHash('sha256').update(draft.text).digest('hex'), imageCount: 0,
      submittedBlockedUserIds: ['alice'], returnedBlockedUserIds: [], audienceSelection: settings,
      audienceSource: 'wechat-contacts-live', audienceFetchedAt: new Date(f.now()).toISOString(),
    } } : {}) });
  };
  await assert.rejects(f.manager.publishDraft(accountId, draft.id, signal()));
  const reads = [];
  f.channel.transport.readMomentsPublication = async args => { reads.push(args); return structuredClone(post); };
  return { ...f, draft, post, reads, run: f.manager.run(accountId, draft.id) };
}

test('a matching publication with uncertain privacy retains its exact snapshot and reconciles through reads without republishing', async t => {
  const f = await uncertainPublication(t), models = f.models.length;
  assert.equal(f.run.state, 'published-unverified'); assert.equal(f.run.postId, f.post.postId);
  const saved = ownerPublicationRecord(f.channel, f.run.query, accountId, f.run.requestId);
  assert.deepEqual(saved.record.publication.submittedBlockedUserIds, ['alice']);
  f.channel.transport.readMomentsAudience = async () => { throw Error('Current label members must not replace the original snapshot'); };
  const result = await f.manager.reconcile(accountId, f.run.id, signal());
  assert.equal(result.confirmed, true); assert.equal(result.outcome, 'published'); assert.equal(f.run.state, 'published');
  assert.deepEqual(f.reads[0].query, { postId: f.post.postId }); assert.equal(f.writes.length, 1); assert.equal(f.models.length, models);
  const restart = new MomentsPublishing(f.channel); assert.equal(restart.error, undefined); assert.equal(restart.run(accountId, f.run.id).state, 'published');
  await restart.reconcile(accountId, f.run.id, signal()); assert.equal(f.reads.length, 1); assert.equal(f.writes.length, 1);
});

test('a legacy uncertain post is resolved as deleted only with the matching saved WeChat deletion receipt', async t => {
  const f = await uncertainPublication(t, { evidence: false });
  f.channel.momentsAutomation.remember(accountId, [{ ...f.post, id: f.post.postId, author: { userId: accountId } }]);
  f.advance(1000);
  f.channel.transport.writeMoments = async args => { f.writes.push(args); return { accountId, action: 'delete', postId: args.query.postId, deleted: true, delivery: 'server-ack' }; };
  await f.channel.moments.writeOwner({ action: 'delete', postId: f.post.postId }, accountId, 'explicit-delete', signal());
  const count = f.writes.length;
  f.channel.transport.readMomentsPublication = async () => { throw Error('Saved acknowledged deletion is sufficient'); };
  const result = await f.manager.reconcile(accountId, f.run.id, signal());
  assert.equal(result.outcome, 'deleted'); assert.equal(result.confirmed, true); assert.equal(f.run.state, 'deleted');
  assert.equal(f.run.error, null); assert.match(f.run.audienceWarning, /屏蔽范围未确认/); assert.equal(f.writes.length, count);
  const restart = new MomentsPublishing(f.channel); assert.equal(restart.error, undefined); assert.equal(restart.run(accountId, f.run.id).state, 'deleted');
  await assert.rejects(restart.publishDraft(accountId, f.run.id, signal())); assert.equal(f.writes.length, count);
});

test('ret -2 during publication verification never becomes proof of deletion or a new publication', async t => {
  const f = await uncertainPublication(t);
  f.channel.transport.readMomentsPublication = async () => { throw new ChannelError('ERR_MOMENTS_REJECTED', 'unavailable', { ret: -2 }); };
  const result = await f.manager.reconcile(accountId, f.run.id, signal());
  assert.equal(result.confirmed, false); assert.equal(f.run.state, 'published-unverified'); assert.equal(f.run.deletion, undefined);
  assert.equal(f.writes.length, 1); assert.match(result.message, /尚不能确认/);
});

test('legacy labels cannot be reconstructed from present-day membership while explicit saved user exclusions can be checked', async t => {
  for (const labels of [true, false]) {
    const f = await uncertainPublication(t, { evidence: false, labels });
    f.channel.momentsAutomation.remember(accountId, [{ ...f.post, id: f.post.postId, author: { userId: accountId } }]);
    f.channel.transport.readMomentsAudience = async () => { throw Error('Do not reconstruct an old label with new members'); };
    const result = await f.manager.reconcile(accountId, f.run.id, signal());
    assert.equal(result.confirmed, !labels); assert.equal(f.run.state, labels ? 'published-unverified' : 'published'); assert.equal(f.writes.length, 1);
  }
});

test('ambiguous legacy matches and changed account or journal never confirm a different publication', async t => {
  const ambiguous = await uncertainPublication(t, { evidence: false });
  ambiguous.channel.momentsAutomation.remember(accountId, ['91001', '91002'].map(id => ({ ...ambiguous.post, id, author: { userId: accountId } })));
  assert.equal((await ambiguous.manager.reconcile(accountId, ambiguous.run.id, signal())).confirmed, false);
  assert.equal(ambiguous.reads.length, 0); assert.equal(ambiguous.run.state, 'unknown');
  for (const mode of ['account', 'journal']) {
    const f = await uncertainPublication(t), stored = ownerPublicationRecord(f.channel, f.run.query, accountId, f.run.requestId);
    f.channel.transport.readMomentsPublication = async () => {
      if (mode === 'account') f.status.account.id = 'another-account';
      else fs.writeFileSync(stored.file, JSON.stringify({ ...stored.record, concurrentChange: true }));
      return structuredClone(f.post);
    };
    await assert.rejects(f.manager.reconcile(accountId, f.run.id, signal()));
    assert.equal(f.run.state, 'published-unverified'); assert.equal(f.writes.length, 1);
    if (mode === 'account') assert(fs.readFileSync(stored.file).equals(stored.bytes));
    else assert.equal(JSON.parse(fs.readFileSync(stored.file, 'utf8')).concurrentChange, true);
  }
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
  await f.manager.publishDraft(accountId, other.id, signal()); assert.equal(f.writes.length, 2); assert.equal(f.writes[1].query.images, undefined);
  assert.equal(f.manager.run(accountId, other.id).fallbacks[0].code, 'MOMENTS_IMAGE_CHANGED');
});
test('a failed image falls back to a single confirmed text-only post without repeating the image charge', async t => {
  const f = fixture(t); f.configure(); await f.plan({ image: { mode: 'ai' } }); f.advance(60000);
  f.channel.work.imageGeneration.generate = async input => { f.images.push(input); throw new ChannelError('IMAGE_GENERATION_EMPTY', '生图为空'); };
  await f.manager.tick(); const run = f.manager.list(accountId).runs[0]; assert.equal(run.state, 'published'); assert(run.text); assert.equal(f.writes.length, 1);
  assert.equal(run.textOnly, true); assert.equal(f.writes[0].query.images, undefined); assert.equal(run.error, null);
  await f.manager.publishDraft(accountId, run.id, signal()); await f.manager.tick(); assert.equal(f.images.length, 1); assert.equal(f.writes.length, 1);
  const restart = new MomentsPublishing(f.channel); restart.stopped = false; await restart.tick(); assert.equal(f.writes.length, 1);
});
test('research passes public topics to search and switches to offline text without usable sources', async t => {
  const f = fixture(t); await f.manager.preview(accountId, { research: true, researchQuery: '公开科技新闻' }, 'research', signal());
  assert.equal(f.searches[0].query, '公开科技新闻'); const request = JSON.parse(f.models[0].text); assert.equal(request.research.sources.length, 1); assert.deepEqual(f.models[0].tools, []);
  f.channel.runner.search.forConfig = () => ({ search: async () => ({ content: '无来源', sources: [] }) });
  const draft = await f.manager.preview(accountId, { research: true, image: { mode: 'ai' } }, 'empty-research', signal());
  assert.equal(draft.state, 'draft'); assert.equal(draft.textOnly, true); assert.equal(draft.fallbacks[0].code, 'MOMENTS_RESEARCH_EMPTY');
  const fallback = f.models.at(-1); assert.deepEqual(fallback.tools, []); assert.match(fallback.systemOverride, /不声称已查证/);
  assert.equal(JSON.parse(fallback.text).research.unavailable, true); assert.equal(JSON.parse(fallback.text).image, false);
  assert.equal(f.images.length, 0); assert.equal(f.writes.length, 0);
});
test('specific titles within a configured theme direction are accepted, while semantic violations still fail review', async t => {
  const f = fixture(t), original = f.channel.runner.run;
  const themes = ['吐槽向和感想向，也可以随意发挥'];
  f.channel.runner.run = async input => input.mode === 'moments-publish'
    ? { text: JSON.stringify({ theme: '吐槽向：评论区里的懂王', text: '有些评论区最稀缺的不是答案，是把问题读完的耐心。', imagePrompt: '' }) }
    : original(input);
  const draft = await f.manager.preview(accountId, { themes }, 'specific-theme', signal());
  assert.equal(draft.state, 'draft'); assert.equal(draft.theme, '吐槽向：评论区里的懂王');
  assert.deepEqual(JSON.parse(f.reviews[0].text).themes, themes);
  f.channel.runner.run = async input => input.mode === 'moments-content-review'
    ? { text: '{"ok":false,"reason":"不符合所有者的主题方向"}' }
    : { text: '{"theme":"无关内容","text":"主题外的正文。","imagePrompt":""}' };
  await assert.rejects(f.manager.preview(accountId, { themes }, 'off-topic', signal()), { code: 'MOMENTS_CONTENT_MISMATCH' });
  assert.equal(f.writes.length, 0);
});

test('search transport failure publishes reviewed offline text without attempting an image', async t => {
  const f = fixture(t); f.configure(); await f.plan({ research: true, image: { mode: 'ai' } }); f.advance(60000);
  f.channel.runner.search.forConfig = () => ({ search: async () => { throw new ChannelError('WEB_SEARCH_FAILED', '服务未连接'); } });
  await f.manager.tick(); const run = f.manager.list(accountId).runs[0];
  assert.equal(run.state, 'published'); assert.equal(run.fallbacks[0].kind, 'research');
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.images, undefined); assert.equal(f.images.length, 0);
  assert.equal(JSON.parse(f.models[0].text).imageMode, 'none'); assert.deepEqual(f.models[0].tools, []);
  assert.equal(JSON.parse(f.reviews[0].text).researchUnavailable, true);
});

for (const stage of ['research', 'image']) test(`cancelling during ${stage} never turns cancellation into a text-only publication`, async t => {
  const f = fixture(t), entered = Promise.withResolvers(); f.configure(); await f.plan({ research: stage === 'research', image: { mode: 'ai' } }); f.advance(60000);
  const wait = (_input, abort) => { entered.resolve(abort); return new Promise((resolve, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true })); };
  if (stage === 'research') f.channel.runner.search.forConfig = () => ({ search: wait });
  else f.channel.work.imageGeneration.generate = wait;
  const pending = f.manager.tick(), abort = await entered.promise;
  assert.throws(() => f.manager.cancel('another-account'), { code: 'ACCOUNT_CHANGED' }); assert.equal(abort.aborted, false);
  f.manager.cancel(accountId); await pending;
  assert.equal(f.manager.list(accountId).runs[0].state, 'failed'); assert.equal(f.writes.length, 0);
  assert.equal(f.manager.list(accountId).runs[0].textOnly, undefined);
});

test('text-only fallback removes an image-dependent sentence in one bounded revision before sending', async t => {
  const f = fixture(t); f.configure(); await f.plan({ image: { mode: 'ai' } }); f.advance(60000);
  let revisions = 0, attempts = 0;
  f.channel.runner.run = async input => {
    const data = JSON.parse(input.text);
    if (input.mode === 'moments-content-review') return { text: JSON.stringify({ ok: data.phase !== 'text-only' || !data.text.includes('如图'), reason: data.phase === 'text-only' && data.text.includes('如图') ? '正文依赖缺失图片' : '' }) };
    f.models.push(input);
    if (data.fallbackText) { revisions++; assert.deepEqual(input.tools, []); assert.equal(data.image, false); }
    return { text: JSON.stringify({ theme: '日常心情与小笑话', text: data.fallbackText ? '今天想给生活留一点发呆的空白。' : '如图，今天想给生活留一点空白。', imagePrompt: data.image ? '一张留白的图片' : '' }) };
  };
  f.channel.work.imageGeneration.generate = async () => { attempts++; throw new ChannelError('IMAGE_GENERATION_NETWORK', '图片连接中断'); };
  await f.manager.tick(); const run = f.manager.list(accountId).runs[0];
  assert.equal(run.state, 'published'); assert.equal(revisions, 1); assert.equal(attempts, 1);
  assert(run.textBeforeFallback.includes('如图')); assert(!run.text.includes('如图'));
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.text, run.text); assert.equal(f.writes[0].query.images, undefined);
});

test('an unknown WeChat receipt after image fallback pauses the plan and is never resubmitted', async t => {
  const f = fixture(t); f.configure(); const plan = await f.plan({ image: { mode: 'ai' } }); f.advance(60000);
  f.channel.work.imageGeneration.generate = async () => { throw new ChannelError('IMAGE_GENERATION_NETWORK', '图片连接中断'); };
  f.channel.transport.writeMoments = async args => { f.writes.push(args); throw new ChannelError('NETWORK', '确认连接中断', { delivery: 'unknown' }); };
  await f.manager.tick(); const run = f.manager.list(accountId).runs[0];
  assert.equal(run.state, 'unknown'); assert.equal(run.textOnly, true); assert.equal(f.manager.plan(accountId, plan.id).settings.enabled, false);
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].query.images, undefined);
  await assert.rejects(f.manager.publishDraft(accountId, run.id, signal()));
  await f.manager.tick(); const restarted = new MomentsPublishing(f.channel); restarted.stopped = false; await restarted.tick();
  assert.equal(f.writes.length, 1);
});

test('an explicitly published legacy failed image draft uses its existing text without regenerating or changing its audience', async t => {
  const f = fixture(t), draft = await f.manager.preview(accountId, { image: { mode: 'ai' }, blockedUserIds: ['alice'] }, 'legacy-image', signal());
  const run = f.manager.run(accountId, draft.id); run.state = 'failed'; delete run.image; f.manager.save();
  const models = f.models.length, images = f.images.length;
  await f.manager.publishDraft(accountId, run.id, signal());
  assert.equal(run.state, 'published'); assert.equal(f.models.length, models); assert.equal(f.images.length, images);
  assert.equal(f.writes[0].query.images, undefined); assert.equal(f.writes[0].query.text, draft.text);
  assert.deepEqual(f.writes[0].query.blockedUserIds, ['alice']);
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
