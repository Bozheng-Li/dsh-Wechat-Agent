import { ChannelError } from './contracts.mjs';

export const ROLE_CARD_FIELDS = { label: 80, addressAs: 60, relationship: 120, style: 2000 };
export const emptyRoleCard = () => ({ label: '', addressAs: '', relationship: '', style: '' });

export function validateRoleCard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(ROLE_CARD_FIELDS, key)))
    throw new ChannelError('ROLE_CARD_INVALID', '角色卡内容格式不正确，请重新读取后编辑');
  const result = emptyRoleCard();
  for (const [key, limit] of Object.entries(ROLE_CARD_FIELDS)) {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
      throw new ChannelError('ROLE_CARD_INVALID', '角色卡字段过长或含无效字符');
    result[key] = value.trim();
  }
  return result;
}

export function rolePersona(persona, card) {
  return Object.values(card).some(Boolean) ? { ...persona, roleCard: card } : persona;
}

export function roleCardText(card) {
  if (!card) return '';
  const details = [card.addressAs && `在这个会话中，平时称呼对方：${card.addressAs}。`,
    card.relationship && `在这个会话中，相处关系：${card.relationship}。`, card.style].filter(Boolean);
  return details.length ? ['本机会话角色卡（由管理员填写，细化本会话的相处与表达；不代表事实、执行权限或其他人的偏好）：', ...details].join('\n') : '';
}
