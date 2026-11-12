import { createHash, randomUUID } from 'node:crypto';
import { ChannelError, validateNaturalSettings, workSettings } from '../../shared/contracts.mjs';
import { TIME_FIELDS, timeSettings, timeValue, validateTimeValues, withTimeValues } from '../../shared/time-settings.mjs';
import { roleCardSettings } from '../../shared/role-card-settings.mjs';
import { imageGenerationSettings } from '../../shared/image-generation.mjs';
import { momentsReplyEnabled, momentsSettings } from '../../shared/moments.mjs';
import { momentsLikeSettings } from '../../shared/moments-likes.mjs';
import { materialSettings } from '../../shared/moments-materials.mjs';
import { interactionAutomationSettings } from '../../shared/moments-interaction-settings.mjs';
import { momentsPublishingSettings, momentsPlanSettings } from '../../shared/moments-publishing.mjs';
import { validateImageMemorySettings } from '../memory/images/store.mjs';

export const endpoints = ['time.configure'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const view = group => ({ id: group.id, kind: group.kind, title: group.title, category: group.category,
  values: Object.fromEntries(TIME_FIELDS[group.kind].map(field => [field.key, timeValue(group.original, field.key)])), revision: hash(group.original),
  ...(group.schedule ? { schedule: group.schedule } : {}) });

function groups(context, payload, signal) {
  const { store, channel, currentAccount, conversation } = context;
  const result = [];
  const add = (id, kind, title, category, original, save, schedule) => result.push({ id, kind, title, category, original, save, schedule });
  const commit = (name, value) => {
    const next = store.config.snapshot(store.data); next[name] = value;
    store.config.commit(store.config.validate(next));
  };
  add('runtime', 'runtime', '聊天、搜索与朋友圈处理超时', '全局', timeSettings(store.config.section('timeSettings')), value => commit('timeSettings', timeSettings(value)));
  add('role', 'role', '人物角色卡整理', '全局', store.roleCardSettings(), value => channel.personMemory.configure(roleCardSettings(value), store.roleCardSettingsView().revision));
  add('work', 'work', '工作命令', '全局', store.config.section('work'), value => commit('work', workSettings(value)));
  add('memory', 'memory', '会话与长期记忆保存期限', '全局', store.config.section('memory'), value => commit('memory', value));
  add('image-defaults', 'images', '图片记忆默认保存期限', '全局', store.config.section('imageMemoryDefaults'), value => commit('imageMemoryDefaults', validateImageMemorySettings(value)));
  const defaults = store.config.section('conversationDefaults');
  add('natural-defaults', 'natural', '自然陪聊默认节奏', '全局', defaults.natural, value => {
    commit('conversationDefaults', { ...defaults, natural: validateNaturalSettings(value) });
    for (const peer of Object.values(store.data.conversations).filter(peer => peer.chatType === 'group' && !store.data.conversationConfigs[peer.key])) reschedule(peer);
  });
  const image = store.config.section('imageGeneration');
  for (const provider of image.providers) add('provider:' + provider.id, 'provider', '生图接口 · ' + (provider.name || provider.id), '全局', provider, async value => {
    commit('imageGeneration', imageGenerationSettings({ ...image, providers: image.providers.map(row => row.id === provider.id ? value : row) }));
    await channel.work.imageGeneration.refreshCredential();
  });
  const reschedule = scope => {
    const config = store.conversationSettings(scope.accountId, scope.chatType, scope.peerId);
    if (config.mode === 'natural') {
      const state = channel.natural.state(scope, config);
      state.nextCheckAt = channel.now() + channel.natural.delay(config, state);
      channel.natural.save(scope, state);
    }
  };
  if (!payload.accountId) return result;
  const account = currentAccount(payload), automation = channel.momentsAutomation;
  const roleSettings = store.roleCardSettings(), people = store.roleCards.list(account.id);
  const roleRunning = people.some(person => channel.personMemory.state(person) === 'updating');
  const roleTimes = people.filter(person => channel.personMemory.state(person) !== 'disabled' && person.nextAt > 0).map(person => person.nextAt);
  if (roleSettings.trigger === 'time' || roleTimes.length || roleRunning) result.find(group => group.id === 'role').schedule = {
    at: roleTimes.length ? Math.min(...roleTimes) : null, enabled: roleSettings.enabled, running: roleRunning, action: '整理', paused: channel.fault || channel.closed,
  };
  const timing = (manager, rule, action, extra = {}) => ({ at: rule.nextRunAt, enabled: rule.settings.enabled,
    running: manager.activeAccount === account.id, paused: manager.error || manager.stopped === true, action, ...extra });
  if (automation) {
    const replies = automation.rule(account.id), likes = automation.likes.rule(account.id), materials = automation.materials.account(account.id);
    add('replies', 'replies', '朋友圈评论抓取与接续回复', '当前微信账号', replies.settings, value => automation.configure(account.id, momentsSettings(value), { timeOnly: true }),
      timing(automation, replies, '检查', { enabled: momentsReplyEnabled(replies.settings) }));
    add('likes', 'likes', '好友定时点赞', '当前微信账号', likes.settings, value => automation.likes.configure(account.id, momentsLikeSettings(value), { timeOnly: true }),
      timing(automation.likes, likes, '检查', { paused: automation.likes.error || automation.likes.stopped || !likes.settings.userIds.length }));
    const schedule = automation.interactions.automation;
    add('interactions', 'interactions', '朋友圈自动点赞与评论', '当前微信账号', schedule.rule(account.id).settings,
      value => schedule.configure(account.id, interactionAutomationSettings(value), schedule.rule(account.id).revision, signal, () => currentAccount(payload), undefined, { timeOnly: true }),
      timing(schedule, schedule.rule(account.id), '检查', { running: schedule.active?.accountId === account.id, paused: schedule.pauseReason(account.id, schedule.rule(account.id)) }));
    add('materials', 'materials', '朋友圈聊天素材整理', '当前微信账号', materials.settings, value => automation.materials.configure(account.id, materialSettings(value)),
      timing(automation.materials, materials, '整理', { paused: automation.materials.error || !materials.settings.sources.length }));
    const publishing = automation.publishing, publishingData = publishing.list(account.id);
    const nextPlan = publishingData.plans.find(plan => plan.settings.enabled && plan.nextRunAt > 0 && (!plan.automatic || publishingData.settings.automatic.enabled));
    add('publishing', 'publishing', '朋友圈自动发布与安排时段', '当前微信账号', publishingData.settings,
      value => publishing.configure(account.id, momentsPublishingSettings(value), signal, () => currentAccount(payload), { timeOnly: true }),
      timing(publishing, { ...publishingData, nextRunAt: nextPlan?.nextRunAt }, '发布'));
    for (const plan of publishingData.plans) add('plan:' + plan.id, 'plan', '发布计划 · ' + plan.settings.name, '当前微信账号', plan.settings,
      value => publishing.savePlan(account.id, momentsPlanSettings(value), plan.id, 'ui-moments-' + randomUUID(), signal, () => currentAccount(payload), { timeOnly: true }),
      plan.nextRunAt > 0 || !plan.settings.enabled || publishingData.activePlanId === plan.id ? timing(publishing, plan, plan.settings.reviewRequired ? '生成草稿' : '发布', {
        running: publishingData.running && publishingData.activePlanId === plan.id,
        paused: publishingData.error || !publishingData.schedulerStarted || !publishingData.settings.enabled || plan.automatic && !publishingData.settings.automatic.enabled,
      }) : undefined);
  }
  if (payload.peerId) {
    const scope = conversation(payload), config = store.conversationSettings(scope.accountId, scope.chatType, scope.peerId);
    if (scope.chatType === 'group') {
      const natural = config.mode === 'natural' ? channel.natural.summary(scope) : null;
      add('natural', 'natural', '此群的自然陪聊节奏', '所选会话', config.natural, value => {
        store.setConversationSettings(scope.accountId, scope.chatType, scope.peerId, { ...config, natural: validateNaturalSettings(value) }); reschedule(scope);
      }, natural ? { at: natural.nextCheckAt, enabled: true, running: natural.pending, paused: natural.paused, action: '判断' } : undefined);
    }
    for (const collection of ['conversation', 'generated']) {
      const input = { ...scope, collection }, state = channel.imageMemory.load(input);
      add('images:' + collection, 'images', collection === 'generated' ? '此会话的生成图片保存期限' : '此会话的聊天图片保存期限', '所选会话', state.settings,
        value => context.paused('正在应用此会话的图片保存期限', () => {
          currentAccount(payload);
          const result = channel.imageMemory.configure(input, validateImageMemorySettings(value));
          store.resetSessions(scope); return result;
        }, scope, { resetProgress: false }));
    }
  }
  return result;
}

export function listTimeSettings(context, payload = {}) {
  return { groups: groups(context, payload).map(view) };
}
export async function timeMutation(context, endpoint, payload, signal) {
  context.assertLive(signal); context.store.config.assertCurrent();
  const group = groups(context, payload, signal).find(row => row.id === payload.id);
  if (!group) throw new ChannelError('INVALID_TIME_SETTINGS', '时间设置不存在或当前账号已变化，请重新载入');
  if (payload.revision !== hash(group.original)) throw new ChannelError('TIME_SETTINGS_CHANGED', '此项设置已变化，请重新载入最新设置后保存；当前草稿保留');
  validateTimeValues(group.kind, payload.values);
  await group.save(withTimeValues(group.original, payload.values));
  context.assertLive(signal);
  return listTimeSettings(context, payload);
}
