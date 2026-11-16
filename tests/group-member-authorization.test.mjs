import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore, WechatChannel, conversationEligible, personAuthorized, authorizedPeople, conversationScopeAuthorized } from '../lib/testing.js';

const base = path.resolve('storage/tmp');
const GROUP = 'team@chatroom';

function fixture(t, options = {}) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'group-members-')), store = new StateStore(root), accountId = 'member-owner';
  store.configure(accountId, { enabled: true, privatePeers: ['alice', 'zed'], groups: [GROUP], prompt: '' });
  const now = Date.now(),
    status = { online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true },
    calls = [];
  const members = options.members ?? [
    { id: 'alice', groupId: GROUP },
    { id: 'bob', groupId: GROUP },
    { id: 'carol', groupId: GROUP },
    { id: 'dana', groupId: GROUP },
    { id: 'someone-else', groupId: 'other@chatroom' },
    { id: accountId, groupId: GROUP },
  ];
  const transport = {
    status: () => status,
    call: async (operation, input) => {
      calls.push({ operation, input });
      if (operation === 'members') {
        if (options.failMembers) throw Object.assign(new Error('群成员读取失败'), { code: 'WORKER_TIMEOUT' });
        // The worker returns only the rows of the requested group.
        return { accountId, peerId: input.peerId, members: members.filter(member => member.groupId === input.peerId).map(member => ({ ...member })) };
      }
      if (operation === 'contacts') return { accountId, privatePeers: [], groups: [] };
      return { accountId };
    },
  };
  const runner = {
    selection: () => ({ provider: 'fixture', model: 'fixture' }),
    defaultSelection: () => ({ provider: 'fixture', model: 'fixture' }),
    run: async () => ({ text: '模拟回复' }),
    extractRoleCard: async () => ({ text: '{"updates":[],"conflicts":[]}' }),
  };
  const channel = new WechatChannel({ store, runner, transport, now: () => now });
  t.after(async () => {
    await channel.close().catch(() => {});
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(base));
    assert(path.basename(target).startsWith('group-members-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { root, store, accountId, now, channel, transport, calls, status,
    setMembers: next => { members.length = 0; members.push(...next); } };
}

const person = (fixture, personId) => ({ accountId: fixture.accountId, personId });
const source = (fixture, personId, key, text = '我喜欢红茶。') => ({
  id: 'source-' + key, accountId: fixture.accountId, chatType: 'group', peerId: GROUP, conversationName: '项目组',
  messageKey: key, messageId: key, senderId: personId, senderName: personId, time: fixture.now, text,
  generation: 'group-generation',
});

test('authorized group members are authorized people and private chats need no second authorization', async t => {
  const f = fixture(t);
  await f.channel.groupMembers.sync(f.accountId);

  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), true, 'bob only appears in the authorized group');
  assert.equal(personAuthorized(f.store, f.accountId, 'carol'), true, 'a member without a groupId on the row still counts');
  assert.equal(personAuthorized(f.store, f.accountId, 'someone-else'), false, 'another group does not leak in');
  assert.equal(personAuthorized(f.store, f.accountId, f.accountId), false, 'the account is not a person');

  assert.deepEqual(authorizedPeople(f.store, f.accountId), ['alice', 'bob', 'carol', 'dana', 'zed']);
  assert.equal(conversationEligible(f.store, { accountId: f.accountId, chatType: 'group', peerId: GROUP }), true);
  // 群聊授权覆盖群成员的私聊：不必再把每个人单独加进私聊授权。
  assert.equal(conversationEligible(f.store, { accountId: f.accountId, chatType: 'private', peerId: 'bob' }), true);
  assert.equal(conversationEligible(f.store, { accountId: f.accountId, chatType: 'private', peerId: 'alice' }), true);
  // 访问判定：既没有私聊授权、也不在授权群里的好友仍不可用。
  assert.equal(conversationEligible(f.store, { accountId: f.accountId, chatType: 'private', peerId: 'dave' }), false);
  // 保留判定：群聊取消后其成员不再被覆盖；群成员身份变化不在这里删除资料。
  assert.equal(conversationScopeAuthorized(f.store, { accountId: f.accountId, chatType: 'group', peerId: 'other@chatroom' }), false);
  assert.equal(conversationScopeAuthorized(f.store, { accountId: f.accountId, chatType: 'private', peerId: 'carol' }), true);
});

test('the owner can still deny one member: an explicit revocation beats group membership', async t => {
  const f = fixture(t);
  await f.channel.groupMembers.sync(f.accountId);
  const original = f.store.settings(f.accountId);
  f.store.configure(f.accountId, { ...original, privatePeers: [...original.privatePeers, 'bob'] });
  await f.channel.authorization.whenIdle();
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), true);
  f.store.configure(f.accountId, original);
  await f.channel.authorization.whenIdle();
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), false, 'the exclusion survives bob staying in the group');
  assert.equal(conversationEligible(f.store, { accountId: f.accountId, chatType: 'private', peerId: 'bob' }), false);
  assert(!authorizedPeople(f.store, f.accountId).includes('bob'));
  // An explicit denial is the only case where group-derived data is cleaned up.
  assert.equal(conversationScopeAuthorized(f.store, { accountId: f.accountId, chatType: 'private', peerId: 'bob' }), false);
  // Granting the same person again clears the exclusion and their private reply.
  f.store.configure(f.accountId, { ...original, privatePeers: [...original.privatePeers, 'bob'] });
  await f.channel.authorization.whenIdle();
  assert.equal(f.store.data.groupMemberExclusions[f.accountId].excludedPersonIds.includes('bob'), false);
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), true);
  assert.equal(conversationEligible(f.store, { accountId: f.accountId, chatType: 'private', peerId: 'bob' }), true);
  // Removing the private grant again denies them once more, group membership included.
  f.store.configure(f.accountId, original);
  await f.channel.authorization.whenIdle();
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), false);
});

test('a failed member refresh keeps the last confirmed list instead of revoking everyone', async t => {
  const f = fixture(t);
  await f.channel.groupMembers.sync(f.accountId);
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), true);
  f.transport.call = async (operation, input) => {
    if (operation === 'members') throw Object.assign(new Error('群成员读取失败'), { code: 'WORKER_TIMEOUT' });
    return { accountId: f.accountId, peerId: input?.peerId };
  };
  await f.channel.groupMembers.sync(f.accountId);
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), true, 'a transient failure must not revoke the whole group');
  assert.match(f.channel.groupMembers.error, /部分群聊成员未能刷新/);
  const view = f.store.groupMemberIndexView(f.accountId);
  assert.equal(view.indexedGroups, 1);
  assert.equal(view.authorizedGroups, 1);
  assert.equal(view.members, 4, 'the retained list is still counted');
});

test('revoking a group drops its members from the derived authorization', async t => {
  const f = fixture(t);
  await f.channel.groupMembers.sync(f.accountId);
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), true);
  const settings = f.store.settings(f.accountId);
  f.store.configure(f.accountId, { ...settings, groups: [] });
  assert.equal(personAuthorized(f.store, f.accountId, 'bob'), false);
  assert.equal(personAuthorized(f.store, f.accountId, 'alice'), true, 'a private grant is independent');
  assert.deepEqual(authorizedPeople(f.store, f.accountId), ['alice', 'zed']);
});

test('startup cleanup never deletes a member card: leaving a group only revokes access', async t => {
  const f = fixture(t);
  await f.channel.groupMembers.sync(f.accountId);
  f.store.roleCards.observe(person(f, 'bob'), source(f, 'bob', 'bob-1'), f.now);
  f.store.roleCards.observe(person(f, 'dana'), source(f, 'dana', 'dana-1'), f.now);
  f.store.roleCards.observe(person(f, 'zed'), source(f, 'zed', 'zed-1'), f.now);
  const directory = personId => f.store.roleCards.paths(person(f, personId)).directory;
  assert(fs.existsSync(directory('bob')) && fs.existsSync(directory('dana')) && fs.existsSync(directory('zed')));

  // dana leaves the group; the next refresh only revokes the derived access.
  f.setMembers([{ id: 'alice', groupId: GROUP }, { id: 'bob', groupId: GROUP }, { id: 'carol', groupId: GROUP }]);
  await f.channel.groupMembers.sync(f.accountId);
  assert.equal(personAuthorized(f.store, f.accountId, 'dana'), false, 'a member who left loses the derived access');
  assert(!authorizedPeople(f.store, f.accountId).includes('dana'));

  // Model an explicit revocation and a restart: the channel is detached first.
  await f.channel.close();
  f.store.configure(f.accountId, { ...f.store.settings(f.accountId), privatePeers: ['alice'] });

  const restarted = new WechatChannel({
    store: f.store,
    runner: {
      selection: () => ({ provider: 'fixture', model: 'fixture' }), defaultSelection: () => ({ provider: 'fixture', model: 'fixture' }),
      run: async () => ({ text: '模拟回复' }), extractRoleCard: async () => ({ text: '{"updates":[],"conflicts":[]}' }),
    },
    transport: { status: () => ({ online: false, account: null }) },
    now: () => f.now,
  });
  try {
    await restarted.authorization.ready;
    assert(fs.existsSync(directory('bob')), 'a current member keeps their资料');
    assert(fs.existsSync(directory('dana')), 'losing membership never deletes资料');
    assert.equal(fs.existsSync(directory('zed')), false, 'an explicitly revoked person is still cleaned up');
  } finally {
    await restarted.close().catch(() => {});
  }
});