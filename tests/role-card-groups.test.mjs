import test from 'node:test';
import assert from 'node:assert/strict';
import { roleCardGroups } from '../frontend/pages/memory/role-card-groups.mjs';
import { filledRoleCardFields, roleCardHasData } from '../shared/role-card.mjs';

const people = [
  { personId: 'alice', name: '小宁', filledFields: 1, updatedAt: 300, aliases: [], preview: { preferences: '喜欢红茶' } },
  { personId: 'bob', name: '小宁', filledFields: 3, updatedAt: 100, aliases: [], preview: { background: '学习计算机' } },
  { personId: 'carol', name: '小禾', filledFields: 2, updatedAt: 200, aliases: [], preview: { preferences: '喜欢骑行' } },
  { personId: 'group-only', name: '群友', filledFields: 4, updatedAt: 400, aliases: [], preview: {} },
];
const audience = { source: 'wechat-contacts-live', membershipComplete: true,
  contacts: [{ id: 'alice', labelIds: ['1'] }, { id: 'bob', labelIds: ['1', '2', '1'] }, { id: 'carol', labelIds: [] }],
  labels: [{ id: '1', name: '计实一班' }, { id: '2', name: '摄影朋友' }, { id: '3', name: '空标签' }] };

test('actual contact ids join labels, overlap without merging same names, and untagged people come last', () => {
  const result = roleCardGroups(people, audience);
  assert.deepEqual(result.groups.map(group => [group.name, group.people.map(row => row.personId)]), [
    ['计实一班', ['bob', 'alice']], ['摄影朋友', ['bob']], ['未标签', ['group-only', 'carol']],
  ]);
  assert.equal(result.filtered.length, 4, 'overlapping tags count each person once');
  assert.deepEqual(people.map(row => row.personId), ['alice', 'bob', 'carol', 'group-only'], 'grouping leaves the source rows intact');
});

test('tag search retains distinct identities and cards still sort by number of fields', () => {
  assert.deepEqual(roleCardGroups(people, audience, '计实一班').filtered.map(row => row.personId), ['bob', 'alice']);
  assert.deepEqual(roleCardGroups(people, audience, '未标签').filtered.map(row => row.personId), ['group-only', 'carol']);
  assert.deepEqual(roleCardGroups(people, audience, '小宁').filtered.map(row => row.personId), ['bob', 'alice']);
  assert.deepEqual(roleCardGroups(people, audience, '红茶').filtered.map(row => row.personId), ['alice']);
});

test('unread or incomplete labels stay unknown rather than being claimed as untagged', () => {
  for (const snapshot of [null, { ...audience, membershipComplete: false }, { ...audience, source: 'cache' }]) {
    const result = roleCardGroups(people, snapshot);
    assert.deepEqual(result.groups.map(group => group.name), ['标签待读取']);
    assert.equal(roleCardGroups(people, snapshot, '未标签').filtered.length, 0);
  }
});

test('names and conflicting fields do not establish a card or inflate its usable detail count', () => {
  const card = { label: '小宁', addressAs: '  ', preferences: '喜欢红茶' }, conflicts = [{ field: 'preferences' }];
  assert.equal(roleCardHasData(card, conflicts), false);
  assert.deepEqual(filledRoleCardFields(card, conflicts), ['label']);
  assert.equal(roleCardHasData(card), true);
  assert.deepEqual(filledRoleCardFields(card), ['label', 'preferences']);
});
