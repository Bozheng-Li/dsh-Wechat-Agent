const STOP = new Set(['这个', '那个', '一下', '什么', '怎么', '可以', '还是', '现在', '今天', '刚才', '表情', '表情包', '小图', '图片', '知道', '没有', '一个', '一下子']);
// Retrieval aliases only: these never select/send a sticker or infer a person's mood.
const SCENES = [
  [/谢谢|多谢|辛苦|感谢|thank/iu, ['感谢', '赞同', '点头', '收到']],
  [/哈哈|笑死|好笑|lol|haha/iu, ['开心', '大笑', '搞笑', '玩笑']],
  [/好耶|太好了|开心|成功|搞定|过了|拿下/iu, ['庆祝', '开心', '高兴', '鼓掌']],
  [/晚安|睡觉|困了/u, ['晚安', '睡觉', '困倦']],
  [/早上好|早安|你好|hello|\bhi\b/iu, ['问候', '打招呼']],
  [/好吧|好的|收到|行吧|明白/u, ['收到', '点头', '赞同']],
  [/难过|伤心|难受|累了|疲惫/u, ['安慰', '陪伴', '疲惫']],
];
function terms(text, names) {
  let value = String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/https?:\/\/\S+/gu, '');
  for (const name of names.filter(name => typeof name === 'string' && name.length >= 2)) value = value.replaceAll(name.normalize('NFKC').toLocaleLowerCase(), ' ');
  const set = new Set();
  for (const token of value.match(/[\p{Script=Han}]+|[a-z]{2,}/gu) || []) {
    if (/^[a-z]+$/u.test(token)) { if (!STOP.has(token)) set.add(token); continue; }
    if (token.length >= 2 && token.length <= 5 && !STOP.has(token)) set.add(token);
    for (let i = 0; i + 2 <= token.length; i++) {
      const part = token.slice(i, i + 2);
      if (!STOP.has(part) && !/[你我他她它的了吗吧呀呢]/u.test(part)) set.add(part);
    }
  }
  for (const [pattern, aliases] of SCENES) if (pattern.test(value)) for (const word of aliases) set.add(word);
  return [...set].slice(0, 60);
}
const normalized = value => String(value || '').normalize('NFKC').toLocaleLowerCase();
function match(asset, words) {
  const usage = normalized(asset.usage), description = normalized(asset.description), name = normalized(asset.name);
  const tags = (asset.tags || []).map(normalized).join(' ');
  return words.reduce((sum, term) => sum + (usage.includes(term) ? 4 : 0) + (tags.includes(term) ? 3 : 0) +
    (name.includes(term) ? 2 : 0) + (description.includes(term) ? 1 : 0), 0);
}

/** Rank the whole enabled sticker library; suggestions never auto-send. */
export function selectStickerCandidates(assets, { text = '', history = [], names = [], explicitRequest = false,
  limit = 4, random = Math.random } = {}) {
  const current = terms(text, names);
  const context = terms(history.slice(-4).map(row => row.text || '').join(' '), names);
  const ranked = assets.filter(asset => asset.kind === 'sticker' && (explicitRequest || asset.description?.trim() || asset.usage?.trim()))
    .map(asset => ({ asset, relevance: match(asset, current) * 4 + match(asset, context),
      tie: typeof random === 'function' ? Math.max(0, Math.min(1, Number(random()) || 0)) : 0 }));
  ranked.sort((a, b) => b.relevance - a.relevance || Number(!!b.asset.nativeSticker?.favorite) - Number(!!a.asset.nativeSticker?.favorite) ||
    b.tie - a.tie || String(a.asset.id).localeCompare(String(b.asset.id)));
  const selected = ranked.slice(0, Math.max(1, Math.min(8, limit)));
  return { candidates: selected.map(row => row.asset), eligibleCount: ranked.length,
    relevantCount: selected.filter(row => row.relevance > 0).length };
}
