import { replyClock } from '../shared/time.mjs';

export const REPLY_CLOCK_RULE = '当前本地时间只说明本轮现在的昼夜语境，不替用户推断计划，也不规定固定回复。原消息时间、历史内容、引用和图片/表情文字各自保留来源时间与用途，不会把其中的字样变成“现在”。判断当前发言是在打招呼、引用、接梗、展示素材，还是明确说明自己的安排。白天收到或看到写着“晚安”的贴图/引用，不等同于对方正在道晚安；按当下白天的对话接住素材或玩笑，可以自然点出反差，不要像夜间一样机械回祝晚安，也不必报时纠正。若对方明确说自己白天要睡或刚下夜班，则尊重他的真实安排。正文与媒体 caption 使用同一语境；不据时钟编造地点、天气或活动。原话中的相对日期以该条消息的本地发送日期为基准，先确定具体日期；你现在回复时的“今天/明天/昨天”则以回复时钟为基准。排队跨日或重述历史约定时，保留原约定的具体日期，不原样沿用已经换了指向的相对日期词；直接说月日和时刻即可。引用原文时可保留原词，但须与自己的确认区分。';

export function messageDateContext(clock) {
  if (!clock?.messageTime) return '';
  const sentDate = clock.messageTime.slice(0, 10), replyDate = clock.currentTime.slice(0, 10);
  const shift = days => {
    const date = new Date(sentDate + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  return '本条原消息的时间标签（不是用户原话）：' + JSON.stringify({
    sentAt: clock.messageTime, replyAt: clock.currentTime, timeZone: clock.timeZone,
    originalMessageDates: { yesterday: shift(-1), today: sentDate, tomorrow: shift(1) },
    replyDate,
  }) + '\n上面的 yesterday/today/tomorrow 是原消息说出时的昨天/今天/明天；先按该日期理解下面的原话，再从回复日期表述，不把原话的相对词直接移到现在。';
}

export function replyClockInstructions(clock = replyClock()) {
  return [`当前时间：${clock.currentTime}，时区 ${clock.timeZone}，当前本地时段：${clock.currentDayPeriod || '以本地时间为准'}（本轮回复开始时）。`,
    clock.messageTime ? `原消息时间：${clock.messageTime}（消息发送时，不是排队后的现在）。` : '',
    REPLY_CLOCK_RULE].filter(Boolean).join('\n');
}
