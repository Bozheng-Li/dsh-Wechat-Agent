import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { stickerPng } from './fixtures/stickers.mjs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { nativeQrSession } from './fixtures/native-qr-session.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = ['moments', 'moments-images', 'moments-write', 'moments-audience', 'backend', 'wire', 'image-session'].map(name => `export * from ${JSON.stringify(path.join(root, 'backend/wechat/protocol/' + name + '.ts'))};`).join('\n');
const build = await rolldown({ input: 'virtual:moments-test', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(root, 'backend/wechat/types.ts') } },
  plugins: [{ name: 'moments-test', resolveId: id => id === 'virtual:moments-test' ? id : null, load: id => id === 'virtual:moments-test' ? entry : null }] });
let api;
const codeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-moments-codec-'));
test.after(() => { const resolved = fs.realpathSync(codeRoot); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(resolved), /^wechat-moments-codec-/); fs.rmSync(resolved, { recursive: true, force: true }); });
try { const { output } = await build.generate({ format: 'esm' }); fs.writeFileSync(path.join(codeRoot, 'codec.mjs'), output[0].code);
  api = await import(new URL('file:///' + path.join(codeRoot, 'codec.mjs').replaceAll('\\', '/')).href); }
finally { await build.close(); }
const { fv, ld, fields, num, bytes, vi, readVi, encodeCgiBody, decodeCgiBody, momentsRequest, momentsResponse, parseSnsObject, validateMomentsQuery, requestMomentsCgi, MomentsReader } = api;
const capture = nativeQrSession(api), account = { ...capture.credential,
  image_base_request: api.imageBaseRequestFromNativeAuth(capture.credential, capture.request, capture.response, capture.kind).toString('hex') };
const wrap = value => Buffer.concat([fv(1, value.length), ld(2, value)]);
const post = ({ id = '18446744073709551610', userId = account.wxid, xml, likes = [], comments = [], likeCount = 3, commentCount = 4, content = true, liked = 1, deleted = false } = {}) => Buffer.concat([
  fv(1, BigInt(id)), ld(2, userId), ld(3, '测试名字'), fv(4, 1700000000),
  ...(content ? [ld(5, wrap(Buffer.from(xml ?? `<TimelineObject><id>${id}</id><username>${userId}</username><contentDesc><![CDATA[今天 & 明天]]></contentDesc><ContentObject><mediaList><media><id>image-1</id><type>2</type><url>https://mmsns.qpic.cn/private?token=SECRET_CDN_TOKEN</url><size width="640" height="480"/></media></mediaList></ContentObject></TimelineObject>`)))] : []),
  fv(6, liked), fv(7, likeCount), fv(8, likes.length), ...likes.map(value => ld(9, value)), fv(10, commentCount), fv(11, comments.length), ...comments.map(value => ld(12, value)), fv(25, deleted ? 1 : 0),
]);
const interaction = Buffer.concat([ld(1, 'visible-friend'), ld(2, '朋友'), ld(5, '可见评论'), fv(6, 1700000001), fv(12, 9007199254740997n)]);
const response = (items = [], { ret = 0, count = items.length, action = 'timeline' } = {}) => Buffer.concat([ld(1, fv(1, ret)),
  ...(action === 'detail' ? items.map(value => ld(2, value)) : [ld(2, 'page-md5'), fv(3, count), ...items.map(value => ld(4, value)), ld(11, wrap(Buffer.from('PRIVATE_PAGING_SESSION')))])]);
function setChecksum(encoded, replacement) {
  const header = encoded[1] >> 2; let end = 26; const values = [];
  for (let i = 0; i < 6; i++) { const [value, next] = readVi(encoded.subarray(0, header), end); end = next; values.push(value); }
  values[4] = 0n; values[5] = BigInt(replacement); const replacementFields = Buffer.concat(values.map(vi));
  const next = Buffer.concat([encoded.subarray(0, 26), replacementFields, encoded.subarray(end)]);
  next[1] = ((header + replacementFields.length - (end - 26)) << 2) | (encoded[1] & 3); return next;
}
const encrypted = (body, cmd = 211, uin = account.uin, checksum = 0) => setChecksum(encodeCgiBody(cmd, body, uin, account.token, capture.key, capture.s08), checksum);

const snsAck = (object, ret = 0) => Buffer.concat([ld(1, fv(1, ret)), ...(object ? [ld(2, object)] : [])]);
test('PC default empty objects are unavailable targets; zero-length wrapped buffers are valid and malformed identities still fail', () => {
  const empty = Buffer.concat([fv(1, 0), fv(4, 0), ld(5, fv(1, 0)), fv(8, 0), fv(11, 0)]);
  const query = { action: 'detail', postId: '9007199254740997' };
  assert.throws(() => momentsResponse(snsAck(empty), query), error => error.code === 'ERR_MOMENTS_TARGET_UNAVAILABLE' &&
    error.details.postId === query.postId && error.details.reason === 'empty-sns-object');
  assert.throws(() => momentsResponse(snsAck(empty, -2), query), error => error.code === 'ERR_MOMENTS_REJECTED' && error.details.ret === -2);
  for (const bad of [Buffer.concat([fv(1, BigInt(query.postId)), fv(4, 0), ld(5, fv(1, 0))]),
    Buffer.concat([empty, ld(2, 'another-author')]), Buffer.concat([empty, fv(1, 0)])])
    assert.throws(() => momentsResponse(snsAck(bad), query), { code: 'ERR_MOMENTS_PROTOCOL' });
  const withoutContent = post({ content: false });
  assert.equal(parseSnsObject(Buffer.concat([withoutContent, ld(5, fv(1, 0))])).contentAvailable, false);
});
const uploadAck = (clientId, total, end, ret = 0) => Buffer.concat([ld(1, fv(1, ret)), fv(2, end), fv(3, total), ld(4, clientId),
  ld(5, ld(1, 'https://mmsns.qpic.cn/private/0?token=UPLOAD_SECRET')), fv(6, 1), ld(7, ld(1, 'https://mmsns.qpic.cn/private/150?token=THUMB_SECRET')), fv(9, 2)]);
const snsComment = (id, text = '真好看') => Buffer.concat([ld(1, account.wxid), ld(5, text), fv(6, 1700000001), fv(12, BigInt(id))]);
const pcComment = ({ id = '3', userId = 'visible-author', text = '评论', replyId, replyUser, deleted = false } = {}) => Buffer.concat([
  ld(1, userId), ld(5, text), fv(6, 1700000001), fv(7, BigInt(id)), fv(12, 0),
  ...(replyId ? [fv(8, BigInt(replyId)), fv(11, 0), ld(9, replyUser)] : []), fv(13, deleted ? 1 : 0),
]);

test('PC zero modern IDs preserve legacy comment and reply IDs, including rendered text forms', () => {
  const object = parseSnsObject(post({ comments: [pcComment({ id: '9007199254740997', text: '开心\ue412', replyId: '3', replyUser: 'original-author' })] }));
  assert.equal(object.comments[0].id, '9007199254740997'); assert.equal(object.comments[0].replyToCommentId, '3');
  assert.equal(object.comments[0].replyToUserId, 'original-author'); assert.equal(object.comments[0].text, '开心😂');
  const body = post({ xml: '<TimelineObject><contentDesc><![CDATA[第一行&#x0A;第二行&#10;第三行&#x0D;&#13;😂]]></contentDesc></TimelineObject>' });
  assert.equal(parseSnsObject(body).text, '第一行\n第二行\n第三行\r\r😂');
});

test('writer binds a reply to the actual visible comment author and confirms its exact relationship', async () => {
  const original = pcComment(), query = { action: 'comment', postId: '18446744073709551610', replyToCommentId: '3', text: '哈哈😂' }, calls = [];
  const added = pcComment({ id: '353', userId: account.wxid, text: '哈哈\ue412', replyId: '3', replyUser: 'visible-author' });
  const writer = new api.MomentsWriter(async (_account, cmd, route, makeBody) => {
    calls.push(cmd);
    if (cmd === 210) return snsAck(post({ comments: [original] }));
    assert.equal(route, 'mmsnscomment'); const request = fields(makeBody(Buffer.from(account.image_base_request, 'hex'))), action = fields(bytes(fields(bytes(request, 2)), 3));
    assert.equal(bytes(action, 2).toString(), 'visible-author'); assert.equal(num(action, 9), 3n); assert.equal(num(action, 12), 3n);
    return snsAck(post({ comments: [original, added] }));
  });
  const result = await writer.write(account, query, 'stable', new AbortController().signal, () => {});
  assert.deepEqual(calls, [210, 213]); assert.equal(result.commentId, '353'); assert.equal(result.replyToCommentId, '3');
  assert.equal(result.replyToUserId, 'visible-author'); assert.equal(result.text, query.text);
  const target = { id: '3', userId: 'visible-author' };
  for (const added of [pcComment({ id: '353', userId: account.wxid, text: query.text, replyId: '33', replyUser: 'visible-author' }),
    pcComment({ id: '353', userId: account.wxid, text: query.text, replyId: '3', replyUser: 'other-author' }),
    pcComment({ id: '353', userId: account.wxid, text: query.text, replyId: '3', replyUser: 'visible-author', deleted: true })])
    assert.throws(() => api.snsInteractionResponse(snsAck(post({ comments: [added] })), account.wxid, query, new Set(), target));
});

test('missing or deleted reply targets never submit an interaction', async () => {
  for (const comments of [[], [pcComment({ deleted: true })]]) {
    const calls = [], writer = new api.MomentsWriter(async (_account, cmd) => { calls.push(cmd); return snsAck(post({ comments })); });
    await assert.rejects(writer.write(account, { action: 'comment', postId: '18446744073709551610', replyToCommentId: '3', text: '回复' },
      'stable', new AbortController().signal, () => {}), error => error.code === 'ERR_MOMENTS_TARGET_UNAVAILABLE');
    assert.deepEqual(calls, [210]);
  }
});

test('PC deletion base-only ACKs require exact own-post readback, and never treat a network error as success', async () => {
  const query = { action: 'delete', postId: '18446744073709551610' };
  assert.equal(api.snsDeleteResponse(snsAck(), query.postId).needsReadback, true);
  assert.equal(api.snsDeleteResponse(Buffer.concat([snsAck(), fv(2, 1), fv(3, 0)]), query.postId).deleted, true);
  assert.throws(() => api.snsDeleteResponse(Buffer.concat([snsAck(), fv(2, 1)]), query.postId));
  for (const mode of ['deleted', 'ret-minus-2', 'visible', 'network', 'other-ret', 'foreign']) {
    const calls = [], writer = new api.MomentsWriter(async (_account, cmd, route, makeBody) => {
      calls.push(cmd);
      if (calls.length === 1) return snsAck(post({ userId: mode === 'foreign' ? 'other-author' : account.wxid }));
      if (cmd === 218) { const request = fields(makeBody(Buffer.from(account.image_base_request, 'hex')));
        assert.equal(num(request, 2), 1n); const op = fields(bytes(request, 3)); assert.equal(num(op, 1), BigInt(query.postId)); assert.equal(num(op, 2), 1n);
        return snsAck(); }
      if (mode === 'network') throw Object.assign(Error('network'), { code: 'ERR_MOMENTS_NETWORK' });
      if (mode === 'ret-minus-2' || mode === 'other-ret') return snsAck(undefined, mode === 'ret-minus-2' ? -2 : -201);
      return snsAck(post({ deleted: mode === 'deleted' }));
    });
    if (['deleted', 'ret-minus-2'].includes(mode)) {
      const result = await writer.write(account, query, 'stable', new AbortController().signal, () => {});
      assert.equal(result.deleted, true); assert.equal(result.readbackConfirmed, true);
    } else await assert.rejects(writer.write(account, query, 'stable', new AbortController().signal, () => {}));
    assert.deepEqual(calls, mode === 'foreign' ? [210] : [210, 218, 210]);
  }
});

test('comments page through the full visible snapshot and bind cursors to requester, post, login and expiry', async () => {
  let current = account, clock = 1000000, calls = 0;
  const comments = Array.from({ length: 120 }, (_, i) => pcComment({ id: String(i + 1) }));
  const reader = new MomentsReader(() => current, () => {}, async () => { calls++; return { items: [parseSnsObject(post({ comments, commentCount: 120 }), 500)], firstPageMd5: '' }; }, () => clock);
  const signal = new AbortController().signal, query = { action: 'comments', postId: '18446744073709551610', limit: 50 };
  const first = await reader.read(query, 'alice', signal); assert.equal(first.items.length, 50); assert.equal(first.visibleCommentEntries, 120);
  await assert.rejects(reader.read({ ...query, cursor: first.nextCursor }, 'bob', signal), error => error.code === 'ERR_MOMENTS_CURSOR');
  await assert.rejects(reader.read({ ...query, postId: '1', cursor: first.nextCursor }, 'alice', signal));
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(reader.read({ ...query, cursor: first.nextCursor }, 'alice', cancelled.signal));
  const second = await reader.read({ ...query, cursor: first.nextCursor }, 'alice', signal), third = await reader.read({ ...query, cursor: second.nextCursor }, 'alice', signal);
  assert.equal(third.nextCursor, null); assert.equal(third.items.length, 20); assert.equal(calls, 1);
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(row => row.id), comments.map((_, i) => String(i + 1)));
  clock += 600001; await assert.rejects(reader.read({ ...query, cursor: first.nextCursor }, 'alice', signal));
  const refreshed = await reader.read(query, 'alice', signal); current = { ...account, token: 'changed-login' };
  await assert.rejects(reader.read({ ...query, cursor: refreshed.nextCursor }, 'alice', signal));
});

test('SNS mutations validate action-specific fields and do not accept raw XML or foreign account arguments', () => {
  assert.equal(api.validateSnsWrite({ action: 'like', postId: '9007199254740997' }).action, 'like');
  assert.equal(api.validateSnsWrite({ action: 'publish', text: '天气不错' }).text, '天气不错');
  assert.equal(api.validateSnsWrite({ action: 'delete', postId: '1' }).action, 'delete');
  assert.equal(api.validateSnsWrite({ action: 'comment', postId: '1', text: '回复', replyToCommentId: '3' }).replyToCommentId, '3');
  for (const query of [null, [], { action: 'unsupported', postId: '1' }, { action: 'delete', postId: '1', text: 'bad' },
    { action: 'comment', postId: '1', text: '回复', replyToCommentId: '0' }, { action: 'comment', postId: '1', text: ' ' },
    { action: 'publish', text: '' }, { action: 'like', postId: '18446744073709551616' }, { action: 'publish', text: '正文', xml: '<TimelineObject/>' },
    { action: 'like', postId: '1', accountId: 'other' }, { action: 'publish', text: '正文', images: [{ data: 'bad!', width: 1, height: 1 }] }])
    assert.throws(() => api.validateSnsWrite(query), error => error.code === 'ERR_INVALID_MOMENTS_WRITE');
});

test('like and comment request identity uses the logged account and the verified post author', () => {
  const base = Buffer.from(account.image_base_request, 'hex');
  for (const action of ['like', 'comment']) {
    const query = { action, postId: '9007199254740997', ...(action === 'comment' ? { text: '真好看' } : {}) };
    const request = fields(api.snsInteractionRequest(base, account.wxid, 'visible-author', query, 'stable-id', 1700000001));
    assert.deepEqual(bytes(request, 1), base); assert.equal(bytes(request, 3).toString(), 'stable-id');
    const group = fields(bytes(request, 2)), current = fields(bytes(group, 3));
    assert.equal(num(group, 1), 9007199254740997n); assert.equal(bytes(current, 1).toString(), account.wxid);
    assert.equal(bytes(current, 2).toString(), 'visible-author'); assert.equal(num(current, 5), action === 'like' ? 1n : 2n);
  }
});

test('interaction ACKs require the exact post and actual like or new comment evidence', () => {
  const like = { action: 'like', postId: '18446744073709551610' }, comment = { action: 'comment', postId: like.postId, text: '真好看' };
  assert.equal(api.snsInteractionResponse(snsAck(post()), account.wxid, like, new Set()).liked, true);
  const commented = snsAck(post({ comments: [snsComment('9007199254740997')] }));
  assert.equal(api.snsInteractionResponse(commented, account.wxid, comment, new Set()).commentId, '9007199254740997');
  assert.throws(() => api.snsInteractionResponse(commented, account.wxid, comment, new Set(['9007199254740997'])));
  for (const body of [snsAck(), snsAck(post({ id: '123' })), snsAck(post({ liked: 0 })), snsAck(post(), -2)])
    assert.throws(() => api.snsInteractionResponse(body, account.wxid, like, new Set()));
});

test('SNS image upload ACKs bind chunk position, client, length and media URLs', () => {
  const base = Buffer.from(account.image_base_request, 'hex'), data = Buffer.from('synthetic');
  const request = fields(api.snsUploadRequest(base, 'image-id', 'md5', 20, 5, data));
  assert.equal(num(request, 2), 2n); assert.equal(num(request, 3), 5n); assert.equal(num(request, 4), 20n);
  assert.deepEqual(bytes(fields(bytes(request, 5)), 2), data);
  assert.equal(api.snsUploadResponse(uploadAck('image-id', 20, 10), 'image-id', 20, 10), undefined);
  assert(api.snsUploadResponse(uploadAck('image-id', 20, 20), 'image-id', 20, 20).url.startsWith('https://mmsns.qpic.cn/'));
  assert.equal(api.snsUploadResponse(uploadAck('image-id', 20, 20), 'image-id', 20, 20).id, '0');
  assert.equal(api.snsUploadResponse(Buffer.concat([uploadAck('image-id', 20, 20), fv(8, 18446744073709551610n)]), 'image-id', 20, 20).id, '18446744073709551610');
  for (const badId of [ld(8, '1'), Buffer.concat([fv(8, 0), fv(8, 1)]), Buffer.from([0x40, ...Array(9).fill(0x80), 0x02])])
    assert.throws(() => api.snsUploadResponse(Buffer.concat([uploadAck('image-id', 20, 20), badId]), 'image-id', 20, 20));
  for (const body of [uploadAck('other', 20, 20), uploadAck('image-id', 21, 20), uploadAck('image-id', 20, 19), uploadAck('image-id', 20, 20, -2)])
    assert.throws(() => api.snsUploadResponse(body, 'image-id', 20, 20));
  const bad = Buffer.concat([ld(1, fv(1, 0)), fv(2, 20), fv(3, 20), ld(4, 'image-id'), ld(5, ld(1, 'http://localhost/private')), fv(6, 1), ld(7, ld(1, 'https://mmsns.qpic.cn/thumb')), fv(9, 2)]);
  assert.throws(() => api.snsUploadResponse(bad, 'image-id', 20, 20));
});

test('upload and final publication rejection messages identify the actual failing stage', () => {
  assert.throws(() => api.snsUploadResponse(snsAck(undefined, -2), 'image', 1, 1), error =>
    error.code === 'ERR_MOMENTS_WRITE_REJECTED' && error.details.stage === 'upload' && error.message.includes('图片上传') && error.details.delivery === 'rejected');
  assert.throws(() => api.snsPostResponse(snsAck(undefined, -2), account.wxid, { action: 'publish', text: '测试' }), error =>
    error.code === 'ERR_MOMENTS_WRITE_REJECTED' && error.details.stage === 'publish' && error.message.includes('朋友圈发布') && error.details.delivery === 'rejected');
});

test('publishing escapes user text, separates uploads from posts and requires matching server content', () => {
  const query = { action: 'publish', text: '<title>你好 & "朋友"</title>' }, base = Buffer.from(account.image_base_request, 'hex');
  const request = fields(api.snsPostRequest(base, account.wxid, query, 'stable-post', 1700000001, []));
  const content = bytes(fields(bytes(request, 2)), 2).toString();
  assert(content.includes('&lt;title&gt;你好 &amp; &quot;朋友&quot;&lt;/title&gt;')); assert(content.includes('<contentStyle>2</contentStyle>'));
  const published = post({ xml: `<TimelineObject><username>${account.wxid}</username><contentDesc><![CDATA[${query.text}]]></contentDesc><ContentObject><mediaList/></ContentObject></TimelineObject>` });
  assert.equal(api.snsPostResponse(snsAck(published), account.wxid, query).postId, '18446744073709551610');
  for (const body of [snsAck(), snsAck(published, -2), snsAck(post()), snsAck(post({ userId: 'other' }))]) assert.throws(() => api.snsPostResponse(body, account.wxid, query));
});

const labelAck = (labels = [{ id: '1', name: '同事' }]) => Buffer.concat([ld(1, fv(1, 0)), fv(2, labels.length), ...labels.map(row => ld(3, Buffer.concat([ld(1, row.name), fv(2, BigInt(row.id))])))]);
const directoryAck = (ids, more = false, seq = 1) => Buffer.concat([ld(1, fv(1, 0)), fv(2, seq), fv(3, 0), fv(4, more ? 1 : 0), ...ids.map(id => ld(5, id))]);
const contactAck = (ids, { unavailable = [], malformed = false } = {}) => Buffer.concat([ld(1, fv(1, 0)), fv(2, ids.length),
  ...ids.map(id => ld(3, unavailable.includes(id) ? Buffer.concat([ld(1, ''), ld(2, ''), ld(10, '')]) : Buffer.concat([ld(1, ld(1, id)), ld(2, ld(1, '昵称')), ld(10, ld(1, '备注')), ld(61, '1')]))),
  ld(4, Buffer.concat(ids.slice(0, malformed ? -1 : undefined).map(id => vi(unavailable.includes(id) ? -1 : 0))))]);

test('live audience reader completes pagination, requests at most 20 contacts and binds label members to real people', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `friend-${i}`), calls = [], base = Buffer.from(account.image_base_request, 'hex');
  const reader = new api.MomentsAudienceReader(async (_account, cmd, route, makeBody) => {
    calls.push(cmd); const body = fields(makeBody(base));
    if (cmd === 639) { assert.equal(route, 'getcontactlabellist'); assert.deepEqual(bytes(body, 1), base); return labelAck(); }
    if (cmd === 851) { assert.equal(bytes(body, 1).toString(), account.wxid); return num(body, 2) === 0n ? directoryAck([account.wxid, 'room@chatroom', ...ids.slice(0, 10)], true, 1) : directoryAck(ids.slice(10), false, 2); }
    assert.equal(cmd, 182); const batch = body.filter(row => row.tag === 3).map(row => bytes(fields(row.value), 1).toString());
    assert.equal(num(body, 2), BigInt(batch.length)); assert(batch.length <= 20); return contactAck(batch, { unavailable: ['friend-24'] });
  });
  const result = await reader.read(account, new AbortController().signal, () => {});
  assert.deepEqual(calls, [639, 851, 851, 182, 182, 639]); assert.equal(result.contacts.length, 24); assert.equal(result.unavailableCount, 1);
  assert.equal(result.labels[0].memberCount, 24); assert.deepEqual(result.labels[0].userIds, ids.slice(0, 24)); assert.equal(result.membershipComplete, true);
  assert.equal(result.contacts[0].name, '备注'); assert.equal(result.accountId, account.wxid);
});

test('audience reader rejects partial, nonadvancing, changing-label and wrong-contact results without a usable snapshot', async () => {
  for (const mode of ['partial', 'paging', 'labels', 'identity', 'rejected', 'unknown-label']) {
    let labelsRead = 0;
    const reader = new api.MomentsAudienceReader(async (_account, cmd) => {
      if (cmd === 639) return labelAck(mode === 'labels' && ++labelsRead > 1 ? [] : [{ id: mode === 'unknown-label' ? '2' : '1', name: '同事' }]);
      if (cmd === 851) return directoryAck(['friend'], mode === 'paging', mode === 'paging' ? 0 : 1);
      if (mode === 'rejected') return ld(1, fv(1, -2));
      return contactAck([mode === 'identity' ? 'wrong-friend' : 'friend'], { malformed: mode === 'partial' });
    });
    await assert.rejects(reader.read(account, new AbortController().signal, () => {}), error => error.code === 'ERR_MOMENTS_AUDIENCE', mode);
  }
  assert.throws(() => api.contactLabelsResponse(Buffer.concat([labelAck(), fv(2, 1)])));
  assert.throws(() => api.contactDetailsResponse(contactAck(['other']), ['friend']));
  const cancelled = new AbortController(); cancelled.abort(); let called = false;
  await assert.rejects(new api.MomentsAudienceReader(async () => { called = true; }).read(account, cancelled.signal, () => {})); assert.equal(called, false);
});

test('publish blacklist is encoded as SnsPost 13/14 and confirmed against SnsObject 23/24', () => {
  const query = { action: 'publish', text: '屏蔽测试', blockedUserIds: ['friend-a', 'friend-b'] }, base = Buffer.from(account.image_base_request, 'hex');
  const request = fields(api.snsPostRequest(base, account.wxid, query, 'stable', 1700000001, []));
  assert.equal(num(request, 13), 2n); assert.deepEqual(request.filter(row => row.tag === 14).map(row => bytes(fields(row.value), 1).toString()), query.blockedUserIds);
  const object = post({ xml: `<TimelineObject><username>${account.wxid}</username><contentDesc>${query.text}</contentDesc><ContentObject><mediaList/></ContentObject></TimelineObject>` });
  const privacy = (ids, count = ids.length) => Buffer.concat([object, fv(23, count), ...ids.map(id => ld(24, wrap(Buffer.from(id))))]);
  const confirmed = api.snsPostResponse(snsAck(privacy(['friend-b', 'friend-a'])), account.wxid, query);
  assert.equal(confirmed.audienceConfirmed, true); assert.deepEqual(confirmed.blockedUserIds, ['friend-b', 'friend-a']);
  for (const body of [object, privacy(['friend-a']), privacy(['friend-a', 'friend-a']), privacy(['friend-a', 'friend-b'], 1), Buffer.concat([privacy(query.blockedUserIds), fv(23, 2)])])
    assert.throws(() => api.snsPostResponse(snsAck(body), account.wxid, query), error => error.details.delivery === 'unknown');
  for (const blockedUserIds of [['friend-a', 'friend-a'], ['room@chatroom'], [12], 'friend-a']) assert.throws(() => api.validateSnsWrite({ ...query, blockedUserIds }));
  for (const blockedLabelIds of [['0'], ['4294967296'], ['1','1'], [1]]) assert.throws(() => api.validateSnsWrite({ ...query, blockedLabelIds }));
  assert.throws(() => api.validateSnsWrite({ action: 'comment', postId: '1', text: '评论', blockedUserIds: [] }));
});

test('publication confirms every requested exclusion without mistaking additional blocked people for a failure', () => {
  const query = { action: 'publish', text: '确认屏蔽范围', blockedUserIds: ['friend-a', 'friend-b'] };
  const object = post({ xml: '<TimelineObject><contentDesc>确认屏蔽范围</contentDesc></TimelineObject>' });
  const privacy = ids => Buffer.concat([object, fv(23, ids.length), ...ids.map(id => ld(24, wrap(Buffer.from(id))))]);
  const result = api.snsPostResponse(snsAck(privacy(['friend-b', 'already-blocked', 'friend-a'])), account.wxid, query);
  assert.equal(result.audienceConfirmed, true); assert.equal(result.additionalBlockedCount, 1);
  assert.throws(() => api.snsPostResponse(snsAck(privacy(['friend-a', 'another-person'])), account.wxid, query), error => {
    assert.equal(error.code, 'ERR_MOMENTS_WRITE_PROTOCOL'); assert.equal(error.details.delivery, 'unknown');
    const evidence = error.details.publication;
    assert.equal(evidence.postId, '18446744073709551610'); assert.equal(evidence.accountId, account.wxid);
    assert.deepEqual(evidence.submittedBlockedUserIds, query.blockedUserIds);
    assert.deepEqual(evidence.returnedBlockedUserIds, ['friend-a', 'another-person']);
    assert.equal(evidence.textHash, createHash('sha256').update(query.text).digest('hex')); return true;
  });
});

test('publication readback uses only the exact own-post detail endpoint and preserves audience uncertainty', async () => {
  const id = '18446744073709551610', calls = [], object = post({ xml: '<TimelineObject><contentDesc>原正文</contentDesc></TimelineObject>' });
  const writer = new api.MomentsWriter(async (_account, cmd, route) => {
    calls.push([cmd, route]); return snsAck(Buffer.concat([object, fv(23, 1), ld(24, wrap(Buffer.from('friend-a')))]));
  });
  const result = await writer.readPublication(account, { postId: id }, new AbortController().signal, () => {});
  assert.deepEqual(calls, [[210, 'mmsnsobjectdetail']]); assert.deepEqual(result.blockedUserIds, ['friend-a']);
  assert.equal(result.audienceComplete, true); assert.equal(result.contentAvailable, true);
  assert.equal(result.text, '原正文'); assert.equal(result.comments, undefined);
  assert.equal(api.snsPublicationResponse(snsAck(object), account.wxid, id).audienceComplete, false);
  assert.throws(() => api.snsPublicationResponse(snsAck(post({ userId: 'somebody-else' })), account.wxid, id));
  await assert.rejects(writer.readPublication(account, { postId: id, action: 'publish' }, new AbortController().signal, () => {}));
  assert.equal(calls.length, 1);
});

test('backend refreshes audience before uploading and never publishes unknown or unreadable selections', async () => {
  const directory = path.join(codeRoot, 'backend-audience'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'session.json'), JSON.stringify(account));
  const backend = new api.ProtocolBackend({ sessionFile: path.join(directory, 'session.json'), cacheDir: directory, requestTimeoutMs: 10000 });
  backend.online = true; backend.transport = { connected: true };
  const snapshot = { accountId: account.wxid, source: 'wechat-contacts-live', membershipComplete: true, fetchedAt: new Date().toISOString(),
    contacts: ['friend-a', 'friend-b'].map(id => ({ id })), labels: [{ id: '1', name: '同事', memberCount: 2, userIds: ['friend-a', 'friend-b'] }] };
  const calls = [], query = { action: 'publish', text: '屏蔽测试', blockedLabelIds: ['1'], blockedUserIds: ['friend-b'] };
  backend.readMomentsAudience = async () => { calls.push('audience'); return snapshot; };
  backend.momentsWriter.request = async (_account, cmd, _route, makeBody) => {
    calls.push(cmd); const body = fields(makeBody(Buffer.from(account.image_base_request, 'hex')));
    assert.equal(num(body, 13), 2n);
    return snsAck(Buffer.concat([post({ xml: `<TimelineObject><username>${account.wxid}</username><contentDesc>${query.text}</contentDesc><ContentObject><mediaList/></ContentObject></TimelineObject>` }),
      fv(23, 2), ...['friend-a', 'friend-b'].map(id => ld(24, wrap(Buffer.from(id))))]));
  };
  const result = await backend.writeMoments(query, 'stable', new AbortController().signal);
  assert.deepEqual(calls, ['audience', 209]); assert.deepEqual(result.blockedUserIds, ['friend-a','friend-b']); assert.deepEqual(result.audienceSelection.blockedLabelIds, ['1']);
  const before = calls.length;
  await assert.rejects(backend.writeMoments({ ...query, blockedLabelIds: ['2'] }, 'stable', new AbortController().signal), error => error.details.delivery === 'not-sent');
  assert.equal(calls.length, before + 1);
  backend.readMomentsAudience = async () => { throw Error('名单不可读'); };
  await assert.rejects(backend.writeMoments({ ...query, images: [{ data: Buffer.from('image').toString('base64'), width: 1, height: 1 }] }, 'stable', new AbortController().signal), error => error.details.delivery === 'not-sent');
  assert.equal(calls.length, before + 1);
});

test('writer preflights visible targets and does not resend a verified existing like', async () => {
  const commands = [], writer = new api.MomentsWriter(async (_account, cmd) => { commands.push(cmd); return snsAck(post()); });
  const result = await writer.write(account, { action: 'like', postId: '18446744073709551610' }, 'stable', new AbortController().signal, () => {});
  assert.deepEqual(commands, [210]); assert.equal(result.delivery, 'verified-existing'); assert.equal(result.alreadyLiked, true);
});

test('writer checks all prior comments beyond the model preview before confirming a new comment', async () => {
  const old = Array.from({ length: 55 }, (_, i) => snsComment(String(i + 1))), calls = [];
  const writer = new api.MomentsWriter(async (_account, cmd) => { calls.push(cmd); return snsAck(post({ comments: cmd === 210 ? old : [...old, snsComment('9007199254740997')] })); });
  const result = await writer.write(account, { action: 'comment', postId: '18446744073709551610', text: '真好看' }, 'stable', new AbortController().signal, () => {});
  assert.deepEqual(calls, [210, 213]); assert.equal(result.commentId, '9007199254740997');
  const stale = new api.MomentsWriter(async () => snsAck(post({ comments: old })));
  await assert.rejects(stale.write(account, { action: 'comment', postId: '18446744073709551610', text: '真好看' }, 'stable', new AbortController().signal, () => {}));
});

test('writer publishes only after every image chunk is acknowledged, and returns no CDN credentials', async () => {
  const data = Buffer.alloc(50010, 65), query = { action: 'publish', text: '图片测试', images: [{ data: data.toString('base64'), width: 20, height: 10 }] }, calls = [];
  const md5 = createHash('md5').update(data).digest('hex');
  const writer = new api.MomentsWriter(async (_account, cmd, route, body) => {
    calls.push(cmd); const request = fields(body(Buffer.from(account.image_base_request, 'hex')));
    if (cmd === 207) { const position = Number(num(request, 3)), total = Number(num(request, 4)), content = bytes(fields(bytes(request, 5)), 2);
      assert.equal(bytes(request, 15).toString(), md5);
      return uploadAck(bytes(request, 6).toString(), total, position + content.length); }
    assert.equal(route, 'mmsnspost');
    const xml = bytes(fields(bytes(request, 2)), 2).toString();
    assert(xml.includes('<media><id>0</id><type>2</type>'));
    assert(xml.includes('<private>0</private><url type="1" md5="' + md5 + '">'));
    assert(xml.includes('totalSize="50010"'));
    return snsAck(post({ xml: '<TimelineObject><contentDesc>图片测试</contentDesc><ContentObject><mediaList><media><type>2</type></media></mediaList></ContentObject></TimelineObject>' }));
  });
  const result = await writer.write(account, query, 'stable', new AbortController().signal, () => {});
  assert.deepEqual(calls, [207, 207, 209]); assert.equal(result.delivery, 'server-ack'); assert.equal(result.imageCount, 1);
  assert(!JSON.stringify(result).includes('SECRET'));
});

test('rejected upload, cancellation or revoked account stops before publishing any post', async () => {
  const query = { action: 'publish', text: '测试', images: [{ data: Buffer.from('test').toString('base64'), width: 1, height: 1 }] };
  const calls = [], failed = new api.MomentsWriter(async (_account, cmd) => { calls.push(cmd); return ld(1, fv(1, -2)); });
  await assert.rejects(failed.write(account, query, 'stable', new AbortController().signal, () => {})); assert.deepEqual(calls, [207]);
  const controller = new AbortController(), cancelled = new api.MomentsWriter(async (_account, cmd) => { calls.push(cmd); controller.abort(); return uploadAck('stable_image_0', 4, 4); });
  await assert.rejects(cancelled.write(account, query, 'stable', controller.signal, () => {})); assert(!calls.includes(209));
  let checked = 0;
  await assert.rejects(cancelled.write(account, { action: 'publish', text: '正文' }, 'stable', new AbortController().signal, () => { if (++checked > 1) throw Error('revoked'); }));
  assert(!calls.includes(209));
});

test('request fields preserve uint64 IDs, native base parameters and private paging session', () => {
  const base = Buffer.from(account.image_base_request, 'hex');
  const timeline = fields(momentsRequest(base, { action: 'timeline', maxId: '18446744073709551610', session: Buffer.from('page') }));
  assert.deepEqual(bytes(timeline, 1), base); assert.equal(num(timeline, 3), 18446744073709551610n);
  assert.equal(bytes(fields(bytes(timeline, 7)), 2).toString(), 'page');
  const user = fields(momentsRequest(base, { action: 'user', userId: 'wxid_target', maxId: '9007199254740997' }));
  assert.equal(bytes(user, 3).toString(), 'wxid_target'); assert.equal(num(user, 4), 9007199254740997n);
  assert.equal(num(fields(momentsRequest(base, { action: 'detail', postId: '9007199254740997' })), 2), 9007199254740997n);
});
test('native zero-checksum SNS envelope keeps account, CGI, ciphertext and length checks without weakening file ACKs', async () => {
  const body = response([post()]); const request = encodeCgiBody(211, momentsRequest(Buffer.from(account.image_base_request, 'hex'), { action: 'timeline' }), account.uin, account.token, capture.key, capture.s08);
  const sns = encrypted(body);
  assert.deepEqual(decodeCgiBody(sns, capture.key, capture.s08, request, { responseChecksum: true }).body, body);
  assert.throws(() => decodeCgiBody(sns, capture.key, capture.s08, request), /checksum/);
  for (const invalid of [encrypted(body, 212), encrypted(body, 211, 43), encrypted(body, 211, account.uin, 12345), sns.subarray(0, sns.length - 1)])
    assert.throws(() => decodeCgiBody(invalid, capture.key, capture.s08, request, { responseChecksum: true }));
  const result = await requestMomentsCgi(account, { action: 'timeline' }, new AbortController().signal, async (url, options) => {
    assert.equal(url, 'http://short.weixin.qq.com/cgi-bin/micromsg-bin/mmsnstimeline'); assert.equal(options.redirect, 'error');
    return new Response(sns);
  }); assert.equal(result.items.length, 1);
});
test('present SNS response checksums are independently validated', () => {
  const body = response(), request = encodeCgiBody(211, ld(1, Buffer.from(account.image_base_request, 'hex')), account.uin, account.token, capture.key, capture.s08);
  const valid = encodeCgiBody(211, body, account.uin, account.token, capture.key, capture.s08);
  assert.deepEqual(decodeCgiBody(valid, capture.key, capture.s08, request, { responseChecksum: true }).body, body);
});
test('post parser returns factual text, metadata and visible interactions without CDN credentials or loss of large IDs', () => {
  const value = parseSnsObject(post({ likes: [interaction], comments: [interaction] }));
  assert.equal(value.id, '18446744073709551610'); assert.equal(value.text, '今天 & 明天'); assert.equal(value.imageCount, 1);
  assert.deepEqual(value.media[0], { id: 'image-1', type: 'image', typeCode: '2', title: '', description: '', width: 640, height: 480 });
  assert.equal(value.likeCount, 3); assert.equal(value.likes.length, 1); assert.equal(value.commentCount, 4); assert.equal(value.comments.length, 1);
  assert.equal(value.comments[0].id, '9007199254740997'); assert(!JSON.stringify(value).includes('SECRET_CDN_TOKEN'));
});
test('missing content stays explicitly unavailable; empty server results require successful status and a valid count', () => {
  assert.equal(parseSnsObject(post({ content: false })).contentAvailable, false);
  assert.deepEqual(momentsResponse(response(), { action: 'timeline' }).items, []);
  assert.throws(() => momentsResponse(response([], { ret: -201 }), { action: 'timeline' }), error => error.code === 'ERR_MOMENTS_REJECTED');
  assert.throws(() => momentsResponse(response([], { count: 1 }), { action: 'timeline' }), error => error.code === 'ERR_MOMENTS_PROTOCOL');
  assert.throws(() => momentsResponse(Buffer.alloc(0), { action: 'timeline' }));
});
test('nonzero user-page response preserves ret 207 without interpreting it as a privacy setting or an empty page', () => {
  assert.throws(() => momentsResponse(response([], { ret: 207 }), { action: 'user', userId: 'synthetic-friend' }), error => {
    assert.equal(error.code, 'ERR_MOMENTS_REJECTED'); assert.equal(error.details.ret, 207);
    assert.match(error.message, /ret=207/); assert.match(error.message, /原因未确认/);
    return true;
  });
});
for (const xml of ['<TimelineObject><username>other-account</username></TimelineObject>', '<TimelineObject><id>123</id></TimelineObject>',
  '<!DOCTYPE TimelineObject [<!ENTITY x SYSTEM "file:///private">]><TimelineObject><contentDesc>&x;</contentDesc></TimelineObject>', '<TimelineObject><broken></TimelineObject>'])
  test('reject malformed or unbound social content: ' + xml.slice(0, 45), () => assert.throws(() => parseSnsObject(post({ xml })), error => error.code === 'ERR_MOMENTS_PROTOCOL'));
test('user and detail responses cannot return another target or duplicate posts', () => {
  assert.throws(() => momentsResponse(response([post()]), { action: 'user', userId: 'other-user' }));
  assert.throws(() => momentsResponse(response([post()], { action: 'detail' }), { action: 'detail', postId: '123' }));
  assert.throws(() => momentsResponse(response([post(), post()]), { action: 'timeline' }));
});
for (const query of [{ action: 'post' }, { action: 'detail' }, { action: 'detail', postId: 9007199254740997 }, { action: 'detail', postId: '18446744073709551616' },
  { action: 'user', userId: 'group@chatroom' }, { limit: 0 }, { limit: 21 }, { cursor: 'fake' }, { token: 'forged' }, { action: 'timeline', userId: 'user' }])
  test('reject invalid query: ' + JSON.stringify(query), () => assert.throws(() => validateMomentsQuery(query), error => error.code === 'ERR_INVALID_MOMENTS_QUERY'));
test('cursor paging buffers unused rows and advances exactly once without exposing private session material', async () => {
  const calls = []; const reader = new MomentsReader(() => account, () => {}, async (_account, page) => {
    calls.push(page); return calls.length === 1 ? { items: [post({ id: '12' }), post({ id: '11' })].map(parseSnsObject), firstPageMd5: 'md5', session: Buffer.from('PRIVATE_PAGING_SESSION') }
      : { items: [post({ id: '10' })].map(parseSnsObject), firstPageMd5: 'md5' };
  }); const signal = new AbortController().signal;
  const a = await reader.read({ limit: 1 }, 'alice', signal), b = await reader.read({ cursor: a.nextCursor }, 'alice', signal);
  assert.equal(calls.length, 1); assert.equal(a.items[0].id, '12'); assert.equal(b.items[0].id, '11');
  assert(!JSON.stringify(b).includes('PRIVATE_PAGING_SESSION'));
  const c = await reader.read({ cursor: b.nextCursor }, 'alice', signal); assert.equal(c.items[0].id, '10'); assert.equal(calls.length, 2);
  assert.equal(calls[1].maxId, '11'); assert.equal(calls[1].session.toString(), 'PRIVATE_PAGING_SESSION');
});
test('cursors cannot cross people, targets, accounts or their expiry', async () => {
  let current = account, now = 1700000000000, calls = 0;
  const reader = new MomentsReader(() => current, () => {}, async () => { calls++; return { items: [parseSnsObject(post())], firstPageMd5: '' }; }, () => now);
  const signal = new AbortController().signal, first = await reader.read({}, 'alice', signal);
  for (const [query, actor] of [[{ cursor: first.nextCursor }, 'bob'], [{ action: 'user', cursor: first.nextCursor }, 'alice']])
    await assert.rejects(reader.read(query, actor, signal), error => error.code === 'ERR_MOMENTS_CURSOR');
  current = { ...account, token: 'bb'.repeat(15) };
  await assert.rejects(reader.read({ cursor: first.nextCursor }, 'alice', signal), error => error.code === 'ERR_MOMENTS_CURSOR');
  current = account; const second = await reader.read({}, 'alice', signal); now += 600001;
  await assert.rejects(reader.read({ cursor: second.nextCursor }, 'alice', signal), error => error.code === 'ERR_MOMENTS_CURSOR'); assert.equal(calls, 2);
});
test('an account change or cancellation during network work returns no old content and creates no cursor', async () => {
  let current = account; const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const reader = new MomentsReader(() => current, () => {}, async () => { entered.resolve(); await release.promise; return { items: [parseSnsObject(post())], firstPageMd5: '' }; });
  const pending = reader.read({}, 'alice', new AbortController().signal); await entered.promise; current = { ...account, wxid: 'another-account' }; release.resolve();
  await assert.rejects(pending, error => error.code === 'ERR_MOMENTS_ACCOUNT_CHANGED'); assert.equal(reader.cursors.size, 0);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(reader.read({}, 'alice', controller.signal), /cancelled/);
});

test('SNS photo URLs remain private and a read fetches only images from the freshly verified post', async () => {
  const calls = [], reader = new MomentsReader(() => account, () => {}, async (_account, query) => {
    assert.equal(query.action, 'detail'); return { items: [parseSnsObject(post())] };
  });
  const value = await reader.readImages({ postId: '18446744073709551610' }, 'actor-a', new AbortController().signal, async source => {
    calls.push(source); return { index: source.index, mediaId: source.mediaId, bytes: 5, data: 'pixels' };
  });
  assert.equal(value.source, 'wechat-sns-images-live'); assert.equal(value.complete, true); assert.equal(value.items.length, 1);
  assert.equal(calls[0].mediaId, 'image-1'); assert(calls[0].url.includes('SECRET_CDN_TOKEN'));
  assert(!JSON.stringify(value).includes('SECRET_CDN_TOKEN')); assert(!JSON.stringify(value.post).includes('qpic.cn'));
  await assert.rejects(reader.readImages({ postId: value.postId, url: calls[0].url }, 'actor-a', new AbortController().signal), { code: 'ERR_INVALID_MOMENTS_QUERY' });
});

test('SNS picture reading discards old-account content but records ordinary image failures', async () => {
  let current = account, calls = 0;
  const reader = new MomentsReader(() => current, () => {}, async () => ({ items: [parseSnsObject(post())] }));
  await assert.rejects(reader.readImages({ postId: '18446744073709551610' }, 'actor', new AbortController().signal, async source => {
    calls++; current = { ...account, token: 'changed' }; return { index: source.index, mediaId: source.mediaId, bytes: 1, data: 'x' };
  }), { code: 'ERR_MOMENTS_ACCOUNT_CHANGED' });
  assert.equal(calls, 1); current = account;
  const failed=await reader.readImages({ postId: '18446744073709551610' }, 'actor', new AbortController().signal, async () => { throw Error('download failed SECRET_CDN_TOKEN'); });
  assert.equal(failed.complete,false);assert.equal(failed.items[0].error.code,'ERR_MOMENTS_IMAGE_READ');assert(!JSON.stringify(failed).includes('SECRET_CDN_TOKEN'));
});

test('nine SNS downloads keep their order and preserve usable photos after a single failure or the total byte limit',async()=>{
  const id='18446744073709551610',media=Array.from({length:9},(_,index)=>`<media><id>photo-${index+1}</id><type>2</type><url>https://mmsns.qpic.cn/private-${index+1}?token=SECRET_CDN_TOKEN</url></media>`).join('');
  const xml=`<TimelineObject><id>${id}</id><username>${account.wxid}</username><contentDesc>旅行</contentDesc><ContentObject><mediaList>${media}</mediaList></ContentObject></TimelineObject>`;
  const reader=new MomentsReader(()=>account,()=>{},async()=>({items:[parseSnsObject(post({id,xml}))]})),calls=[];
  const value=await reader.readImages({postId:id},'actor',new AbortController().signal,async(source,signal)=>{
    calls.push(source.index);assert(!signal.aborted);if(source.index===5)throw Error(source.url);
    return {index:source.index,mediaId:source.mediaId,bytes:5,data:'pixels'};
  });
  assert.equal(value.complete,false);assert.deepEqual(calls,[1,2,3,4,5,6,7,8,9]);assert.equal(value.items.length,9);
  assert.deepEqual(value.items.filter(item=>!item.error).map(item=>item.index),[1,2,3,4,6,7,8,9]);
  assert.equal(value.items[4].error.code,'ERR_MOMENTS_IMAGE_READ');assert(!JSON.stringify(value).includes('SECRET_CDN_TOKEN'));
  const limited=await reader.readImages({postId:id},'actor',new AbortController().signal,async source=>({index:source.index,mediaId:source.mediaId,bytes:10*1024*1024,data:'pixels'}));
  assert.equal(limited.items.filter(item=>!item.error).length,3);assert.equal(limited.items.filter(item=>item.error).length,6);assert.equal(limited.complete,false);
  const controller=new AbortController();let downloads=0;
  await assert.rejects(reader.readImages({postId:id},'actor',controller.signal,async source=>{downloads++;controller.abort();return {index:source.index,mediaId:source.mediaId,bytes:5,data:'pixels'};}));
  assert.equal(downloads,1);
});

test('SNS image download validates the host, refuses redirects and never exposes credential URLs in errors', async () => {
  for (const url of ['http://127.0.0.1/x', 'https://mmsns.qpic.cn.evil.test/x', 'https://mmsns.qpic.cn@evil.test/x', 'file:///x', 'https://mmsns.qpic.cn:8443/x'])
    assert.throws(() => api.snsImageUrl(url), { code: 'ERR_MOMENTS_IMAGE_READ' });
  assert.equal(api.snsImageUrl('http://mmsns.qpic.cn/photo/0?token=private').protocol, 'https:');
  const source = { index: 1, mediaId: 'photo', url: 'https://mmsns.qpic.cn/photo/0?token=PRIVATE_TOKEN' }, signal = new AbortController().signal;
  await assert.rejects(api.downloadSnsImage(source, signal, async (_url, options) => {
    assert.equal(options.redirect, 'error'); throw Error(source.url);
  }), error => error.code === 'ERR_MOMENTS_IMAGE_READ' && !error.message.includes('PRIVATE_TOKEN'));
  await assert.rejects(api.downloadSnsImage(source, signal, async () => new Response('encrypted bytes')), { code: 'ERR_MOMENTS_IMAGE_READ' });
  const png = stickerPng();
  const value = await api.downloadSnsImage(source, signal, async () => new Response(png));
  assert.equal(value.mediaType, 'image/png'); assert.equal(value.sha256, createHash('sha256').update(png).digest('hex'));
  assert(!JSON.stringify(value).includes('PRIVATE_TOKEN'));
});
