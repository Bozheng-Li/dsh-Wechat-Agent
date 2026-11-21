import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationInputMessages } from '../modules/agent/conversation-input.mjs';
import { replyClock, localMessageTime } from '../prompts/shared/time.mjs';
import { messageDateContext } from '../prompts/reply/clock.mjs';
import { buildWechatPrompt } from '../prompts/reply/compose.mjs';
import { parsePersonaPlan, personaPassInput } from '../modules/agent/persona-pass.mjs';
import { resolveTargets, recentRoleHistory, roleNameMentioned } from '../modules/memory/roles/retrieval.mjs';
import { readableRoleCard } from '../modules/memory/roles/tool.mjs';
import { emptyRoleCard } from '../shared/role-card.mjs';
import { distillCandidates, distillPersona } from '../modules/agent/style-distill.mjs';
import { deidentifyStyleLine } from '../modules/agent/style-summary.mjs';
import { agentMutation } from '../modules/agent/actions.mjs';

const scope = { accountId: 'owner', chatType: 'group', peerId: 'room@chatroom' };
const people = [{ accountId: 'owner', id: 'alice', name: '阿甲', aliases: [] }, { accountId: 'owner', id: 'bob', name: '阿乙', aliases: [] }];
const speaker = { id: 'alice', name: '阿甲' };
const at = Date.parse('2026-11-21T12:00:00+08:00');
const data = over => ({ scope, people, speaker, history: [], now: at, beforeTime: at, ...over });

test('history stays in reception order with author, direction and first-person ownership', () => {
  const clock = replyClock({ now: at, messageTime: at - 1000, timeZone: 'Asia/Shanghai' });
  const rows = conversationInputMessages({ current: '解释我刚才的话', speaker, clock, history: [
    { text: '我们先走了', senderId: 'alice', direction: 'incoming', time: at - 3000, order: 9 },
    { text: '旧助手口气', senderId: 'owner', direction: 'outgoing', time: at - 2000, order: 10 },
  ] });
  assert(rows.every(row => row.role === 'user'));
  assert(rows[0].content.includes('我们先走了')); assert(rows[0].content.includes('不能把他的我/我们变成机器人自称'));
  assert(rows[1].content.includes('历史本账号发言')); assert(rows[1].content.includes('"order":10'));
  assert(rows.at(-1).content.includes('解释我刚才的话')); assert(rows.at(-1).content.includes('originalMessageDates'));
});

test('one reply clock distinguishes cross-midnight message date from the reply date', () => {
  const clock = replyClock({ now: Date.parse('2026-11-21T00:00:02+08:00'), messageTime: Date.parse('2026-11-20T23:59:58+08:00'), timeZone: 'Asia/Shanghai' });
  const label = messageDateContext(clock);
  assert(label.includes('"today":"2026-11-20"')); assert(label.includes('"tomorrow":"2026-11-21"')); assert(label.includes('"replyDate":"2026-11-21"'));
  assert.equal(localMessageTime(Date.parse('2026-11-21T00:00:00+08:00') / 1000, 'UTC'), '2026-11-20T16:00:00+00:00');
});

test('planning excludes persona in both strategies but keeps owner requirements and real clock', () => {
  for (const promptStrategy of ['legacy', 'progressive-v1']) {
    const prompt = buildWechatPrompt({ persona: { name: '小满', aliases: [], prompt: 'CUSTOM_PERSONA_BODY' }, includePersona: false,
      prompt: 'OWNER_RULE', identityMarkdown: 'GLOBAL_RULE', promptStrategy,
      clock: replyClock({ now: at, timeZone: 'Asia/Shanghai' }) });
    assert(!prompt.includes('CUSTOM_PERSONA_BODY')); assert(prompt.includes('OWNER_RULE')); assert(prompt.includes('GLOBAL_RULE'));
    assert(prompt.includes('2026-11-21T12:00:00+08:00'));
  }
});

test('long and unstructured working materials survive with explicit evidence omission markers', () => {
  assert.deepEqual(parsePersonaPlan('普通工作草稿'), { format: 'working-notes', notes: '普通工作草稿' });
  const facts = Array.from({ length: 25 }, (_, i) => '事实' + i);
  const packet = parsePersonaPlan(JSON.stringify({ facts })); assert.equal(packet.facts.length, 25);
  const result = JSON.parse(personaPassInput('继续', packet, { memory: '资料'.repeat(10000), history: Array.from({ length: 30 }, (_, index) => ({ text: '消息' + index })),
    toolResults: Array.from({ length: 15 }, (_, index) => ({ name: 'tool' + index, content: '已完成证据' })) }));
  assert.equal(result.recentConversation.length, 20); assert.equal(result.recentConversationOmitted, true);
  assert.equal(result.references[0].omitted, true); assert.equal(result.toolEvidenceOmitted, true);
});

test('guitar and other words do not choose a person; recent bot topic can resolve an actual pronoun', () => {
  for (const query of ['买吉他有什么偏好', '还有其他要求吗']) assert.deepEqual(resolveTargets(data({ query })).targets, ['alice']);
  const target = resolveTargets(data({ query: '那他喜欢什么', history: [{ direction: 'incoming', senderId: 'alice', text: '阿甲喜欢咖啡', time: at - 3000 },
    { direction: 'outgoing', text: '说回阿乙', time: at - 2000 }] }));
  assert.deepEqual(target.targets, ['bob']); assert.equal(target.referenceDirection, 'outgoing');
  assert.equal(roleNameMentioned('问Annie', 'Ann'), false); assert.equal(roleNameMentioned('Ann 怎么说', 'Ann'), true);
});

test('reliable stored ordinals win over clock skew and old or foreign history cannot revive a topic', () => {
  const history = [{ direction: 'incoming', text: '先到', time: at - 1000, order: 2 }, { direction: 'outgoing', text: '后到', time: at - 2000, order: 3 },
    { direction: 'incoming', text: '其他账号', accountId: 'foreign', time: at - 500, order: 4 }];
  assert.deepEqual(recentRoleHistory(data({ history })).map(row => row.text), ['先到', '后到']);
  assert.deepEqual(resolveTargets(data({ query: '那他呢', history: [{ direction: 'incoming', text: '阿乙来了', time: at - 86400000 }] })).targets, []);
});

test('late background source remains readable and future/unknown timing is explicitly labelled', () => {
  const view = { personId: 'alice', scope: { accountId: 'owner', personId: 'alice' }, card: { ...emptyRoleCard(), preferences: '喜欢茶' },
    evidence: { preferences: { sourceAt: at - 2000, updatedAt: at + 1000, sources: [{ time: at - 2000, senderId: 'alice', accountId: 'owner' }] } },
    updatedAt: at + 1000, conflicts: [], changes: [] };
  const current = readableRoleCard(view, at);
  assert.equal(current.card.preferences, '喜欢茶'); assert.equal(current.timing.preferences.status, 'background-update');
  view.evidence.preferences.sourceAt = at + 1000; view.evidence.preferences.sources[0].time = at + 1000;
  assert.equal(readableRoleCard(view, at).timing.preferences.status, 'after-request');
  view.evidence.preferences.sources[0].accountId = 'foreign'; assert.equal(readableRoleCard(view, at).card.preferences, '');
});

test('privacy clearing overrides old values even after a new value is added', () => {
  const view = { personId: 'alice', card: { ...emptyRoleCard(), addressAs: '新称呼' }, evidence: { addressAs: { sourceAt: 4000 } },
    conflicts: [], changes: [{ field: 'addressAs', before: '', after: '', at: 3000 }, { field: 'addressAs', before: '', after: '新称呼', at: 4000 }] };
  assert.equal(readableRoleCard(view, 2000).card.addressAs, '');
});

test('style sampling uses only authorized people and contexts with basic anonymization', () => {
  const settings = { enabled: true, groups: ['room@chatroom'], privatePeers: ['alice'], prompt: '' };
  const peers = [{ ...scope, name: '示例群' }];
  const store = { data: {}, settings: () => settings, conversations: () => peers, persona: () => ({ name: '助手', aliases: [] }) };
  const memory = { view: () => ({ entries: [
    { direction: 'incoming', senderId: 'blocked', senderName: '外人', text: '不能读取的相邻话', time: at - 3000 },
    { direction: 'incoming', senderId: 'alice', senderName: '阿甲', text: '阿甲手机13812345678，晚上再说', time: at - 2000 },
  ] }) };
  const candidates = distillCandidates({ store, memory, accountId: 'owner' }); assert.deepEqual(candidates.map(person => person.senderId), ['alice']);
  const distilled = distillPersona({ store, memory, accountId: 'owner', senderId: 'alice' });
  assert.equal(distilled.samples.length, 1); assert(!JSON.stringify(distilled.samples).includes('不能读取的相邻话'));
  assert(!JSON.stringify(distilled.samples).includes('13812345678')); assert(!JSON.stringify(distilled.samples).includes('阿甲'));
  assert(deidentifyStyleLine('阿甲的邮件 a@example.com', ['阿甲']).includes('[邮箱]'));
});

test('persona mutations use library APIs, reset sessions, return status and reject stale save targets', async () => {
  let active = 'p1', resets = 0; const operations = [];
  const store = { activePersonaId: () => active, personasView: () => ({ activeId: active }), persona: () => ({ name: '旧名', aliases: [], prompt: '旧设定' }),
    resetSessions() { resets++; }, createPersona(payload) { operations.push(payload); active = 'p2'; },
    selectPersona(id) { active = id; }, deletePersona(id) { operations.push(id); } };
  const context = { store, status: () => ({ personas: store.personasView() }), paused: async (_reason, next) => next(), assertLive() {} };
  const value = { name: '新名', aliases: [], prompt: '新正文', personaMode: 'standard' };
  const created = await agentMutation(context, 'persona.create', { persona: value, name: '条目标题', source: 'distilled' }, new AbortController().signal);
  assert.equal(created.personas.activeId, 'p2'); assert.equal(resets, 1); assert.equal(operations[0].name, '条目标题');
  await assert.rejects(agentMutation(context, 'persona.save', { id: 'p1', persona: value }, new AbortController().signal), { code: 'PERSONA_CHANGED' });
});
