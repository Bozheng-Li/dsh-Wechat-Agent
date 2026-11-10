import { createHash } from 'node:crypto';
import { BridgeError } from '@napcat-wechat/protocol';
import type { Credential } from './session.js';
import { fields, fv, ld, num, bytes, signed, readVi } from './wire.js';
import { parseSnsObject, requestSnsCgi, momentsRequest, momentsResponse, normalizeSnsText } from './moments.js';
import { validateAudienceSelection, audienceUserId } from '../../../shared/moments-audience.mjs';

export const SNS_IMAGE_BYTES = 10 * 1024 * 1024, SNS_CHUNK_BYTES = 50_000;
const wrap = (data: Buffer) => Buffer.concat([fv(1, data.length), ld(2, data)]);
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
const fail = (message: string): never => { throw new BridgeError('ERR_MOMENTS_WRITE_PROTOCOL', message, { delivery: 'unknown' }); };
const uint64 = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
export interface SnsWrite { action: 'like' | 'comment' | 'publish' | 'delete'; postId?: string; text?: string; images?: { data: string; width: number; height: number }[]; replyToCommentId?: string; blockedUserIds?: string[]; blockedLabelIds?: string[] }
export function validateSnsWrite(raw: unknown): SnsWrite {
  const query = raw as SnsWrite;
  const invalid = () => { throw new BridgeError('ERR_INVALID_MOMENTS_WRITE', '请选择点赞、评论、回复、发布或删除，填写真实动态／评论编号或完整发布内容', { delivery: 'not-sent' }); };
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['action', 'postId', 'text', 'images', 'replyToCommentId', 'blockedUserIds', 'blockedLabelIds'].includes(key))) invalid();
  try { validateAudienceSelection(query); } catch (error) { throw new BridgeError('ERR_MOMENTS_AUDIENCE', (error as Error).message, { delivery: 'not-sent' }); }
  if (!['like', 'comment', 'publish', 'delete'].includes(query.action) || query.action !== 'publish' && !uint64(query.postId) ||
      query.action === 'publish' && query.postId !== undefined || ['like', 'delete'].includes(query.action) && query.text !== undefined ||
      query.action === 'comment' && (typeof query.text !== 'string' || !query.text.trim() || query.text.length > 2000) ||
      query.action === 'publish' && (typeof query.text !== 'string' || query.text.length > 10000 || !query.text.trim() && !query.images?.length) ||
      query.action !== 'publish' && query.images !== undefined || query.replyToCommentId !== undefined && (query.action !== 'comment' || !uint64(query.replyToCommentId))) invalid();
  if (query.images !== undefined && (!Array.isArray(query.images) || query.images.length > 9 || query.images.some(image => !image || typeof image !== 'object' ||
      Object.keys(image).some(key => !['data', 'width', 'height'].includes(key)) || typeof image.data !== 'string' || !image.data || image.data.length > Math.ceil(SNS_IMAGE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data) ||
      !Number.isInteger(image.width) || image.width < 1 || image.width > 8192 || !Number.isInteger(image.height) || image.height < 1 || image.height > 8192 || image.width * image.height > 40000000))) invalid();
  return query;
}
function accepted(body: Buffer) {
  const list = fields(body), base = list.filter(field => field.tag === 1);
  if (base.length !== 1 || base[0].wire !== 2) fail('朋友圈操作回执缺少唯一状态，结果不明，未自动重试');
  const status = fields(base[0].value as Buffer).filter(field => field.tag === 1);
  if (status.length !== 1 || status[0].wire !== 0) fail('朋友圈操作回执状态无效，结果不明，未自动重试');
  const ret = signed(status[0].value as bigint);
  if (ret !== 0) throw new BridgeError('ERR_MOMENTS_WRITE_REJECTED', `微信拒绝朋友圈操作（ret=${ret}），未报告成功`, { ret, delivery: 'rejected' });
  return list;
}
export function snsDeleteRequest(base: Buffer, postId: string) {
  return Buffer.concat([ld(1, base), fv(2, 1), ld(3, Buffer.concat([fv(1, BigInt(postId)), fv(2, 1), ld(3, wrap(fv(1, 0)))]))]);
}
export function snsDeleteResponse(body: Buffer, postId: string) {
  const list = accepted(body), counts = list.filter(field => field.tag === 2), values: bigint[] = [];
  if (counts.length > 1 || counts.length === 1 && (counts[0].wire !== 0 || ![0n, 1n].includes(counts[0].value as bigint))) fail('朋友圈删除回执的操作数量不匹配，结果不明');
  for (const field of list.filter(field => field.tag === 3)) {
    if (field.wire === 0) values.push(field.value as bigint);
    else if (field.wire === 2) {
      const packed = field.value as Buffer; let offset = 0;
      while (offset < packed.length && values.length < 2) { const [value, next] = readVi(packed, offset); values.push(value); offset = next; }
      if (offset !== packed.length) fail('朋友圈删除回执的操作状态无效，结果不明');
    } else fail('朋友圈删除回执状态类型无效，结果不明');
  }
  // PC 3.9 may acknowledge only BaseResponse and omit per-operation fields.
  // That format still needs a readback; a generic ret=0 is not a deletion proof.
  if (!values.length && (!counts.length || counts[0].value === 0n)) return { postId, deleted: false, needsReadback: true };
  if (values.length !== 1 || counts.length !== 1 || counts[0].value !== 1n) fail('朋友圈删除回执缺少唯一操作状态，结果不明');
  if (signed(values[0]) !== 0) throw new BridgeError('ERR_MOMENTS_WRITE_REJECTED', `微信拒绝删除朋友圈（ret=${signed(values[0])}）`, { delivery: 'rejected' });
  return { postId, deleted: true };
}
interface ReplyTarget { id: string; userId: string; legacyId?: bigint }
export function snsInteractionRequest(base: Buffer, accountId: string, authorId: string, query: SnsWrite, clientId: string, time: number, reply?: ReplyTarget) {
  const action = Buffer.concat([ld(1, accountId), ld(2, reply?.userId ?? authorId), fv(5, query.action === 'like' ? 1 : 2), fv(6, 6), fv(7, time), ld(8, query.text ?? ''), fv(9, reply?.legacyId ?? 0),
    ...(reply ? [fv(12, BigInt(reply.id))] : [])]);
  const group = Buffer.concat([fv(1, BigInt(query.postId!)), fv(2, 0), ld(3, action), ld(5, clientId)]);
  return Buffer.concat([ld(1, base), ld(2, group), ld(3, clientId)]);
}
export function snsInteractionResponse(body: Buffer, accountId: string, query: SnsWrite, previousCommentIds: Set<string>, reply?: ReplyTarget) {
  const list = accepted(body), objects = list.filter(field => field.tag === 2);
  if (objects.length !== 1 || objects[0].wire !== 2) fail('朋友圈互动回执缺少目标动态，结果不明');
  const object = parseSnsObject(objects[0].value as Buffer);
  if (object.id !== query.postId) fail('朋友圈互动回执的动态编号不匹配，结果不明');
  if (query.action === 'like') {
    if (!object.likedByCurrentAccount) fail('微信回执未确认当前账号已点赞，结果不明');
    return { postId: object.id, liked: true };
  }
  // Inspect the full visible list rather than the 50-entry model preview.
  const comments = fields(objects[0].value as Buffer).filter(field => field.tag === 12 && field.wire === 2).map(field => fields(field.value as Buffer));
  const comment = comments.find(row => bytes(row, 1).toString('utf8') === accountId && normalizeSnsText(bytes(row, 5).toString('utf8')) === query.text &&
    (num(row, 13) ?? 0n) === 0n &&
    (!reply || (num(row, 11) || num(row, 8))?.toString() === reply.id && bytes(row, 9).toString('utf8') === reply.userId) &&
    !!(num(row, 12) || num(row, 7)) && !previousCommentIds.has((num(row, 12) || num(row, 7))!.toString()));
  if (!comment) fail('微信回执未确认本次新增评论，结果不明，未自动重试');
  return { postId: object.id, commentId: (num(comment, 12) || num(comment, 7))!.toString(), text: query.text,
    ...(reply ? { replyToCommentId: reply.id, replyToUserId: reply.userId } : {}) };
}
interface SnsImage { url: string; thumb: string; width: number; height: number; size: number; id: string }
export function snsUploadRequest(base: Buffer, clientId: string, md5: string, total: number, position: number, data: Buffer) {
  if (!data.length || data.length > SNS_CHUNK_BYTES || position < 0 || position + data.length > total) throw new BridgeError('ERR_INVALID_MOMENTS_WRITE', '朋友圈图片上传分片无效', { delivery: 'not-sent' });
  return Buffer.concat([ld(1, base), fv(2, 2), fv(3, position), fv(4, total), ld(5, wrap(data)), ld(6, clientId), ld(15, md5)]);
}
export function snsUploadResponse(body: Buffer, clientId: string, total: number, end: number) {
  const list = accepted(body);
  for (const [tag, wire] of [[2, 0], [3, 0], [4, 2], [5, 2], [6, 0], [9, 0]]) {
    const values = list.filter(field => field.tag === tag);
    if (values.length !== 1 || values[0].wire !== wire) fail('朋友圈图片回执字段重复或类型不正确，未发布');
  }
  if (bytes(list, 4).toString('utf8') !== clientId || num(list, 3) !== BigInt(total) || num(list, 2) !== BigInt(end) || num(list, 9) !== 2n)
    fail('朋友圈图片回执的标识、长度、位置或类型不一致，未发布');
  if (end !== total) return undefined;
  const urls = list.filter(field => field.tag === 7);
  if (urls.some(field => field.wire !== 2) || num(list, 6) !== BigInt(urls.length) || !urls.length) fail('朋友圈图片回执缺少有效缩略图，未发布');
  const validateUrl = (data: Buffer) => {
    const url = bytes(fields(data), 1).toString('utf8');
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port || !/(^|\.)(qpic\.cn|weixin\.qq\.com)$/.test(parsed.hostname) || url.length > 8192) throw Error(); }
    catch { fail('朋友圈图片回执包含无效媒体地址，未发布'); }
    return url;
  };
  return { url: validateUrl(bytes(list, 5)), thumb: validateUrl(urls[0].value as Buffer) };
}
export function snsPostRequest(base: Buffer, accountId: string, query: SnsWrite, clientId: string, time: number, images: SnsImage[]) {
  const description = '<TimelineObject><id>0</id><username>' + xml(accountId) + '</username><createTime>' + time + '</createTime><contentDesc>' + xml(query.text!) +
    '</contentDesc><contentDescShowType>0</contentDescShowType><contentDescScene>3</contentDescScene><contentattr>0</contentattr><private>0</private><sightFolded>0</sightFolded>' +
    '<appInfo><id/><version>0</version><appName/><installUrl/><fromUrl/><isForceUpdate>0</isForceUpdate></appInfo><sourceUserName/><sourceNickName/><statisticsData/><statExtStr/>' +
    '<ContentObject><contentStyle>' + (images.length ? 1 : 2) + '</contentStyle><title/><description/><contentUrl/><mediaList>' +
    images.map(image => '<media><id>' + xml(image.id) + '</id><type>2</type><title/><description/><url type="1">' + xml(image.url) + '</url><thumb type="1">' + xml(image.thumb) + '</thumb><size width="' + image.width + '" height="' + image.height + '" totalSize="' + image.size + '"/></media>').join('') +
    '</mediaList></ContentObject><actionInfo><appMsg><messageAction/></appMsg></actionInfo><location poiClassifyId="" poiName="" poiAddress="" poiClassifyType="0" city=""/>' +
    '<publicUserName/><streamvideo><streamvideourl/><streamvideothumburl/><streamvideoweburl/></streamvideo></TimelineObject>';
  const protocolClientId = `sns_post_${accountId}_${time}_${BigInt('0x' + createHash('sha256').update(clientId).digest('hex').slice(0, 8)).toString()}`;
  if (query.blockedLabelIds?.length) throw new BridgeError('ERR_MOMENTS_AUDIENCE', '屏蔽标签尚未展开为真实成员，未发布', { delivery: 'not-sent' });
  const blocked = query.blockedUserIds ?? [];
  return Buffer.concat([ld(1, base), ld(2, wrap(Buffer.from(description))), fv(3, 0), fv(5, 0), fv(6, 0), ld(7, protocolClientId), fv(13, blocked.length), ...blocked.map(id => ld(14, ld(1, id)))]);
}
export function snsPostResponse(body: Buffer, accountId: string, query: SnsWrite) {
  const list = accepted(body), objects = list.filter(field => field.tag === 2);
  if (objects.length !== 1 || objects[0].wire !== 2) fail('朋友圈发布回执缺少动态编号，结果不明，未自动重试');
  const object = parseSnsObject(objects[0].value as Buffer);
  if (object.author.userId !== accountId || !object.contentAvailable || object.text !== query.text || object.imageCount !== (query.images?.length ?? 0) || object.deleted)
    fail('朋友圈发布回执的账号、正文或图片与提交内容不一致，结果不明');
  const data = fields(objects[0].value as Buffer), count = data.filter(field => field.tag === 23), rows = data.filter(field => field.tag === 24);
  const expected = query.blockedUserIds ?? [];
  if (count.length > 1 || count.some(field => field.wire !== 0) || rows.some(field => field.wire !== 2) ||
      (count[0]?.value ?? 0n) !== BigInt(rows.length) || expected.length && count.length !== 1)
    fail('朋友圈回执未确认完整屏蔽名单，发布结果不明，请在微信核对；未自动重发');
  const blockedUserIds = rows.map(row => {
    const wrapped = fields(row.value as Buffer), sizes = wrapped.filter(field => field.tag === 1), values = wrapped.filter(field => field.tag === 2);
    if (sizes.length !== 1 || sizes[0].wire !== 0 || values.length !== 1 || values[0].wire !== 2 || sizes[0].value !== BigInt((values[0].value as Buffer).length))
      fail('朋友圈回执的屏蔽联系人字段无效，发布结果不明');
    const id = (values[0].value as Buffer).toString('utf8');
    if (!audienceUserId(id)) fail('朋友圈回执的屏蔽联系人编号无效，发布结果不明');
    return id;
  });
  if (new Set(blockedUserIds).size !== blockedUserIds.length || JSON.stringify([...blockedUserIds].sort()) !== JSON.stringify([...expected].sort()))
    fail('朋友圈回执的屏蔽名单与提交名单不一致，发布结果不明，请在微信核对；未自动重发');
  return { postId: object.id, createdAt: object.createdAt, text: object.text, imageCount: object.imageCount, blockedUserIds, audienceConfirmed: true };
}

export class MomentsWriter {
  constructor(readonly request = requestSnsCgi, readonly now = Date.now) {}
  async write(account: Credential, raw: unknown, clientId: string, signal: AbortSignal, assertCurrent: () => void) {
    const query = validateSnsWrite(raw), time = Math.floor(this.now() / 1000);
    if (query.blockedLabelIds?.length) throw new BridgeError('ERR_MOMENTS_AUDIENCE', '屏蔽标签尚未展开为真实成员，未上传或发布', { delivery: 'not-sent' });
    assertCurrent(); signal.throwIfAborted();
    if (query.action !== 'publish') {
      const target = { action: 'detail' as const, postId: query.postId };
      const detailBody = await this.request(account, 210, 'mmsnsobjectdetail', base => momentsRequest(base, target), signal);
      const page = momentsResponse(detailBody, target); assertCurrent(); signal.throwIfAborted();
      const post = page.items[0];
      if (!post?.contentAvailable || post.deleted) throw new BridgeError('ERR_MOMENTS_TARGET_UNAVAILABLE', '目标动态不可见或已删除，未执行互动', { delivery: 'not-sent' });
      if (query.action === 'delete') {
        if (post.author.userId !== account.wxid) throw new BridgeError('ERR_MOMENTS_TARGET_UNAVAILABLE', '只能删除当前扫码登录账号自己发布的动态，未执行删除', { delivery: 'not-sent' });
        const response = await this.request(account, 218, 'mmsnsobjectop', base => snsDeleteRequest(base, post.id), signal);
        const receipt = snsDeleteResponse(response, post.id);
        if (receipt.needsReadback) {
          assertCurrent(); signal.throwIfAborted();
          let confirmed = false;
          try {
            const body = await this.request(account, 210, 'mmsnsobjectdetail', base => momentsRequest(base, target), signal);
            confirmed = momentsResponse(body, target).items[0]?.deleted === true;
          } catch (error) {
            // Live PC deletion was verified to make this exact own-post detail
            // return ret=-2. Network failures and other rejections stay unknown.
            if ((error as any)?.code === 'ERR_MOMENTS_REJECTED' && (error as any).details?.ret === -2) confirmed = true;
            else throw error;
          }
          assertCurrent(); signal.throwIfAborted();
          if (!confirmed) fail('微信尚未确认目标动态已删除，结果不明，未重复删除');
        }
        return { accountId: account.wxid, action: query.action, postId: post.id, deleted: true, delivery: 'server-ack', ...(receipt.needsReadback ? { readbackConfirmed: true } : {}) };
      }
      if (query.action === 'like' && post.likedByCurrentAccount) return { accountId: account.wxid, action: query.action, postId: post.id, liked: true, alreadyLiked: true, delivery: 'verified-existing' };
      const previousIds = new Set(fields(bytes(fields(detailBody), 2)).filter(field => field.tag === 12 && field.wire === 2).map(field => {
        const row = fields(field.value as Buffer); return (num(row, 12) || num(row, 7))?.toString();
      }).filter(Boolean) as string[]);
      let reply: ReplyTarget | undefined;
      if (query.replyToCommentId) {
        const rows = fields(bytes(fields(detailBody), 2)).filter(field => field.tag === 12 && field.wire === 2).map(field => fields(field.value as Buffer));
        const row = rows.find(row => (num(row, 12) || num(row, 7))?.toString() === query.replyToCommentId && (num(row, 13) ?? 0n) === 0n);
        const userId = row && bytes(row, 1).toString('utf8');
        if (!row || !userId || !/^[\w.:-]{1,256}$/.test(userId)) throw new BridgeError('ERR_MOMENTS_TARGET_UNAVAILABLE', '原评论不可见、已删除或作者无效，未提交回复', { delivery: 'not-sent' });
        reply = { id: query.replyToCommentId, userId, legacyId: num(row, 7) };
      }
      const response = await this.request(account, 213, 'mmsnscomment', base => snsInteractionRequest(base, account.wxid, post.author.userId, query, clientId, time, reply), signal);
      const receipt = snsInteractionResponse(response, account.wxid, query, previousIds, reply);
      return { accountId: account.wxid, action: query.action, ...receipt, delivery: 'server-ack' };
    }
    const images: SnsImage[] = [];
    for (const [index, image] of (query.images ?? []).entries()) {
      const data = Buffer.from(image.data, 'base64');
      if (!data.length || data.length > SNS_IMAGE_BYTES || data.toString('base64') !== image.data) throw new BridgeError('ERR_INVALID_MOMENTS_WRITE', '朋友圈图片数据无效或超过 10 MiB，未发布', { delivery: 'not-sent' });
      const uploadId = clientId + '_image_' + index, md5 = createHash('md5').update(data).digest('hex'); let urls;
      for (let position = 0; position < data.length; position += SNS_CHUNK_BYTES) {
        assertCurrent(); signal.throwIfAborted(); const chunk = data.subarray(position, position + SNS_CHUNK_BYTES);
        urls = snsUploadResponse(await this.request(account, 207, 'mmsnsupload', base => snsUploadRequest(base, uploadId, md5, data.length, position, chunk), signal), uploadId, data.length, position + chunk.length);
      }
      images.push({ ...urls!, width: image.width, height: image.height, size: data.length, id: String(index + 1) });
    }
    assertCurrent(); signal.throwIfAborted();
    const response = await this.request(account, 209, 'mmsnspost', base => snsPostRequest(base, account.wxid, query, clientId, time, images), signal);
    return { accountId: account.wxid, action: query.action, ...snsPostResponse(response, account.wxid, query), delivery: 'server-ack' };
  }
}
