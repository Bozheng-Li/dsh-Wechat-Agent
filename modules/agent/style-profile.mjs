/**
 * Turn a person's messages into measurable speaking habits.
 * Nothing here keeps the original wording: the output is numbers and rates,
 * so a persona can be rebuilt without copying anyone's lines.
 */

const CJK = /[\u4e00-\u9fa5]/u;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;
// Register markers, not content: these only decide "coarse" vs "plain".
const COARSE = /(?:我靠|卧槽|操|傻[逼呗]|二逼|牛魔|尼玛|他妈的|妈的|离谱|逆天|绝了|服了|崩了)/u;
const SOFTEN = /(?:啦|呀|哦|哟|嘻嘻|嘿嘿|么么)/u;

const len = text => Array.from(text).length;
const usableText = row => {
  const text = String(row.text ?? '').replace(/\s+/gu, ' ').trim();
  if (!text || len(text) > 300 || !CJK.test(text) || /^https?:\/\//u.test(text) || /^\[[^\]]+\]$/u.test(text)) return null;
  return text;
};
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] ?? 0;
const rate = (rows, test) => rows.length ? Math.round(rows.filter(test).length / rows.length * 1000) / 10 : 0;

export function styleProfile(messages = []) {
  const rows = messages.filter(row => row && (row.direction === 'incoming' || row.direction === undefined) && !row.mediaOnly && usableText(row))
    .map((row, index) => ({ ...row, sampleIndex: index }))
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0) || b.sampleIndex - a.sampleIndex).slice(0, 1200)
    .sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0) || a.sampleIndex - b.sampleIndex);
  const texts = rows.map(usableText);
  const lengths = texts.map(len).sort((a, b) => a - b);
  const total = texts.length || 1;

  // Bursts: consecutive messages by the same sender within a minute read as one turn.
  let bursts = 0, burstMessages = 0, run = 0, previousAt = null, previousScope = null;
  for (const row of rows) {
    const at = Number.isFinite(Number(row.time)) ? Number(row.time) : null;
    const scope = JSON.stringify([row.scope?.accountId, row.chatType, row.scope?.peerId, row.senderId]);
    if (run && at !== null && previousAt !== null && at >= previousAt && at - previousAt <= 60_000 && scope === previousScope) {
      run += 1; burstMessages += 1;
    } else { if (run) bursts += 1; run = 1; burstMessages += 1; }
    previousAt = at; previousScope = scope;
  }
  if (run) bursts += 1;

  const ending = test => rate(texts, test);
  return {
    version: 1,
    messages: texts.length,
    length: {
      p10: percentile(lengths, 0.1), p25: percentile(lengths, 0.25),
      median: percentile(lengths, 0.5), p75: percentile(lengths, 0.75), p90: percentile(lengths, 0.9),
    },
    share: {
      veryShort: rate(texts, text => len(text) <= 4),
      short: rate(texts, text => len(text) <= 8),
      medium: rate(texts, text => len(text) > 8 && len(text) <= 20),
      long: rate(texts, text => len(text) > 20),
    },
    punctuation: {
      period: ending(text => /[。.]$/u.test(text)),
      question: ending(text => /[?？]/u.test(text)),
      exclaim: ending(text => /[!！]/u.test(text)),
      tilde: ending(text => /[~～]/u.test(text)),
      ellipsis: ending(text => /(?:…|\.{3})/u.test(text)),
      none: ending(text => !/[。.?!？！~～…]$/u.test(text)),
    },
    extras: {
      emoji: rate(texts, text => EMOJI.test(text)),
      latin: rate(texts, text => /[A-Za-z]/u.test(text)),
      digits: rate(texts, text => /\d/u.test(text)),
      newline: rate(texts, text => /\n/u.test(text)),
      mention: rate(texts, text => /@/u.test(text)),
    },
    particles: Object.fromEntries(['啊', '吧', '呢', '哈', '嘛', '呗', '哦', '呀', '啦']
      .map(value => [value, rate(texts, text => text.includes(value))])),
    register: {
      coarse: rate(texts, text => COARSE.test(text)),
      soften: rate(texts, text => SOFTEN.test(text)),
    },
    bursts: { count: bursts, averageMessages: bursts ? Math.round(burstMessages / bursts * 10) / 10 : 0 },
    totalChars: texts.reduce((sum, text) => sum + len(text), 0),
    // Sample count is part of the result: too few messages must not be dressed up as a habit.
    confidence: texts.length >= 60 ? 'high' : texts.length >= 25 ? 'medium' : 'low',
  };
}

/** A short, human-readable summary for logs and the owner UI. */
export function describeStyle(profile) {
  const { length: size, punctuation: mark, share, register, bursts } = profile;
  return [
    `${profile.messages} 条发言（可信度 ${profile.confidence}）`,
    `长度中位 ${size.median} 字，四分之一在 ${size.p25} 字以内`,
    `${share.short}% 的消息不超过 8 字，${share.long}% 超过 20 字`,
    `句号结尾 ${mark.period}%，无标点 ${mark.none}%，问号 ${mark.question}%`,
    `连发 ${bursts.count} 次，平均每次 ${bursts.averageMessages} 条`,
    `糙字 ${register.coarse}%，软语气 ${register.soften}%`,
  ].join('；');
}
