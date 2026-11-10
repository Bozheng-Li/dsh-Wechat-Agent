import { BridgeError } from '@napcat-wechat/protocol';
import { fields, signed, ld, fv, readVi, type Field } from './wire.js';
import { requestSnsCgi } from './moments.js';
import type { Credential } from './session.js';

// GetContactLabelList (639), InitContact (851) and GetContact (182) layouts:
// https://github.com/ThePeppy/wechat-api-ipad/blob/main/Cilent/mm/mm.proto
const fail = (message: string): never => { throw new BridgeError('ERR_MOMENTS_AUDIENCE', message); };
export const audienceUserId = (id: unknown): id is string => typeof id === 'string' && /^[\w.:-]{1,256}$/.test(id);
export const audienceLabelId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,9}$/.test(id) && BigInt(id) <= 0xffffffffn;
const field = (list: Field[], tag: number, wire: number, required = false) => {
  const values = list.filter(x => x.tag === tag);
  if (values.length > 1 || values.some(x => x.wire !== wire) || required && values.length !== 1) fail('微信联系人或标签响应字段不完整，未使用不完整名单');
  return values[0]?.value;
};
const text = (value: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { return fail('微信标签或联系人文字编码无效'); } };
const contactString = (list: Field[], tag: number) => {
  const raw = field(list, tag, 2) as Buffer | undefined;
  return raw?.length ? text(field(fields(raw), 1, 2, true) as Buffer) : '';
};
const accepted = (body: Buffer) => {
  const list = fields(body), base = fields(field(list, 1, 2, true) as Buffer), ret = signed(field(base, 1, 0, true) as bigint);
  if (ret !== 0) fail(`微信拒绝读取联系人或标签（ret=${ret}），屏蔽名单未取得，未发布`);
  return list;
};
export function contactLabelsResponse(body: Buffer) {
  const list = accepted(body), rows = list.filter(x => x.tag === 3), count = field(list, 2, 0, true);
  if (count !== BigInt(rows.length) || rows.length > 1000 || rows.some(x => x.wire !== 2)) fail('微信标签数量不匹配，未使用不完整名单');
  const labels = rows.map(row => { const data = fields(row.value as Buffer), id = (field(data, 2, 0, true) as bigint).toString(), name = text(field(data, 1, 2, true) as Buffer);
    if (!audienceLabelId(id) || !name.trim() || name.length > 200) fail('微信标签编号或名称无效');
    return { id, name }; });
  if (new Set(labels.map(label => label.id)).size !== labels.length) fail('微信返回了重复标签编号');
  return labels;
}
export function contactDirectoryResponse(body: Buffer) {
  const list = accepted(body), wxSeq = field(list, 2, 0, true) as bigint, roomSeq = field(list, 3, 0, true) as bigint, more = field(list, 4, 0, true) as bigint;
  if (wxSeq > 0xffffffffn || roomSeq > 0xffffffffn || ![0n, 1n].includes(more)) fail('微信联系人分页状态无效');
  const rows = list.filter(x => x.tag === 5);
  if (rows.some(x => x.wire !== 2) || rows.length > 1000) fail('微信联系人分页列表无效');
  const ids = rows.map(x => text(x.value as Buffer));
  if (ids.some(id => !/^[\w@.:-]{1,256}$/.test(id)) || new Set(ids).size !== ids.length) fail('微信联系人分页编号无效或重复');
  return { ids, wxSeq, roomSeq, more: more === 1n };
}
export function contactDetailsResponse(body: Buffer, requested: string[]) {
  const list = accepted(body), rows = list.filter(x => x.tag === 3), ret: number[] = [];
  for (const item of list.filter(x => x.tag === 4)) {
    if (item.wire === 0) ret.push(signed(item.value as bigint)!);
    else if (item.wire === 2) { let offset = 0; const data = item.value as Buffer;
      while (offset < data.length) { const [value, next] = readVi(data, offset); ret.push(signed(value)!); offset = next; } }
    else fail('微信联系人状态字段无效');
  }
  if (field(list, 2, 0, true) !== BigInt(requested.length) || rows.length !== requested.length || ret.length !== requested.length || rows.some(x => x.wire !== 2))
    fail('微信联系人详情或逐人状态不完整，未使用不完整标签成员');
  const contacts: { id: string; name: string; nickname: string; remark: string; labelIds: string[] }[] = [], unavailableIds: string[] = [];
  rows.forEach((row, i) => {
    const data = fields(row.value as Buffer), id = contactString(data, 1), nickname = contactString(data, 2), remark = contactString(data, 10), rawLabels = text((field(data, 61, 2) ?? Buffer.alloc(0)) as Buffer);
    // InitContact retains tombstones. GetContact explicitly returns an empty
    // contact and -1 for an unavailable entry; these are never selectable.
    if (ret[i] === -1 && !id && !nickname && !remark && !rawLabels) { unavailableIds.push(requested[i]); return; }
    if (ret[i] !== 0 || id !== requested[i]) fail('微信联系人详情与请求对象不匹配，未使用不完整标签成员');
    if (nickname.length > 256 || remark.length > 256 || rawLabels.length > 12000 || rawLabels && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(rawLabels)) fail('微信联系人标签字段无效');
    const labelIds = rawLabels ? [...new Set(rawLabels.split(','))] : [];
    if (labelIds.some(id => !audienceLabelId(id))) fail('微信联系人标签编号无效');
    contacts.push({ id, name: remark || nickname || id, nickname, remark, labelIds });
  });
  return { contacts, unavailableIds };
}
export class MomentsAudienceReader {
  constructor(readonly request = requestSnsCgi) {}
  async read(account: Credential, signal: AbortSignal, check: () => void) {
    const request = async (cmd: number, route: string, makeBody: (base: Buffer) => Buffer) => {
      check(); signal.throwIfAborted(); const body = await this.request(account, cmd, route, makeBody, signal); check(); signal.throwIfAborted(); return body;
    };
    const readLabels = async () => contactLabelsResponse(await request(639, 'getcontactlabellist', base => ld(1, base)));
    const labels = await readLabels(), ids = new Set<string>(); let wxSeq = 0n, roomSeq = 0n, complete = false;
    for (let page = 0; page < 500; page++) {
      const result = contactDirectoryResponse(await request(851, 'initcontact', () => Buffer.concat([ld(1, account.wxid), fv(2, wxSeq), fv(3, roomSeq)])));
      result.ids.filter(audienceUserId).filter(id => id !== account.wxid).forEach(id => ids.add(id));
      if (ids.size > 50000) fail('微信联系人数量超出读取范围，未使用不完整名单');
      if (!result.more) { complete = true; break; }
      if (result.wxSeq === wxSeq && result.roomSeq === roomSeq) fail('微信联系人分页未推进，未使用不完整名单');
      wxSeq = result.wxSeq; roomSeq = result.roomSeq;
    }
    if (!complete) fail('微信联系人分页未完成，未使用不完整名单');
    const contacts: ReturnType<typeof contactDetailsResponse>['contacts'] = [], unavailableIds: string[] = [], usernames = [...ids];
    // PC 3.9 GetContact caps each response at 20 entries, even for a larger
    // UserCount. Keep strict count validation and request complete batches.
    for (let offset = 0; offset < usernames.length; offset += 20) {
      const batch = usernames.slice(offset, offset + 20);
      const result = contactDetailsResponse(await request(182, 'getcontact', base => Buffer.concat([ld(1, base), fv(2, batch.length), ...batch.map(id => ld(3, ld(1, id))), fv(4, 0), fv(6, 0)])), batch);
      contacts.push(...result.contacts); unavailableIds.push(...result.unavailableIds);
    }
    if (JSON.stringify(await readLabels()) !== JSON.stringify(labels)) fail('读取期间微信标签发生变化，请重新读取后选择');
    const labelIds = new Set(labels.map(x => x.id));
    if (contacts.some(contact => contact.labelIds.some(id => !labelIds.has(id)))) fail('微信联系人引用了未返回的标签，请重新读取');
    return { accountId: account.wxid, source: 'wechat-contacts-live', fetchedAt: new Date().toISOString(), membershipComplete: true, unavailableCount: unavailableIds.length,
      contacts, labels: labels.map(label => { const userIds = contacts.filter(contact => contact.labelIds.includes(label.id)).map(contact => contact.id); return { ...label, userIds, memberCount: userIds.length }; }) };
  }
}
