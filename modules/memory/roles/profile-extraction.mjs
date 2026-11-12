import { ChannelError } from '../../../shared/contracts.mjs';
import { ROLE_CARD_FIELDS } from '../../../shared/role-card.mjs';
import { explicitRelatives } from './references.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new ChannelError('ROLE_CARD_EXTRACTION_INVALID', '人物资料整理缺少有效原话依据，原记录已保留，将自动重试'); };

function checkQuote(source, quote, field) {
  const at = source.indexOf(quote), before = source.slice(0, at).split(/[，,。；;！？!?\n]/u),
    after = source.slice(at + quote.length).split(/[，,。；;！？!?\n]/u);
  const prefix = before.at(-1) || '', suffix = /[。；;！？!?\n]\s*$/u.test(quote) ? '' : after[0] || '';
  if (/(?:不|没|仅|只|以前|现在|暂时|这次)/u.test(prefix + suffix) ||
      /(?:时候|时|的话|情况下|这次出差|暂时|仅这次|只这次)\s*$/u.test(before.at(-2) || '')) fail();
  if (/只是(?:教材|例句|举例|角色|台词)|不是我的|不是我本人|假装我是|提示词测试|练习表演/u.test(source)) fail();
  if (!['label', 'addressAs', 'preferences', 'dislikes', 'style'].includes(field)) return;
  const clause = prefix + quote + suffix, relatives = explicitRelatives(clause);
  const withoutRelatives = relatives.reduce((text, relative) => text.replaceAll(relative.phrase, '该亲友'), clause);
  const firstPerson = /(?:^|[，,。；;！？!?\s])我(?:自己|本人|[不只爱喜对现之从想要已用住喝吃]|的(?:名字|习惯|称呼|偏好))/u.test(withoutRelatives) || /叫我/u.test(clause);
  if ((relatives.length || /(?:^|[，,。；;！？!?\s])[他她]/u.test(clause)) && !firstPerson) fail();
}

export function validateRoleCardProposal(text, { scope, sources, now }) {
  let value;
  try { value = JSON.parse(String(text).trim().replace(/^\x60{3}(?:json)?\s*/iu, '').replace(/\s*\x60{3}$/u, '')); } catch { fail(); }
  if (!object(value) || Object.keys(value).some(key => !['updates', 'conflicts'].includes(key)) ||
      !Array.isArray(value.updates) || value.updates.length > Object.keys(ROLE_CARD_FIELDS).length ||
      value.conflicts != null && !Array.isArray(value.conflicts) || (value.conflicts?.length || 0) > 8) fail();
  const fields = new Set();
  const evidence = (values, field) => {
    if (!Array.isArray(values) || !values.length || values.length > 8) fail();
    return values.map(item => {
      if (!object(item) || Object.keys(item).some(key => !['sourceId', 'quote'].includes(key)) ||
          typeof item.quote !== 'string' || item.quote.trim().length < 2 || item.quote.length > 2000) fail();
      const source = sources.find(row => row.id === item.sourceId);
      if (!source || source.accountId !== scope.accountId || source.senderId !== scope.personId ||
          source.time > now || !source.text.includes(item.quote)) fail();
      checkQuote(source.text, item.quote, field);
      return { sourceId: source.id, messageKey: source.messageKey, messageId: source.messageId,
        chatType: source.chatType, peerId: source.peerId, senderId: source.senderId, senderName: source.senderName,
        ...(source.kind === 'moments' ? { kind: 'moments', postId: source.postId,
          ...(source.commentId ? { commentId: source.commentId } : {}) } : {}),
        time: source.time, quote: item.quote };
    });
  };
  const updates = value.updates.map(row => {
    if (!object(row) || Object.keys(row).some(key => !['field', 'value', 'evidence'].includes(key)) ||
        !Object.hasOwn(ROLE_CARD_FIELDS, row.field) || fields.has(row.field) || typeof row.value !== 'string' ||
        row.value.length > ROLE_CARD_FIELDS[row.field] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(row.value)) fail();
    fields.add(row.field);
    return { field: row.field, value: row.value.trim(), evidence: evidence(row.evidence, row.field) };
  });
  const conflicts = (value.conflicts || []).map(row => {
    if (!object(row) || Object.keys(row).some(key => !['field', 'note', 'evidence'].includes(key)) ||
        !Object.hasOwn(ROLE_CARD_FIELDS, row.field) || fields.has(row.field) || typeof row.note !== 'string' ||
        !row.note.trim() || row.note.length > 300) fail();
    fields.add(row.field);
    return { field: row.field, note: row.note.trim(), evidence: evidence(row.evidence, row.field), at: now };
  });
  return { updates, conflicts };
}
