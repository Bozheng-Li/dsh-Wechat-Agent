import { ExecutionTraces } from './store.mjs';
import { currentTrace, withTrace, traceStep, observeResult } from './context.mjs';
import { recordSpec, recordState, recordOutput, recordType, workSpec, workState, historicalTraces } from './records.mjs';
import { TRACE_ACTIVE, traceState } from '../../shared/execution-traces.mjs';
import { identity } from '../../backend/storage/keys.mjs';

const configuration = channel => ({ model: channel.store.modelChoice?.(), modelConfig: channel.store.modelConfig?.(),
  persona: channel.store.persona?.(), work: channel.store.config?.data?.work, timeSettings: channel.store.config?.data?.timeSettings });
const scopeOf = args => args.find(value => value && typeof value === 'object' && typeof value.accountId === 'string');
const inputOf = args => args.filter(value => typeof value !== 'function' && !(value instanceof AbortSignal))
  .map(value => value?.store || value?.channel || value?.ctx ? '[运行组件]' : value);
const updateTitle = fields => fields.state ? ({ queued: '进入执行队列', generating: '生成回复', sending: '提交微信发送', sent: '收到微信确认',
  failed: '执行失败', cancelled: '执行取消', skipped: '跳过回复', unknown: '发送结果待核实', partial: '部分发送完成' }[fields.state] || '更新执行状态')
  : fields.memoryContext ? '读取会话上下文' : fields.memoryReflection ? '核对记忆依据' : fields.workRoute ? '判断任务类型'
    : fields.naturalAction ? '判断是否参与聊天' : fields.sessionId ? '关联模型会话' : fields.replyDraft ? '准备回复内容' : '更新执行记录';

/** Observe existing entry points; never dispatch, retry or authorize a business action here. */
export function attachExecutionTraces(channel) {
  const traces = new ExecutionTraces(channel.store, { now: channel.now }); channel.traces = traces;
  const history = historicalTraces(channel); traces.history = history.list; traces.historyDetail = history.get;
  const restorers = [];
  function replace(object, name, around) {
    if (typeof object?.[name] !== 'function') return;
    const original = object[name], wrapped = function (...args) {
      let invoked = false;
      const invoke = () => { invoked = true; return original.apply(this, args); };
      try { return around.call(this, invoke, args); }
      catch (failure) {
        if (invoked) throw failure;
        traces.safe(() => { throw failure; }); return invoke();
      }
    };
    object[name] = wrapped;
    restorers.push(() => { if (object[name] === wrapped) object[name] = original; });
  }
  const recordContext = (record, initial = false) => record?.accountId && record?.key ? traces.task({ ...recordSpec(record),
    coverage: initial ? 'recorded' : 'partial', configuration: configuration(channel) }) : null;
  function recorded(record, fields = {}, initial = false) {
    if (!record?.accountId || !record?.key) return;
    const context = recordContext(record, initial); if (!context) return;
    if (!initial && Object.keys(fields).some(key => !['requestMetrics', 'updatedAt'].includes(key))) traces.event(context, updateTitle(fields), fields);
    if (record.sessionId) context.row.sessionId = record.sessionId;
    traces.update(context, { state: recordState(record), ...(!TRACE_ACTIVE.has(recordState(record)) ? { output: recordOutput(record), note: record.reason } : {}) });
  }
  replace(channel.store, 'remember', (original, args) => {
    const result = original(); if (result && args[2]) traces.safe(() => recorded(args[2], {}, true)); return result;
  });
  replace(channel.store, 'add', (original, args) => { const result = original(); traces.safe(() => recorded(args[0], {}, true)); return result; });
  replace(channel.store, 'update', (original, args) => { const result = original(); traces.safe(() => recorded(args[0], args[1])); return result; });
  replace(channel, 'submitScheduled', (original, [task]) => {
    const context = traces.task({ key: 'record:' + task.recordKey, accountId: task.accountId,
      type: recordType({ mode: 'scheduled', taskId: task.id, workJobId: task.workJobId, recoveryOf: task.recovery }),
      title: task.content || '定时执行', source: 'schedule', peerId: task.peerId, chatType: task.chatType,
      actor: task.senderName || task.senderId, state: 'queued', input: { task }, configuration: configuration(channel) });
    const failed = failure => traces.update(context, { state: traceState(undefined, failure), output: failure, note: failure?.message });
    return withTrace(context, () => {
      try { return observeResult(traceStep('定时任务入队与执行', original), value => traces.safe(() => recorded(value)), failed); }
      catch (failure) { failed(failure); throw failure; }
    });
  });
  replace(channel, 'process', (original, [item]) => {
    const context = recordContext(item.record);
    return withTrace(context, () => {
      traces.update(context, { state: 'running' });
      try { return observeResult(traceStep('处理会话任务', original, { input: { mode: item.mode, text: item.text,
        configuration: item.config, prompt: item.prompt, scheduled: item.scheduled } }), () => traces.safe(() => recorded(item.record)),
        failure => traces.update(context, { state: traceState(undefined, failure), output: failure, note: failure?.message })); }
      catch (failure) { traces.update(context, { state: traceState(undefined, failure), output: failure, note: failure?.message }); throw failure; }
    });
  });
  const jobContext = (job, initial = false) => traces.task({ ...workSpec(job), coverage: initial ? 'recorded' : 'partial', configuration: configuration(channel) });
  const recordJob = (job, patch, initial = false) => {
    const context = jobContext(job, initial); if (!context) return;
    if (patch && Object.keys(patch).some(key => !['requestMetrics', 'updatedAt'].includes(key))) traces.event(context,
      patch.delivery ? '工作成果投递状态' : patch.operations ? '保存工作步骤结果' : patch.sessionId ? '关联工作会话' : '工作执行状态', patch);
    if (job.sessionId) context.row.sessionId = job.sessionId;
    traces.update(context, { state: workState(job), ...(!TRACE_ACTIVE.has(workState(job)) ? { output: { result: job.result, error: job.error, delivery: job.delivery }, note: job.error?.message } : {}) });
  };
  for (const name of ['add', 'update']) replace(channel.work.store, name, (original, args) => {
    const job = original(); traces.safe(() => recordJob(job, name === 'update' ? args[1] : undefined, name === 'add')); return job;
  });
  replace(channel.work, 'execute', (original, [id]) => {
    const context = traces.safe(() => jobContext(channel.work.store.get(id)));
    return withTrace(context, () => observeResult(traceStep('执行工作并整理成果', original),
      () => traces.safe(() => recordJob(channel.work.store.get(id))), failure => traces.update(context, { state: 'failed', output: failure, note: failure.message })));
  });
  function method(object, name, title, type, { root = true, account, input, kind = 'stage', output, before, independent = false } = {}) {
    replace(object, name, (original, args) => {
      const active = currentTrace();
      if (active && active.store !== traces) return original();
      const scope = scopeOf(args), accountId = account?.(args) || scope?.accountId ||
        (typeof args[0] === 'string' && root ? args[0] : undefined) || active?.row.accountId || channel.transport.status().account?.id;
      if (!active && (!root || !accountId)) return original();
      const matching = active?.row.accountId === accountId;
      if (active && !matching && !root) return withTrace(null, original);
      const details = input ? input(args) : inputOf(args);
      const snapshot = before ? before(args) : undefined, label = typeof title === 'function' ? title(args) : title;
      const result = value => output ? traces.safe(() => output(value, args, snapshot)) ?? value : value;
      const run = () => traceStep(label, original, { kind, input: details, output: result });
      if (matching && !independent) return run();
      return withTrace(matching ? active : null, () => traces.run({ type, title: label, accountId, peerId: scope?.peerId || scope?.personId,
        chatType: scope?.chatType, input: details, configuration: configuration(channel) }, run, { output: result }));
    });
  }
  method(channel, 'processMemory', '整理会话与长期记忆', 'memory', { independent: true, output: (value, [scope]) => {
    const key = identity([scope.accountId, scope.chatType, scope.peerId]), retry = channel.memoryRetries.get(key);
    return retry ? { state: retry.kind === 'yield' ? 'cancelled' : 'failed', retry, message: channel.memory.errors.get(key) || '本次整理尚未完成，已由原有调度器安排后续处理' } : value;
  } });
  method(channel.personMemory, 'update', '更新人物角色卡', 'memory', { independent: true, input: args => [args[0], args[2]] });
  method(channel.runner, 'run', '准备模型任务', 'conversation', { root: false,
    input: args => ({ mode: args[0].mode || 'default', text: args[0].text, history: args[0].history, memory: args[0].memory, images: args[0].images }) });
  method(channel.work.runner, 'run', '原生工作会话', 'work', { root: false, input: args => ({ request: args[0].request, cwd: args[0].cwd, sessionId: args[0].sessionId, limits: args[0].limits }) });
  for (const [object, names] of [[channel.memory, ['enrich', 'compact']], [channel.longMemory, ['prompt', 'roleContext', 'extract']],
    [channel.imageMemory, ['content', 'describe']], [channel.library, ['prepareSendSegment', 'thumbnail', 'getContent']]])
    for (const name of names) method(object, name, ({ prompt: '读取长期记忆', roleContext: '读取人物上下文', enrich: '补充图片信息', compact: '压缩会话记忆', extract: '提取长期记忆',
      content: '读取图片记忆', describe: '保存图片理解结果', prepareSendSegment: '准备表情发送内容', thumbnail: '生成图片预览', getContent: '读取素材原图' })[name], 'memory', { root: false });
  for (const [name, title] of [['sync', '同步微信收藏表情'], ['collectRecent', '收集最近聊天表情'], ['favorite', '收藏表情到微信'], ['sendTest', '试发表情到文件传输助手']])
    method(channel.stickers, name, title, 'media');
  replace(channel.stickers, 'enqueue', (original, args) => {
    const [accountId, key, action] = args, parent = currentTrace();
    const perform = () => {
      const selected = parent?.row.accountId === accountId ? parent : null;
      return withTrace(selected, () => traces.run({ accountId, type: 'media', title: key.includes(':favorite:') ? '保存收藏表情原图' : '保存聊天表情原图', input: { resource: key } }, action));
    };
    // Keep the service's deduplication and queue promise unchanged.
    args[2] = perform;
    return original();
  });
  method(channel.library, 'describe', '整理表情含义与适用情景', 'media', { input: args => ({ accountId: args[0], assetIds: args[1] }) });
  for (const [name, title] of [['import', '导入图片素材'], ['finishUpload', '保存上传素材']]) method(channel.library, name, title, 'media');
  for (const [name, title] of [['diagnose', '运行诊断'], ['prepare', '准备发送恢复'], ['sendDraft', '发送恢复内容'], ['submitRecoveryDraft', '提交恢复内容'], ['generateDigest', '生成群聊简报']])
    method(channel.workbench, name, title, name === 'generateDigest' ? 'digest' : 'maintenance');
  for (const [name, title] of [['read', '读取朋友圈'], ['readImages', '读取朋友圈图片'], ['write', '提交朋友圈操作'], ['likeRecent', '处理朋友圈点赞请求']])
    method(channel.moments, name, title, 'moments', { root: !['read', 'readImages'].includes(name), account: args => args[1]?.accountId });
  for (const [name, title] of [['writeOwner', '提交朋友圈操作与核对回执'], ['reconcileOwnerPublication', '核对朋友圈发布结果']])
    method(channel.moments, name, title, 'moments', { account: args => args[1] });
  const automation = channel.momentsAutomation;
  method(automation, 'run', '朋友圈自动回复', 'moments', { independent: true,
    output: (_, [accountId]) => ({ ...automation.rule(accountId).lastRun, error: automation.rule(accountId).lastError }) });
  const publishing = automation?.publishing;
  const runFingerprint = run => JSON.stringify([run.updatedAt, run.state, run.stage, run.error, run.revision]);
  method(publishing, 'operation', '朋友圈生成与发布', 'moments', {
    before: ([accountId]) => new Map(Object.values(publishing.data.runs).filter(run => run.accountId === accountId).map(run => [run.id, runFingerprint(run)])),
    output: (value, [accountId], previous) => {
      const runs = Object.values(publishing.data.runs).filter(run => run.accountId === accountId && previous.get(run.id) !== runFingerprint(run));
      return runs.length ? { state: runs.length === 1 ? traceState(runs[0]) : runs.some(run => traceState(run) !== 'completed') ? 'partial' : 'completed',
        runs: runs.map(({ query, ...run }) => run) } : value;
    },
  });
  method(automation?.likes, 'run', '朋友圈定时点赞', 'moments', { independent: true, output: (_, args) => args[2] });
  method(automation?.interactions, 'launch', args => args[1] === 'generating' ? '生成朋友圈互动评论' : '朋友圈分轮互动', 'moments',
    { independent: true, input: args => ({ operation: args[1], task: args[0] }), output: (value, args) => value ?? args[0] });
  for (const [object, names, title] of [
    [publishing, ['generate', 'submit', 'preview', 'publishDraft', 'reconcile'], '朋友圈发布'],
    [automation?.materials, ['organize', 'describe', 'generateImage', 'downloadImage'], '朋友圈素材处理'],
    [automation?.interactions, ['preview', 'generateRows', 'execute', 'submit'], '朋友圈分轮互动'],
    [channel.work.imageGeneration, ['generate'], '生成工作图片'],
  ]) for (const name of names) method(object, name, title, object === channel.work.imageGeneration ? 'media' : 'moments',
    { input: args => inputOf(args).filter(value => !value?.sources?.some?.(source => source?.raw)) });
  for (const name of ['send', 'media', 'files', 'readStickers', 'readStickerContent', 'favoriteSticker', 'recentStickers',
    'readMoments', 'readMomentsPublication', 'readMomentsImages', 'readMomentsAudience', 'writeMoments', 'call'])
    method(channel.transport, name, name === 'send' ? '微信发送与回执' : name === 'call' ? '微信组件请求' : '微信接口 · ' + name, 'maintenance', { root: false, kind: 'transport' });
  const close = traces.close.bind(traces);
  traces.close = async () => { await close(); for (const restore of restorers.reverse()) restore(); };
  return traces;
}
