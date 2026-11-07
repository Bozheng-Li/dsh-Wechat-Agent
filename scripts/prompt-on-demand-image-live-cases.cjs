/* Synthetic pixels and isolated ACKs only; never send a real WeChat message. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { deflateSync } = require('node:zlib');
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
function png(rgb) {
  const chunk = (kind, data) => { const name = Buffer.from(kind), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(64 * (1 + 64 * 3)); for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let c = 0; c < 3; c++) rows[y * 193 + 1 + x * 3 + c] = rgb[c];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
exports.runPersonaAudit = async ({ ctx, testing: T, outputRoot, signal, selection, onProgress }) => {
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending', actualWeChatMessages: 0, notificationsSent: 0, scenarios: [], failures: [], calls: [], tools: [], mediaReads: [] };
  const persist = () => fs.writeFileSync(path.join(outputRoot, 'on-demand-image-actual.json'), JSON.stringify(report, null, 2));
  const root = path.join(outputRoot, 'synthetic-image-workspace'), scope = { accountId: 'synthetic-image-owner', chatType: 'group', peerId: 'synthetic-image@chatroom' };
  fs.mkdirSync(root, { recursive: true }); const store = new T.StateStore(root);
  store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
  store.setPersona({ name: '看图助手', aliases: [], prompt: '简短准确地回答当前问题，必要时使用提供的图片工具；不猜测没有查看过的画面。' });
  let phase = 'receipt', sequence = 0;
  class AuditedRunner extends T.DshAgentRunner {
    async run(request) {
      const call = { phase, mode: request.mode || 'default', startedAt: new Date().toISOString(), images: request.images?.length || 0 }; report.calls.push(call); persist();
      const tools = (request.tools || []).map(tool => ({ ...tool, execute: async (args, execution) => { const result = await tool.execute(args, execution); report.tools.push({ phase, name: tool.name, args, result }); persist(); return result; } }));
      try { const result = await super.run({ ...request, tools, signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(90000)]) }); call.text = result.text; return result; }
      catch (error) { call.error = error instanceof T.ChannelError ? error.code + ': ' + error.message : error.name; throw error; }
      finally { call.finishedAt = new Date().toISOString(); persist(); }
    }
  }
  const runner = new AuditedRunner(ctx, () => ({ provider: selection.provider, model: selection.model }), () => ({ modelConfig: { maxTokens: null, temperature: 0.1, vision: true, webSearch: false }, persona: store.persona(), workspacePath: root }));
  const colors = { 'photo-a': [255, 0, 0], 'photo-b': [0, 0, 255], 'sticker-c': [0, 255, 0] }, sent = [];
  const channel = new T.WechatChannel({ store, runner, transport: { status: () => ({ online: true, account: { id: scope.accountId } }),
    media: async input => { assert.equal(input.accountId, scope.accountId); assert.equal(input.peerId, scope.peerId); assert(colors[input.resourceId]); report.mediaReads.push({ phase, resourceId: input.resourceId, preferOriginal: input.preferOriginal }); const data = png(colors[input.resourceId]); return { data: data.toString('base64'), mediaType: 'image/png', quality: 'original', bytes: data.length }; },
    send: async input => { assert.equal(input.accountId, scope.accountId); assert.equal(input.peerId, scope.peerId); assert(input.message.every(part => part.type === 'text')); sent.push(input); return { delivery: 'server-ack', serverMessageIds: ['isolated-image-ack-' + sent.length] }; } } });
  channel.imageMemory.thumbnailMaker = async () => png([255, 0, 0]);
  channel.longMemory.extract = async () => {}; // This audit measures chat/vision requests, not unrelated fact extraction.
  const receive = (text, pictures = []) => channel.receive({ id: 'image-audit-' + ++sequence, direction: 'incoming', time: Math.floor(Date.now() / 1000), chatType: 'group', peerId: scope.peerId,
    sender: { id: 'synthetic-ahe', nickname: '阿禾' }, message: [...(text ? [{ type: 'text', data: { text } }] : []), ...pictures] }, scope.accountId);
  const images = [{ type: 'image', data: { resourceId: 'photo-a' } }, { type: 'image', data: { resourceId: 'photo-b' } }, { type: 'face', data: { resourceId: 'sticker-c' } }];
  const visionCount = () => report.calls.filter(call => call.mode === 'vision').length;
  const scenario = async (id, execute) => { phase = id; const item = { id, ok: false, beforeVision: visionCount(), beforeSent: sent.length };
    try { await execute(); item.ok = true; } catch (error) { item.error = error.name === 'AssertionError' || error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id, error: item.error }); }
    item.afterVision = visionCount(); item.text = sent.length > item.beforeSent ? sent.at(-1).message[0].data.text : null; report.scenarios.push(item); persist(); onProgress({ phase: 'on-demand-image:' + id, completed: report.scenarios.length, passed: item.ok }); };
  try {
    await scenario('receipt-does-not-understand', async () => { receive('', images); await channel.whenIdle(); assert.equal(visionCount(), 0); assert.equal(sent.length, 0); assert.equal(channel.imageMemory.list(scope).storedCount, 3); });
    await scenario('unrelated-chat-does-not-understand', async () => { receive('/agent 只回一句你好，不需要看图。'); await channel.whenIdle(); assert.equal(visionCount(), 0); assert(sent.at(-1).message[0].data.text.includes('你好')); });
    await scenario('same-message-selects-second-picture', async () => { const before = visionCount(); receive('/agent 只看我这条消息附的第二张普通图片，里面主要是什么颜色？只看这一张，不用看第一张或表情包。', images); await channel.whenIdle();
      assert.equal(visionCount() - before, 1); assert(/蓝/u.test(sent.at(-1).message[0].data.text)); assert(report.tools.some(tool => tool.phase === phase && tool.name === 'wechat_read_image'));
      assert(report.mediaReads.filter(read => read.phase === phase && read.preferOriginal).every(read => read.resourceId === 'photo-b')); });
    await scenario('known-description-does-not-reread', async () => { const before = visionCount(); receive('/agent 再说一遍刚才已经确认的第二张图的颜色，只复述已确认结果，不要重新看图。'); await channel.whenIdle(); assert.equal(visionCount(), before); assert(/蓝/u.test(sent.at(-1).message[0].data.text)); });
    await scenario('later-question-reads-relevant-first-picture', async () => { const before = visionCount(); receive('/agent 我刚才那条带两张普通图片的消息，第一张图主要是什么颜色？只看第一张。'); await channel.whenIdle(); assert.equal(visionCount() - before, 1); assert(/红/u.test(sent.at(-1).message[0].data.text)); });
    await scenario('stickers-never-enter-vision', async () => { const before = visionCount(), beforeSent = sent.length; receive('/agent 这次只说收到，不需要分析表情包。', [images[2]]); await channel.whenIdle(); assert.equal(visionCount(), before); assert.equal(sent.length, beforeSent + 1); const saved = channel.imageMemory.list(scope).items.filter(item => item.type === 'face'); assert(saved.every(item => !item.description)); });
  } finally { await channel.close(); }
  report.completed = true; report.automatedChecksPassed = !report.failures.length; report.reviewStatus = report.automatedChecksPassed ? 'actual-output-assertions-passed' : 'failures-require-review'; report.modelCalls = report.calls.length; report.visionCalls = visionCount(); persist(); return report;
};
