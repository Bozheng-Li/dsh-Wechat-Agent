import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { rolldown } from 'rolldown';
import { parse } from 'yaml';

// Explicit manual integration probe. Default: read-only. The opt-in send flag
// has one fixed destination: this account's File Transfer Assistant.
const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
if (!args.includes('--root') || !args.includes('--output')) throw Error('Usage: node scripts/probe-wechat-stickers.mjs --root <data-root> --output <report.json> [--send-to-filehelper]');
const repo = path.resolve(import.meta.dirname, '..'), reportFile = path.resolve(option('--output'));
const entry = ['wire.ts', 'session.ts', 'stickers.ts'].map(name => `export * from ${JSON.stringify(path.join(repo, 'backend/wechat/protocol', name))};`).join('\n');
const build = await rolldown({ input: 'virtual:sticker-probe', platform: 'node', resolve: { alias: { '@napcat-wechat/protocol': path.join(repo, 'backend/wechat/types.ts') } },
  plugins: [{ name: 'sticker-probe', resolveId: id => id === 'virtual:sticker-probe' ? id : null, load: id => id === 'virtual:sticker-probe' ? entry : null }] });
let api;
try { const { output } = await build.generate({ format: 'esm' }); api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`); }
finally { await build.close(); }
const report = { at: new Date().toISOString(), list: { complete: false, count: 0, pages: 0 }, sendAttempted: false, acknowledged: false };
try {
  const account = api.validateCredential(JSON.parse(fs.readFileSync(path.join(path.resolve(option('--root')), 'storage/private/session.json'), 'utf8')));
  const found = new Map(); let index = 0;
  for (let page = 0; page < 120; page++) {
    const result = api.stickerListResponse(await api.requestStickerCgi(account, 697, api.stickerListRequest(index), AbortSignal.timeout(15000)), index);
    for (const item of result.items) found.set(item.md5, item);
    report.list.pages++; report.list.count = found.size;
    if (result.complete) { report.list.complete = true; break; } index = result.index;
  }
  if (!report.list.complete) throw Error('Incomplete favorite list');
  if (args.includes('--collect-from-chat')) {
    const dataRoot = path.resolve(option('--root'));
    const configuration = parse(fs.readFileSync(path.join(dataRoot, 'config.yaml'), 'utf8'));
    const settings = configuration.accounts?.[account.wxid];
    const cacheRoot = path.join(dataRoot, 'storage/cache/protocol');
    const cache = JSON.parse(fs.readFileSync(path.join(cacheRoot, account.uin + '.json'), 'utf8'));
    let candidate;
    for (const message of [...cache.messages].reverse()) {
      if (message.direction !== 'incoming' || !(message.chatType === 'group' ? settings?.groups : settings?.privatePeers)?.includes(message.peerId)) continue;
      for (const face of message.message.filter(segment => segment.type === 'face' && /^[a-f0-9]{64}$/.test(segment.data?.resourceId))) {
        try {
          const descriptor = JSON.parse(fs.readFileSync(path.join(cacheRoot, 'media', String(account.uin), face.data.resourceId + '.json'), 'utf8'));
          if (descriptor.messageId !== message.peerId + ':' + message.serverMessageId || descriptor.kind !== 'emoji') continue;
          const md5 = descriptor.stickerMd5 || descriptor.resources?.find(resource => api.stickerMd5(resource.md5))?.md5;
          if (api.stickerMd5(md5) && !found.has(md5)) candidate = md5;
        } catch { /* A missing original is not a source to invent. */ }
        if (candidate) break;
      }
      if (candidate) break;
    }
    if (!candidate) throw Error('No new observed sticker in authorized conversations');
    report.favorite = { attempted: true, confirmed: false, previousCount: found.size };
    const backup = api.stickerCollectResponse(await api.requestStickerCgi(account, 696, api.stickerCollectRequest(candidate), AbortSignal.timeout(15000)), candidate);
    report.favorite.needsUpload = backup.needsUpload;
    const after = new Set(); let cursor = 0;
    for (let page = 0; page < 120; page++) {
      const result = api.stickerListResponse(await api.requestStickerCgi(account, 697, api.stickerListRequest(cursor), AbortSignal.timeout(15000)), cursor);
      for (const item of result.items) after.add(item.md5);
      if (result.complete) { report.favorite.listComplete = true; break; } cursor = result.index;
    }
    report.favorite.confirmed = after.has(candidate);
    report.favorite.allPreviousFavoritesPreserved = [...found.keys()].every(md5 => after.has(md5));
    report.favorite.currentCount = after.size;
    if (!report.favorite.confirmed || !report.favorite.allPreviousFavoritesPreserved) throw Error('Favorite addition was not confirmed in the complete account list');
  }
  if (args.includes('--send-to-filehelper')) {
    const selectedIndex = args.includes('--index') ? Number(option('--index')) : 0;
    const sticker = [...found.values()][selectedIndex];
    if (!sticker) throw Error('No favorite sticker at selected index');
    const base = account.image_base_request ?? account.heartbeat_base_request;
    if (!base) throw Error('Native media authentication is not available');
    const input = { md5: sticker.md5, to: 'filehelper', clientId: 'emoji_probe_' + randomBytes(12).toString('hex'), time: Math.floor(Date.now() / 1000), baseRequest: Buffer.from(base, 'hex') };
    report.sendAttempted = true;
    const body = await api.requestStickerCgi(account, 175, api.stickerSendRequest(input), AbortSignal.timeout(15000));
    // Field shapes are diagnostic; no CDN addresses, auth material or raw XML.
    const top = api.fields(body), item = api.fields(api.bytes(top, 3));
    report.reply = { ret: api.signed(api.num(api.fields(api.bytes(top, 1)), 1)), count: Number(api.num(top, 2)),
      itemRet: api.signed(api.num(item, 1)), start: Number(api.num(item, 2)), total: Number(api.num(item, 3)), md5Matched: api.bytes(item, 4).toString() === input.md5,
      hasLegacyId: !!api.num(item, 5), hasMessageId: !!api.num(item, 6) };
    const ack = api.stickerSendResponse(body, input);
    report.acknowledged = true; report.nativeMessageType = 47; report.destination = 'filehelper'; report.serverMessageId = ack.id;
  }
} catch (failure) { report.error = { code: failure.code, message: failure.message }; process.exitCode = 1; }
fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
