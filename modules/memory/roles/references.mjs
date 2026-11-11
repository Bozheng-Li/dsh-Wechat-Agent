import { createHash } from 'node:crypto';

const relationships = '妈妈|爸爸|父亲|母亲|哥哥|姐姐|弟弟|妹妹|儿子|女儿|丈夫|妻子|老公|老婆|对象|伴侣|同事|朋友|室友|同学|老师|客户|领导|老板|妈(?!妈)|爸(?!爸)|哥(?!哥)|姐(?!姐)|弟(?!弟)|妹(?!妹)';
const predicates = '对|不|只|喜欢|爱|讨厌|平时|现在|最近|今天|明天|后天|已经|要|会|想|在|住|有|是|说|吃|喝|过敏';
const localName = `((?!(?:${predicates}|都|很|也|了|刚|正在|我|你|他|她))[\\p{Script=Han}A-Za-z·]{1,12}?)`;
const relationPattern = new RegExp(`我(?:的)?(${relationships})(?!名叫|叫)${localName}(?=${predicates})`, 'gu');
const namedRelationPattern = new RegExp(`我(?:的)?(${relationships})(?:名叫|叫)${localName}(?=[，,。；;！？!?\\s]|$|${predicates})`, 'gu');
const unnamedRelationPattern = new RegExp(`我(?:的)?(${relationships})(?=${predicates}|刚满|很|正在)`, 'gu');
const relationName = value => ({ 妈: '妈妈', 母亲: '妈妈', 爸: '爸爸', 父亲: '爸爸', 哥: '哥哥', 姐: '姐姐', 弟: '弟弟', 妹: '妹妹' }[value] || value);

/** Short names need a syntactic mention boundary, not an arbitrary substring. */
export function nameMentioned(text, name) {
  if (!name || !text.includes(name)) return false;
  if ([...name].length > 1) return true;
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + name.length)) {
    const before = text.slice(0, at), after = text.slice(at + name.length);
    if ((!before || /[\s，,。；;！？!?@、]$/u.test(before) || /(?:给|替|问|找|关于|还有|包括)$/u.test(before)) &&
        (!after || /^[\s，,。；;！？!?、的和跟与不对吃喝说要会想在有是]/u.test(after) || /^(?:喜欢|平时|最近|今天)/u.test(after))) return true;
  }
  return false;
}

export function explicitRelatives(text) {
  return [...text.matchAll(relationPattern), ...text.matchAll(namedRelationPattern), ...text.matchAll(unnamedRelationPattern)]
    .map(match => ({ relationship: relationName(match[1]), name: match[2] || '', phrase: match[0] }));
}

/** A mentioned relative is local evidence, never a guessed WeChat contact id. */
export function mentionedPeople(people, sources, scope) {
  if (!scope) return [];
  const values = new Map();
  for (const source of sources) {
    if (source.direction !== 'incoming' || !source.senderId) continue;
    const owner = people.find(person => person.id === source.senderId);
    if (!owner) continue;
    for (const { relationship, name } of explicitRelatives(source.text || '')) {
      const id = 'mentioned-' + createHash('sha256').update(JSON.stringify([scope.accountId, scope.chatType, scope.peerId, owner.id, relationship, name])).digest('hex').slice(0, 32);
      values.set(id, { accountId: scope.accountId, id, name: name || owner.name + '的' + relationship,
        aliases: [owner.name + '的' + relationship, owner.name + '的' + relationship + name],
        reference: { ownerId: owner.id, relationship, name } });
    }
  }
  return [...values.values()];
}

export function referenceMatches(person, text, ownerId) {
  return person.reference?.ownerId === ownerId && explicitRelatives(text).some(value =>
    value.relationship === person.reference.relationship && value.name === person.reference.name);
}

export function ownRelativeMention(person, text, ownerId) {
  if (person.reference?.ownerId !== ownerId) return false;
  return [...text.matchAll(new RegExp(`我(?:的)?(${relationships})`, 'gu'))]
    .some(match => relationName(match[1]) === person.reference.relationship);
}

export function factSourceTime(fact) {
  // A date anchor is needed for relative events, not for timeless preferences.
  // Unrelated timestamps tempt the model to invent an unnecessary "yesterday".
  if (!/(?:大前天|前天|昨天|昨[晚早夜]|今天|今[晚早夜]|明天|明[早晚夜]|后天|大后天|[上下本这](?:个)?(?:周|星期|月|年)|刚刚|最近|目前|现在)/u
    .test([fact.text, ...(fact.sources || []).map(source => source.quote)].join('\n'))) return {};
  const times = [...new Set((fact.sources || []).map(source => {
    if (source.time == null) return null;
    const value = typeof source.time === 'string' && !/^\d+$/u.test(source.time) ? Date.parse(source.time) :
      Number(source.time) < 1e12 ? Number(source.time) * 1000 : Number(source.time);
    // The conversation runs in Asia/Shanghai. Give the model the original
    // local date directly instead of asking it to convert a UTC clock.
    return Number.isFinite(value) && value > 0 ? new Date(value + 8 * 3600000).toISOString().replace(/Z$/u, '+08:00') : null;
  }).filter(Boolean))];
  return times.length ? { saidAt: times.length === 1 ? times[0] : times } : {};
}

/** Keep storage review state out of conversational wording; provenance stays explicit. */
export function factEvidence(fact) {
  const reported = fact.reviewReason === 'reported' || fact.subjectId !== 'group' && (fact.sources || [])
    .some(source => typeof source.senderId === 'string' && source.senderId !== fact.subjectId);
  const text = reported ? fact.text.replace(/（转述，未由本人确认）$/u, '') : fact.text;
  return { text, ...factSourceTime(fact), ...(fact.state === 'pending' ? {
    sourceType: fact.reviewReason === 'image' ? 'image' : reported ? 'reported' : fact.reviewReason || (fact.replaces?.length ? 'correction' : 'unreviewed'),
  } : {}) };
}
