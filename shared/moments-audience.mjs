import { ChannelError } from './contracts.mjs';

export const audienceUserId = id => typeof id === 'string' && /^[\w.:-]{1,256}$/.test(id);
export const audienceLabelId = id => typeof id === 'string' && /^[1-9]\d{0,9}$/.test(id) && BigInt(id) <= 0xffffffffn;
export function validateAudienceSelection(query) {
  for (const [key, valid, max] of [['blockedUserIds', audienceUserId, 50000], ['blockedLabelIds', audienceLabelId, 1000]]) {
    const value = query[key];
    if (value !== undefined && (query.action !== 'publish' || !Array.isArray(value) || value.length > max || value.some(id => !valid(id)) || new Set(value).size !== value.length))
      throw new ChannelError('MOMENTS_AUDIENCE_INVALID', '屏蔽选择须使用读取到的标签或联系人编号，且仅用于发布朋友圈；未提交');
  }
  return { blockedUserIds: [...(query.blockedUserIds ?? [])], blockedLabelIds: [...(query.blockedLabelIds ?? [])] };
}
export function resolveMomentsAudience(snapshot, query) {
  const selection = validateAudienceSelection(query);
  if (snapshot?.membershipComplete !== true || snapshot.source !== 'wechat-contacts-live' || !Array.isArray(snapshot.contacts) || !Array.isArray(snapshot.labels))
    throw new ChannelError('MOMENTS_AUDIENCE_INCOMPLETE', '微信标签成员名单未完整读取，未发布；请重新读取');
  const contacts = new Set(snapshot.contacts.map(row => row.id)), labels = new Map(snapshot.labels.map(row => [row.id, row]));
  if (selection.blockedUserIds.some(id => !contacts.has(id)) || selection.blockedLabelIds.some(id => !labels.has(id)))
    throw new ChannelError('MOMENTS_AUDIENCE_CHANGED', '选择的联系人或标签已不存在／不可用，未发布；请刷新并重新选择');
  const blocked = new Set(selection.blockedUserIds);
  for (const id of selection.blockedLabelIds) {
    const label = labels.get(id);
    if (!Array.isArray(label.userIds) || label.memberCount !== label.userIds.length || label.userIds.some(userId => !contacts.has(userId)))
      throw new ChannelError('MOMENTS_AUDIENCE_INCOMPLETE', '所选标签的成员名单不完整，未发布');
    label.userIds.forEach(userId => blocked.add(userId));
  }
  if (blocked.size > 50000) throw new ChannelError('MOMENTS_AUDIENCE_INVALID', '屏蔽人数超出支持范围，未发布');
  return { selection, blockedUserIds: [...blocked].sort() };
}
