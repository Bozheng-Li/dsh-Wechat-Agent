import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../backend/storage/state-store.mjs';
import { readableRoleCard } from '../modules/memory/roles/tool.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-role-version-'));
  const intendedRoot = fs.realpathSync(root);
  t.after(() => {
    const real = fs.realpathSync(root);
    assert.equal(real, intendedRoot);
    assert.equal(path.dirname(real), fs.realpathSync(os.tmpdir()));
    assert(path.basename(real).startsWith('wechat-role-version-'));
    fs.rmSync(real, { recursive: true, force: true });
  });
  const store = new StateStore(root);
  store.configure('owner', { enabled: true, groups: [], privatePeers: ['alice'], prompt: '' });
  const scope = { accountId: 'owner', personId: 'alice' };
  const source = (id, time) => ({ id, accountId: 'owner', chatType: 'private', peerId: 'alice', senderId: 'alice', time, text: '叫我阿甲' });
  const update = (time) => ({ field: 'addressAs', value: '阿甲', evidence: [{ sourceId: 's' + time,
    accountId: 'owner', senderId: 'alice', time, quote: '叫我阿甲' }] });
  return { store, scope, source, update };
}

test('same-value evidence updates retain a verified reception-time field version', t => {
  const f = fixture(t), cards = f.store.roleCards;
  cards.save(f.scope, { ...cards.view(f.scope).card, addressAs: '阿甲' }, cards.view(f.scope).revision, 1000);
  cards.commit(f.scope, { updates: [f.update(2000)], conflicts: [] }, [f.source('s2000', 2000)], cards.view(f.scope).revision, 3000);
  const view = cards.view(f.scope);
  const change = view.changes.at(-1);
  assert.equal(change.before, change.after, 'equal text still has a new evidence version');
  assert.equal(change.beforeEvidence.origin, 'owner');
  assert.equal(change.afterEvidence.origin, 'agent');
  assert.deepEqual(change.beforeConflicts, []);
  assert.equal(readableRoleCard(view, 1500).card.addressAs, '阿甲');
  assert.equal(readableRoleCard(view, 1500).evidence.addressAs.origin, 'owner');
  assert.equal(readableRoleCard(view, 4000).evidence.addressAs.sourceAt, 2000);
});

test('a future conflict and its resolution do not erase an earlier verified field', t => {
  const f = fixture(t), cards = f.store.roleCards;
  cards.save(f.scope, { ...cards.view(f.scope).card, addressAs: '阿甲' }, cards.view(f.scope).revision, 1000);
  const evidence = [{ sourceId: 'conflict', accountId: 'owner', senderId: 'alice', time: 2200, quote: '称呼待确认' }];
  cards.commit(f.scope, { updates: [], conflicts: [{ field: 'addressAs', reason: '待确认', evidence }] }, [], cards.view(f.scope).revision, 2500);
  assert.equal(readableRoleCard(cards.view(f.scope), 1800).card.addressAs, '阿甲');
  assert.equal(readableRoleCard(cards.view(f.scope), 2800).card.addressAs, '');
  cards.commit(f.scope, { updates: [f.update(3000)], conflicts: [] }, [], cards.view(f.scope).revision, 3500);
  const view = cards.view(f.scope);
  assert.equal(readableRoleCard(view, 1800).card.addressAs, '阿甲');
  assert.equal(readableRoleCard(view, 2800).card.addressAs, '');
  assert.equal(readableRoleCard(view, 3600).card.addressAs, '阿甲');
});

test('clearing a field removes its replayable historical content', t => {
  const f = fixture(t), cards = f.store.roleCards;
  cards.save(f.scope, { ...cards.view(f.scope).card, addressAs: '阿甲' }, cards.view(f.scope).revision, 1000);
  cards.save(f.scope, { ...cards.view(f.scope).card, addressAs: '' }, cards.view(f.scope).revision, 3000);
  const view = cards.view(f.scope);
  assert.equal(readableRoleCard(view, 1500).card.addressAs, '');
  assert(!JSON.stringify(view.changes.filter(row => row.field === 'addressAs')).includes('阿甲'));
});
