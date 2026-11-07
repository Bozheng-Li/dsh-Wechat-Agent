const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
exports.runPersonaAudit = async ({ ctx, testing: T, outputRoot, signal, selection, onProgress }) => {
  const report = { completed: false, automatedChecksPassed: false, reviewStatus: 'actual-output-review-pending', actualWeChatMessages: 0, notificationsSent: 0, scenarios: [], failures: [], modelCalls: 0 };
  const persist = () => fs.writeFileSync(path.join(outputRoot, 'automatic-compaction-actual.json'), JSON.stringify(report, null, 2));
  for (const windowChars of [1000, 100000]) {
    const item = { id: 'automatic-window-' + windowChars, windowChars, calls: [], automatedChecksPassed: false };
    const root = path.join(outputRoot, item.id), scope = { accountId: 'synthetic-compaction-owner', chatType: 'group', peerId: 'synthetic-compaction@chatroom' };
    fs.mkdirSync(root, { recursive: true }); const store = new T.StateStore(root);
    store.configure(scope.accountId, { enabled: true, groups: [scope.peerId], privatePeers: [], prompt: '' });
    const memory = new T.ConversationMemory(store); memory.setWindowChars(windowChars);
    const actual = new T.DshAgentRunner(ctx, () => ({ provider: selection.provider, model: selection.model }), () => ({ modelConfig: { maxTokens: null, temperature: 0.2, webSearch: false }, workspacePath: root }));
    const runner = { summarize: async (...args) => {
      const call = { targetChars: args[1], attempt: args[3]?.attempt || 0 }; item.calls.push(call); report.modelCalls++;
      const summary = await actual.summarize(args[0], args[1], AbortSignal.any([signal, args[2], AbortSignal.timeout(90000)]), args[3]); call.text = summary; call.chars = summary.length; persist(); return summary;
    } };
    const channel = new T.WechatChannel({ store, memory, runner, transport: { status: () => ({ online: true, account: { id: scope.accountId } }), send: async () => { throw new Error('Synthetic memory audit must not send'); } } });
    try {
      memory.append(scope, { key: 'synthetic-pressure', text: '阿禾喜欢柚子，已确认周五在青藤书店见面。' + '随后有很多重复的普通寒暄，对长期事实没有补充。'.repeat(windowChars === 1000 ? 100 : 5200), direction: 'incoming', senderId: 'synthetic-ahe', senderName: '阿禾', time: Date.now() });
      item.beforeChars = memory.view(scope).chars; assert(item.beforeChars >= windowChars);
      await channel.whenIdle(); const doc = memory.view(scope); item.afterChars = doc.chars; item.summary = doc.summary; item.error = doc.error;
      assert(doc.compressions > 0 && doc.chars < windowChars, 'Automatic pressure did not produce a valid compressed window');
      assert(doc.summary.includes('柚子') && doc.summary.includes('青藤书店'), 'Key facts were lost during compaction'); assert.equal(doc.error, null);
      item.automatedChecksPassed = true;
    } catch (error) { item.error = error.name === 'AssertionError' || error instanceof T.ChannelError ? error.message : error.code || error.name; report.failures.push({ id: item.id, error: item.error }); }
    finally { await channel.close(); }
    report.scenarios.push(item); persist(); onProgress({ phase: 'automatic-compaction-audit', completed: report.scenarios.length, total: 2, passed: item.automatedChecksPassed });
  }
  report.completed = true; report.automatedChecksPassed = !report.failures.length; persist(); return report;
};
