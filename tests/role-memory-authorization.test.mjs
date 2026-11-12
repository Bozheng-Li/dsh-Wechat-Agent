import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore } from '../backend/storage/state-store.mjs';
import { LongTermMemory } from '../modules/memory/long-term/store.mjs';
import { PersonMemoryMaintenance } from '../modules/memory/roles/maintenance.mjs';
import { personRoleCardTool, personRoleContext } from '../modules/memory/roles/tool.mjs';
import { emptyRoleCard } from '../shared/role-card.mjs';

const base = path.resolve('storage/tmp');
function fixture(t) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'role-authorization-')), store = new StateStore(root), accountId = 'role-auth-owner';
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'bob'], groups: ['people@chatroom'], prompt: '' });
  const now = Date.now(), memory = new LongTermMemory(store, { now: () => now });
  const scope = { accountId, chatType: 'private', peerId: 'alice' };
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(base)); assert(path.basename(target).startsWith('role-authorization-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, store, accountId, now, memory, scope };
}
const response = { text: JSON.stringify({ facts: [{ text: '我喜欢红茶。', sources: ['s1'], replaces: [] }], unresolved: [] }) };
const entry = (now, key = 'source-one') => ({ key, senderId: 'alice', senderName: '阿宁', text: '我喜欢红茶。', time: now, direction: 'incoming' });

for (const reauthorize of [false, true]) test(`long-term extraction rejects old authorization epochs even when its conversation remains usable: ${reauthorize}`, async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.memory.capture(f.scope, [entry(f.now)]);
  const before = fs.readFileSync(f.memory.paths(f.accountId).file);
  let request;
  const pending = f.memory.extract(f.scope, { run: input => { request = input; return gate.promise; } }, new AbortController().signal);
  const revoked = reauthorize ? 'alice' : 'bob';
  const original = f.store.settings(f.accountId);
  f.store.configure(f.accountId, { ...original, privatePeers: original.privatePeers.filter(id => id !== revoked) });
  if (reauthorize) {
    // Model an already-completed cleanup and regrant. Identity and Markdown
    // revision alone cannot distinguish this from the original authorization.
    f.store.data.authorizationRevocations = [];
    f.store.configure(f.accountId, original);
  }
  const rejected = assert.rejects(pending, { code: 'AUTHORIZATION_CHANGED' });
  gate.resolve(response); await rejected;
  assert.equal(typeof request.assertAllowed, 'function');
  assert.throws(request.assertAllowed, { code: 'AUTHORIZATION_CHANGED' });
  assert.deepEqual(fs.readFileSync(f.memory.paths(f.accountId).file), before);
  assert.equal(f.memory.view(f.accountId).pendingCount, 1);
  assert.equal(f.memory.errors.size, 0, 'an obsolete extraction cannot recreate a cleaned error');
  assert.equal(f.memory.extractionErrors.size, 0);
});

test('long-term revocation scrubs current and archived person evidence and late results cannot recreate it', async t => {
  const f = fixture(t), group = { ...f.scope, chatType: 'group', peerId: 'people@chatroom' };
  const write = async (scope, senderId, key, text) => {
    f.memory.capture(scope, [{ ...entry(f.now, key), senderId, senderName: senderId, text }]);
    await f.memory.extract(scope, { run: async () => ({ text: JSON.stringify({ facts: [{ subjectId: senderId, text,
      sources: ['s1'], evidence: [{ source: 's1', quote: text }], replaces: [], expiresAt: null }], unresolved: [] }) }) }, new AbortController().signal);
  };
  await write(group, 'alice', 'alice-old', '我喜欢红茶。');
  await write(group, 'bob', 'bob-old', '我喜欢咖啡。');
  const view = f.memory.view(f.accountId);
  f.memory.edit(f.accountId, view.markdown, view.revision); // Retain an owner-edit archive.
  f.memory.capture(f.scope, [entry(f.now, 'alice-late')]);
  const gate = Promise.withResolvers();
  const pending = f.memory.extract(f.scope, { run: () => gate.promise }, new AbortController().signal);
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: ['bob'] });
  f.memory.revoke([f.scope]);
  const rejected = assert.rejects(pending, { code: 'AUTHORIZATION_CHANGED' });
  gate.resolve(response); await rejected;
  const current = f.memory.view(f.accountId);
  assert.equal(current.pendingCount, 0);
  assert.deepEqual(current.sections.flatMap(section => section.facts).map(fact => fact.subjectId), ['bob']);
  const archive = path.join(f.memory.paths(f.accountId).directory, 'global-memory-archive');
  for (const name of fs.readdirSync(archive)) {
    const document = f.memory.parse(f.accountId, fs.readFileSync(path.join(archive, name), 'utf8'));
    assert.deepEqual(document.sections.flatMap(section => section.facts).map(fact => fact.subjectId), ['bob']);
  }
  assert.equal(f.memory.errors.size, 0);
});

test('person search and automatic context never restore unauthorized identities from stale history or participants', async t => {
  const f = fixture(t), scope = { ...f.scope, chatType: 'group', peerId: 'people@chatroom', senderId: 'alice' };
  for (const personId of ['alice', 'bob']) f.store.roleCards.save({ accountId: f.accountId, personId },
    { ...emptyRoleCard(), label: personId, preferences: personId + '的授权资料' }, 'empty', f.now);
  const channel = { store: f.store, personMemory: { request: () => { throw Error('must not request unauthorized identities'); } } };
  const history = ['alice', 'bob', 'outsider'].map(senderId => ({ direction: 'incoming', senderId, senderName: senderId + '-name', time: f.now }));
  const participants = [{ id: 'bob', name: 'bob-name' }, { id: 'outsider', name: 'outsider-name' }];
  const tool = personRoleCardTool(channel, scope, () => {}, { history, participants });
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: ['alice'] });
  const result = JSON.parse(await tool.execute({ action: 'search' }));
  assert.deepEqual(result.people.map(person => person.personId), ['alice']);
  for (const personId of ['bob', 'outsider']) for (const action of ['read', 'update'])
    await assert.rejects(tool.execute({ action, personId }), { code: 'ROLE_CARD_PERSON_UNKNOWN' });
  const context = personRoleContext(channel, scope, { history, participants, text: 'bob-name outsider-name 的偏好' });
  assert(!context.includes('bob')); assert(!context.includes('outsider')); assert(context.includes('alice'));
});

test('a person-card review discards late output after an unrelated authorization revocation and regrant', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  const channel = { store: f.store, now: () => f.now, closed: false, pauses: new Map(),
    transport: { status: () => ({ online: true, account: { id: f.accountId } }) },
    memory: { load: () => ({ generation: 'source-generation', entries: [] }) },
    runner: { extractRoleCard: () => gate.promise } };
  const maintenance = new PersonMemoryMaintenance(channel);
  clearTimeout(maintenance.wakeTimer); maintenance.wake = () => {};
  t.after(() => maintenance.close());
  const person = { accountId: f.accountId, personId: 'alice' }, source = { id: 'source-one', accountId: f.accountId,
    chatType: 'private', peerId: 'alice', senderId: 'alice', senderName: '阿宁', text: '叫我阿宁。', time: f.now,
    generation: 'source-generation', messageKey: 'source-one' };
  f.store.roleCards.observe(person, source, f.now, { urgent: true });
  const review = f.store.roleCards.beginReview(person, f.now);
  const pending = maintenance.update(person, new AbortController().signal, review);
  const original = f.store.settings(f.accountId);
  f.store.configure(f.accountId, { ...original, privatePeers: ['alice'] });
  f.store.data.authorizationRevocations = []; f.store.configure(f.accountId, original);
  const rejected = assert.rejects(pending, { code: 'AUTHORIZATION_CHANGED' });
  gate.resolve({ text: JSON.stringify({ updates: [{ field: 'addressAs', value: '阿宁',
    evidence: [{ sourceId: source.id, quote: source.text }] }], conflicts: [] }) });
  await rejected;
  const saved = f.store.roleCards.view(person);
  assert.equal(saved.card.addressAs, ''); assert.equal(saved.pendingCount, 1);
});
