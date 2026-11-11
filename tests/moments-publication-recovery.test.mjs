import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MomentsService, ChannelError } from '../lib/testing.js';
import { identity } from '../backend/storage/keys.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
for (const scenario of ['action-first', 'post-first', 'wrong-input-post', 'wrong-result-account', 'wrong-result-post', 'unconfirmed-delivery', 'unconfirmed-state', 'foreign-store']) {
  test('saved deletion reconciliation preserves exact receipt identity: ' + scenario, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-publication-recovery-'));
    t.after(() => { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
      assert.match(path.basename(resolved), /^wechat-publication-recovery-/u); fs.rmSync(resolved, { recursive: true, force: true }); });
    const accountId = 'recovery-owner', storeId = 'recovery-journal-test', requestId = 'original-publish-request', postId = '15051498690339803672';
    const now = 1700000020000, createdAt = now - 20000, scopeKey = identity([accountId, 'owner', accountId, accountId]);
    const query = { action: 'publish', text: '合成历史动态，只有保存的回执才能证明删除。', blockedLabelIds: ['1'], blockedUserIds: [] };
    const clientId = 'sns_' + digest([storeId, scopeKey, requestId, 'publish']), deletionId = 'sns_' + 'd'.repeat(64);
    const directory = path.join(root, 'storage/moments/actions'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, clientId + '.json'), JSON.stringify({ version: 1, ownerStoreId: storeId, scopeKey, clientId,
      inputHash: digest(query), action: 'publish', state: 'unknown', createdAt, finishedAt: createdAt + 1000 }));
    const deletion = { version: 1, ownerStoreId: storeId, scopeKey, clientId: deletionId, action: 'delete', state: 'succeeded',
      inputHash: digest(scenario === 'action-first' ? { action: 'delete', postId } : { postId, action: 'delete' }), createdAt: now - 1000, finishedAt: now,
      result: { accountId, action: 'delete', postId, deleted: true, delivery: 'server-ack', readbackConfirmed: true } };
    if (scenario === 'wrong-input-post') deletion.inputHash = digest({ postId: '999', action: 'delete' });
    if (scenario === 'wrong-result-account') deletion.result.accountId = 'another-owner';
    if (scenario === 'wrong-result-post') deletion.result.postId = '999';
    if (scenario === 'unconfirmed-delivery') deletion.result.delivery = 'unknown';
    if (scenario === 'unconfirmed-state') deletion.state = 'unknown';
    if (scenario === 'foreign-store') deletion.ownerStoreId = 'another-store';
    const deletionFile = path.join(directory, deletionId + '.json'), original = JSON.stringify(deletion); fs.writeFileSync(deletionFile, original);
    let reads = 0;
    const channel = { now: () => now, store: { root, data: { storeId } },
      momentsAutomation: { data: { posts: { saved: { id: postId, accountId, text: query.text, imageCount: 0, createdAt: createdAt / 1000, deleted: true } } } },
      transport: { readMomentsPublication: async () => { reads++; throw new ChannelError('ERR_MOMENTS_REJECTED', 'Unavailable synthetic detail', { ret: -2 }); },
        writeMoments: async () => { throw Error('Reconciliation must never write to WeChat'); } } };
    channel.moments = new MomentsService(channel);
    const result = await channel.moments.reconcileOwnerPublication(query, accountId, requestId, new AbortController().signal, () => {});
    const confirmed = ['action-first', 'post-first'].includes(scenario);
    assert.equal(result.kind, confirmed ? 'deleted' : 'unknown'); assert.equal(reads, confirmed ? 0 : 1);
    if (confirmed) { assert.equal(result.deletion.postId, postId); assert.equal(result.deletion.delivery, 'server-ack'); assert.equal(result.audienceConfirmed, false); }
    else assert.equal(result.deletion, undefined);
    assert.equal(fs.readFileSync(deletionFile, 'utf8'), original, 'Saved deletion evidence stays intact');
  });
}
