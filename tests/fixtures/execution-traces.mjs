export async function seedExecutionTraceFixture(channel, accountId) {
  const traces = channel.traces, originalNow = traces.now, ids = {};
  let now = Date.now() - 5 * 60000;
  traces.now = () => now;
  try {
    for (const [type, title] of [['conversation', '整理今天的讨论并查找资料'], ['work', '为项目生成周报与交付文件'], ['scheduled', '晚间定时提醒'],
      ['moments', '生成并核对朋友圈草稿'], ['memory', '整理人物资料与聊天依据'], ['media', '理解新收藏表情的使用情景'], ['digest', '整理群聊今日简报'], ['maintenance', '核查未确认的发送回执']]) {
      now += 20000;
      const context = traces.task({ key: 'ui-trace-' + type, accountId, type, title, createdAt: now, peerId: 'group_alpha@chatroom', actor: '界面测试用户',
        input: { request: title, requirement: '合成记录，仅用于本地界面验证。' }, configuration: { model: { provider: 'fixture', model: 'trace-model' }, apiKey: 'TRACE_UI_SECRET' } });
      ids[type] = context.row.id;
      const prepare = traces.startStep(context, { title: '读取任务来源和上下文', input: { source: '合成对话', messages: 8 } });
      now += 120; prepare.end({ output: { available: true } });
      const model = traces.startStep(context, { title: '生成回复并选择工具', kind: 'model', input: { system: '合成系统提示', messages: [{ role: 'user', content: '需要一份明确的处理结果。' }] },
        metadata: { model: 'trace-model', provider: 'fixture', toolsCount: 4, totalTextChars: 2380, usage: { inputTokens: 650, outputTokens: 90 } } });
      now += 1680; model.end({ output: { content: '已选择读取资料工具。' } });
      const tool = traces.startStep(context, { title: 'wechat_memory', kind: 'tool', input: { query: '项目进展', apiKey: 'TRACE_UI_SECRET' }, metadata: { tool: 'wechat_memory' } });
      now += 380; tool.end({ output: type === 'maintenance' ? { ok: false, message: '微信回执仍然未知，未自动重发。' } : { ok: true, facts: ['确认过的项目进展'] } });
      if (type === 'work') for (let i = 0; i < 108; i++) { now += 10; traces.event(context, '核对工作步骤 ' + (i + 1), { result: '合成步骤 ' + i }); }
      const send = traces.startStep(context, { title: '微信发送与回执', kind: 'transport', input: { target: '合成测试会话' } });
      now += 520; send.end({ state: type === 'maintenance' ? 'unknown' : 'completed', output: type === 'maintenance' ? { delivery: 'unknown' } : { delivery: 'server-ack', serverMessageIds: ['100001'] } });
      traces.update(context, { state: type === 'maintenance' ? 'unknown' : 'completed', output: { text: '已完成合成任务，原始内容与结果均可查看。' } });
    }
    now += 10000;
    const active = traces.task({ key: 'ui-trace-running', accountId, type: 'work', title: '正在核对交付成果', createdAt: now, input: '继续核对工作文件' });
    const activeStep = traces.startStep(active, { title: '检查最终成果', kind: 'tool', input: { files: ['report.md'] } });
    ids.running = active.row.id;
    traces.startStep(traces.context(accountId, ids.conversation), { title: '安排关联工作任务', kind: 'child', metadata: { traceId: ids.work, title: '为项目生成周报与交付文件' } })?.end();
    const record = { key: 'trace-ui-historical', accountId, chatType: 'group', peerId: 'group_alpha@chatroom', senderId: 'wxid_alice',
      sender: 'Alice', question: '历史轨迹示例', reply: '已有历史结果', state: 'sent', mode: 'default', createdAt: now - 3600000, updatedAt: now - 3500000, sentAt: now - 3500000 };
    traces.enabled = false;
    try { channel.store.add(record); } finally { traces.enabled = true; }
    await traces.flush();
    return { ids, complete: () => { activeStep.end({ output: { ok: true, filesChecked: 1 } }); traces.update(active, { state: 'completed', output: '成果已检查完成' }); } };
  } finally { traces.now = originalNow; }
}
