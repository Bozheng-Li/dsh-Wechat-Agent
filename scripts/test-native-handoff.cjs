/* Current work-mode contract against the installed DSH SDK. The model, image
 * API and WeChat receipts are synthetic; filesystem and PowerShell are real. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto'), { createRequire } = require('node:module'), { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..'), installation = process.argv[2] || process.env.DSH_INSTALLATION;
if (!installation) throw Error('Pass the DSH installation directory');
if (!process.versions.electron) {
  const result = spawnSync(path.join(installation, 'DeepSeek Harness.exe'), ['--expose-internals', __filename, installation], {
    windowsHide: true, encoding: 'utf8', timeout: 180000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
const host = createRequire(path.join(installation, 'resources/app.asar/dsh/package.json'));
const { Context } = host('@deepseek-ai/cordis'), { LlmAdapter } = host('@deepseek-ai/dsh-llm');
const { StateStore, WorkStore, DshAgentRunner, WechatChannel, ImageGenerationService, workTools, ChannelError, consolidateWorkProjects, migrateWorkProjectSession } = require(path.join(repo, 'lib/testing.js'));
const systemTemp = path.join(require('node:os').homedir(), 'AppData/Local/Temp');
const root = fs.mkdtempSync(path.join(systemTemp, 'wechat-native-handoff-'));
process.env.TEMP = systemTemp; process.env.TMP = systemTemp;
process.env.DSH_HOME = path.join(root, 'home'); process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
const { stickerPng } = require(path.join(repo, 'tests/fixtures/stickers.mjs'));
const imageBytes = stickerPng();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gate = Promise.withResolvers(), waiting = new Set(), nativeRequests = [], polishRequests = [], routingRequests = [], progressRequests = [], nativeCreations = [], nativeFileCalls = [], shellCalls = [];
let callId = 0, administrator = true, confinedCalls = 0;
const parentRequest = '并行生成两个独立文件';
const childRequests = ['生成 alpha.txt，正文为 ALPHA_NATIVE，运行核对后回传', '生成 beta.txt，正文为 BETA_NATIVE，运行核对后回传'];
const legacyBusyRequest = '验证忙会话保持运行', legacyBusyEntered = Promise.withResolvers(), legacyBusyRelease = Promise.withResolvers();
const wordPath = path.join(root, 'previous', 'yesterday-summary.docx');
const retiredFileRequest = '读取刚才的 Word 并生成预算核对结果';
const requests = new Set(['你好', parentRequest, ...childRequests, retiredFileRequest, '/dsh tasks', '找到已有的新闻摘要 Word 并发给我',
  '生成一张小狗的图片给我', '使用 second 的 image-pro 生成橙猫海报', '验证空图片响应', '验证已有图片链接',
  '回顾刚才的工作对话', '继续这项工作，只检查现有文件', '创建 followup.txt，内容为 CONTEXT_FILE_MARKER', '删除这个文件',
  '测试润色数字保护', '测试润色 API 故障', '解释工具调用', '读取当前微信朋友圈', '点赞当前微信朋友圈', '评论当前微信朋友圈', '发布文字朋友圈',
  '拉取当前微信朋友圈评论区', '回复当前微信朋友圈评论', '删除当前微信朋友圈', '屏蔽同事发布朋友圈', '设置自动发布计划', '预览朋友圈草稿', '设置定时评论回复']);
const executionNames = ['wechat_web_search', 'wechat_generated_image_memory', 'wechat_memory', 'wechat_role_card', 'wechat_moments_interact', 'wechat_work_exec', 'wechat_work_generate_image', 'wechat_work_list', 'wechat_work_output', 'wechat_work_read',
  'wechat_work_ssh_connect', 'wechat_work_ssh_exec', 'wechat_work_status', 'wechat_work_vscode_connect', 'wechat_work_write', 'wechat_moments_read',
  'wechat_moments_comments', 'wechat_moments_audience', 'wechat_moments_like', 'wechat_moments_comment', 'wechat_moments_reply', 'wechat_moments_publish', 'wechat_moments_delete',
  'wechat_moments_plan', 'wechat_moments_draft', 'wechat_moments_reply_schedule', 'wechat_moments_material_search', 'wechat_moments_material_download'];
const managementNames = ['wechat_work_cancel', 'wechat_work_continue', 'wechat_work_history', 'wechat_work_parallel', 'wechat_work_start', 'wechat_work_task', 'wechat_work_tasks'];
const toolResults = options => options.messages.slice(options.messages.findLastIndex(message => message.role === 'user') + 1)
  .filter(message => message.role === 'tool').flatMap(message => message.content)
  .filter(block => block.type === 'text').map(block => { try { return JSON.parse(block.text); } catch { return null; } }).filter(Boolean);
function* textReply(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
}
function* callTool(name, args) {
  const id = 'native-handoff-' + ++callId, argumentsText = JSON.stringify(args);
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
class Fixture extends LlmAdapter {
  constructor(surface) { super(); this.surface = surface; }
  async listModels(provider) { return [{ provider, id: this.surface === 'native' ? 'native-fixture' : 'polish-fixture', name: 'Fixture' }]; }
  async resolveModel(provider, id) { return { provider, id, name: 'Fixture', inputModalities: ['text'] }; }
  async *stream(options) {
    if (this.surface === 'native' && options.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === legacyBusyRequest))) {
      legacyBusyEntered.resolve(); await legacyBusyRelease.promise; options.signal?.throwIfAborted(); yield* textReply('忙会话已按原指令完成。'); return;
    }
    try { yield* this.fixtureStream(options); }
    catch (error) { if (error.message !== 'synthetic chat API offline') console.error(this.surface + ' model validation:', error); throw error; }
  }
  async *fixtureStream(options) {
    const userTexts = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text);
    const system = options.messages.filter(message => message.role === 'system').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
    const names = (options.tools ?? []).map(tool => tool.name).sort();
    if (system.includes('你是后台人物记忆 Agent')) {
      assert.deepEqual(names, []); yield* textReply('{"updates":[],"conflicts":[]}'); return;
    }
    if (this.surface === 'polish') {
      if (system.includes('检查一份即将公开的朋友圈草稿')) {
        assert.deepEqual(names, []); const data = JSON.parse(userTexts.at(-1).split('本次消息：\n').at(-1));
        assert.equal(data.phase, 'proposal'); assert.equal(data.imagePlanned, false);
        assert.equal(data.theme, '原生测试笑话'); assert(data.text.includes('测试草稿'));
        yield* textReply('{"ok":true,"reason":""}'); return;
      }
      if (system.includes('为当前扫码登录账号撰写一条朋友圈')) {
        assert.deepEqual(names, []); const data = JSON.parse(userTexts.at(-1));
        assert.deepEqual(data.themes, ['原生测试笑话']); assert(!system.includes('NATIVE_DSH_CONTEXT'));
        yield* textReply(JSON.stringify({ theme: data.themes[0], text: '原生生成的测试草稿，冰箱里大家很冷静。', imagePrompt: '' })); return;
      }
      let routeInput;
      try { routeInput = JSON.parse(userTexts.at(-1)); } catch {}
      if (typeof routeInput?.message === 'string' && Array.isArray(routeInput.tasks) && Array.isArray(routeInput.history)) {
        assert.deepEqual(names, []); assert(!system.includes('NATIVE_DSH_CONTEXT')); assert(!system.includes('CHAT_SENTINEL'));
        const data = routeInput; routingRequests.push(data);
        assert(!userTexts.some(text => /CHAT_SENTINEL|角色背景|当前会话记忆/.test(text)));
        // Deliberately classify delete as new: session continuity must not depend on this judgment.
        const followup = data.message === '继续这项工作，只检查现有文件';
        yield* textReply(JSON.stringify({ action: data.message === '你好' ? 'chat' : followup ? 'continue' : 'new',
          taskId: followup ? data.currentTaskId : null,
          review: { intent: data.message === '你好' ? 'chat' : followup ? 'continue' : 'execute',
            evidence: data.message === '你好' ? '' : data.message, target: followup ? 'unique' : 'none' } })); return;
      }
      if (!system.includes('只改善语言和排版') && !system.includes('你负责查看一个仍在执行的工作任务的进度')) {
        yield* textReply('聊天回应'); return;
      }
      assert.deepEqual(names, []); assert(!system.includes('NATIVE_DSH_CONTEXT')); assert(!system.includes('CHAT_SENTINEL'));
      assert(system.includes('PERSONA_WORK_STYLE'), 'public work report lost the current persona');
      if (system.includes('你负责查看一个仍在执行的工作任务的进度')) {
        const evidence = JSON.parse(userTexts.at(-1)); progressRequests.push(evidence);
        assert.equal(evidence.state, 'running'); assert(evidence.observations.some(value => value.tools?.includes('wechat_work_exec')));
        yield* textReply('文件已写入，正在执行内容核对。'); return;
      }
      assert(system.includes('只改善语言和排版'));
      const data = JSON.parse(userTexts.at(-1)); polishRequests.push(data);
      if (data.request === '测试润色 API 故障') throw Error('synthetic chat API offline');
      if (data.request === '测试润色数字保护') { yield* textReply(data.result.replace('42', '99')); return; }
      yield* textReply('整理后：' + data.result); return;
    }
    assert(system.includes('NATIVE_DSH_CONTEXT'), 'DSH native context was replaced');
    assert(system.includes('PERSONA_WORK_STYLE'), 'native work conversation lost the current persona');
    assert(!/CHAT_SENTINEL|工作对话 Agent|独立工作 Agent|后端工作状态|independent-task-sessions/.test(system));
    assert(!system.includes('OLD_TASK_') && !system.includes('OLD_DIALOGUE_'));
    const request = userTexts.findLast(text => requests.has(text));
    const expected = [...executionNames.filter(name => administrator || !/ssh|vscode|status|moments/.test(name)), ...managementNames, 'native_fixture_file',
      ...(administrator && request === '点赞当前微信朋友圈' ? ['wechat_moments_like_recent'] : [])].sort();
    assert.deepEqual(names, expected); assert(!names.includes('run_code'));
    assert(options.tools.every(tool => typeof tool.description === 'string' && tool.parameters?.type === 'object' && tool.execute === undefined));
    assert.equal(typeof request, 'string', 'original task message was not submitted: ' + JSON.stringify(userTexts));
    assert(!userTexts.some(text => /recentDialogue|"currentTime"|OLD_TASK_|OLD_DIALOGUE_/.test(text)));
    nativeRequests.push({ request, names });
    const results = toolResults(options);
    if (request === retiredFileRequest) {
      assert(!names.includes('wechat_file')); assert.equal(results.length, 0);
      yield* textReply('微信附件读取功能已停用。'); return;
    }
    if (request === parentRequest) {
      if (!results.length) { yield* callTool('wechat_work_parallel', { requests: childRequests }); return; }
      assert.equal(results.at(-1).ok, true); assert.equal(results.at(-1).tasks.length, 2);
      assert.equal(new Set(results.at(-1).tasks.map(task => task.id)).size, 2);
      yield* textReply('两项独立工作已安排。'); return;
    }
    if (childRequests.includes(request)) {
      const name = request.includes('alpha.txt') ? 'alpha' : 'beta', content = name.toUpperCase() + '_NATIVE';
      const operations = [['native_fixture_file', { path: name + '.txt', text: content }], ['wechat_work_exec', { command: 'Get-Content -LiteralPath ./' + name + '.txt\nStart-Sleep -Milliseconds 600' }]];
      assert(results.every(result => result.ok), JSON.stringify(results));
      if (results.length < operations.length) { yield* callTool(...operations[results.length]); return; }
      assert(results.some(result => result.exitCode === 0 && result.stdout.includes(content)));
      yield* textReply(name + '.txt 已生成，实际核对为 ' + content + '。'); return;
    }
    if (request === '找到已有的新闻摘要 Word 并发给我') {
      if (!results.length) { yield* callTool('wechat_work_output', { paths: [wordPath] }); return; }
      assert.equal(results.at(-1).ok, true); yield* textReply('yesterday-summary.docx 已找到并登记。'); return;
    }
    if (request === '创建 followup.txt，内容为 CONTEXT_FILE_MARKER') {
      if (!results.length) { yield* callTool('native_fixture_file', { path: 'followup.txt', text: 'CONTEXT_FILE_MARKER' }); return; }
      assert.equal(results.at(-1).ok, true); yield* textReply('followup.txt 已生成。'); return;
    }
    if (request === '删除这个文件') {
      assert(userTexts.includes('创建 followup.txt，内容为 CONTEXT_FILE_MARKER'), 'native followup lost its original file context');
      if (!results.length) { yield* callTool('wechat_work_exec', { command: 'Remove-Item -LiteralPath ./followup.txt\nTest-Path -LiteralPath ./followup.txt' }); return; }
      assert.equal(results.at(-1).ok, true); assert(results.at(-1).stdout.includes('False')); yield* textReply('followup.txt 已删除。'); return;
    }
    if (request === '/dsh tasks') {
      if (!results.length) { yield* callTool('wechat_work_status', { action: 'tasks' }); return; }
      assert(results.at(-1).text.includes('NATIVE_HOST_FACT')); yield* textReply(results.at(-1).text); return;
    }
    if (request === '读取当前微信朋友圈') {
      if (!results.length) { yield* callTool('wechat_moments_read', { action: 'timeline', limit: 2 }); return; }
      assert.equal(results.at(-1).ok, true); assert.equal(results.at(-1).items[0].text, 'NATIVE_MOMENTS_FACT');
      yield* textReply('朋友圈原文：NATIVE_MOMENTS_FACT'); return;
    }
    if (request === '拉取当前微信朋友圈评论区') {
      if (!results.length) { yield* callTool('wechat_moments_comments', { postId: '9007199254740997', limit: 50 }); return; }
      assert.equal(results.at(-1).ok, true); assert.equal(results.at(-1).action, 'comments');
      yield* textReply('评论区已读取'); return;
    }
    if (['设置自动发布计划', '预览朋友圈草稿', '设置定时评论回复'].includes(request)) {
      const name = request === '设置自动发布计划' ? 'wechat_moments_plan' : request === '预览朋友圈草稿' ? 'wechat_moments_draft' : 'wechat_moments_reply_schedule';
      if (!results.length) { yield* callTool(name, { action: request === '设置自动发布计划' ? 'save' : request === '预览朋友圈草稿' ? 'preview' : 'configure',
        settings: name === 'wechat_moments_reply_schedule' ? { enabled: false, intervalMinutes: 15 } : { themes: ['原生测试笑话'], enabled: false, reviewRequired: true } }); return; }
      assert.equal(results.at(-1).ok, true, JSON.stringify(results.at(-1)));
      if (name === 'wechat_moments_draft') assert.equal(results.at(-1).state, 'draft');
      yield* textReply('朋友圈计划或草稿已保存，尚未发布。'); return;
    }
    if (request === '屏蔽同事发布朋友圈') {
      if (!results.length) { yield* callTool('wechat_moments_audience', { search: 'Alice' }); return; }
      if (results.length === 1) {
        assert.equal(results[0].labels[0].id, '1'); assert.equal(results[0].contacts[0].id, 'wxid_alice');
        yield* callTool('wechat_moments_publish', { text: 'NATIVE_PRIVACY_FACT', blockedLabelIds: ['1'], blockedUserIds: ['wxid_alice'] }); return;
      }
      assert.equal(results.at(-1).ok, true); assert.equal(results.at(-1).audienceConfirmed, true);
      yield* textReply('朋友圈已确认发布并屏蔽所选对象'); return;
    }
    if (['点赞当前微信朋友圈', '评论当前微信朋友圈', '发布文字朋友圈', '回复当前微信朋友圈评论', '删除当前微信朋友圈'].includes(request)) {
      const tool = request.startsWith('点赞') ? 'wechat_moments_like' : request.startsWith('评论') ? 'wechat_moments_comment' :
        request.startsWith('回复') ? 'wechat_moments_reply' : request.startsWith('删除') ? 'wechat_moments_delete' : 'wechat_moments_publish';
      if (!results.length) { yield* callTool(tool, tool === 'wechat_moments_publish' ? { text: 'NATIVE_POST_FACT' } :
        { postId: '9007199254740997', ...(tool === 'wechat_moments_like' ? { subject: 'account' } : {}), ...(['wechat_moments_comment', 'wechat_moments_reply'].includes(tool) ? { text: 'NATIVE_COMMENT_FACT' } : {}),
          ...(tool === 'wechat_moments_reply' ? { commentId: '3' } : {}) }); return; }
      assert.equal(results.at(-1).ok, true, request + ': ' + JSON.stringify(results.at(-1))); assert.equal(results.at(-1).delivery, 'server-ack');
      if (tool === 'wechat_moments_reply') assert.equal(results.at(-1).replyToCommentId, '3');
      if (tool === 'wechat_moments_delete') assert.equal(results.at(-1).deleted, true);
      yield* textReply('朋友圈操作已确认'); return;
    }
    if (['生成一张小狗的图片给我', '使用 second 的 image-pro 生成橙猫海报', '验证空图片响应', '验证已有图片链接'].includes(request)) {
      const selected = request === '生成一张小狗的图片给我' ? { prompt: '一只可爱的小狗', path: 'dog.png' }
        : request === '使用 second 的 image-pro 生成橙猫海报' ? { prompt: '橙猫海报', path: 'poster.png', providerId: 'second', model: 'image-pro', size: '2048x2048' }
        : request === '验证空图片响应' ? { prompt: 'EMPTY_IMAGE_RESULT', path: 'empty.png' } : { prompt: 'EXISTING_IMAGE_URL', path: 'url.png' };
      if (!results.length) { yield* callTool('wechat_work_generate_image', selected); return; }
      if (request === '验证空图片响应') {
        assert.equal(results[0].code, 'IMAGE_GENERATION_EMPTY'); assert.equal(results[0].providerId, '0809'); assert.equal(results[0].model, 'gpt-image-2');
        assert.equal(results[0].automaticRetry, false); assert.equal(results[0].automaticFallback, false);
        if (results.length === 1) { yield* callTool('wechat_work_generate_image', { ...selected, path: 'another-empty.png' }); return; }
        assert.equal(results[1].code, 'WORK_IMAGE_ALREADY_ATTEMPTED'); yield* textReply(results[0].message); return;
      }
      assert.equal(results.at(-1).ok, true); yield* textReply(selected.path + ' 已生成。'); return;
    }
    if (request === '回顾刚才的工作对话') {
      if (!results.length) { yield* callTool('wechat_work_history', { limit: 8 }); return; }
      assert(results.at(-1).entries.some(entry => entry.user.includes('OLD_DIALOGUE_')));
      yield* textReply('已按需查询你的工作对话。'); return;
    }
    if (request === '继续这项工作，只检查现有文件') {
      if (!results.length) { yield* callTool('wechat_work_read', { path: 'alpha.txt' }); return; }
      assert.equal(results.at(-1).text, 'ALPHA_NATIVE'); yield* textReply('alpha.txt 仍为 ALPHA_NATIVE。'); return;
    }
    yield* textReply(request.startsWith('测试润色') ? '原生 DSH 返回 42。' : '原生 DSH 的直接回答。');
  }
}
const until = async predicate => {
  const deadline = Date.now() + 30000;
  while (!predicate()) { assert(Date.now() < deadline, 'native work state timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};

(async () => {
  const ctx = new Context(), forks = [], registrations = [], policyHandles = []; let channel, unregisterPreset, retained;
  ctx.baseUrl = require('node:url').pathToFileURL(path.join(installation, 'resources/app.asar/dsh/cordis.yml')).href;
  const mount = async (name, config = {}) => { const module = host('@deepseek-ai/' + name), fork = ctx.plugin(module.default || module, config); forks.push(fork); await fork.await(); };
  try {
    for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-fs-local', 'dsh-subprocess-local']) await mount(name);
    await mount('dsh-tools', { mode: 'native' }); await mount('dsh-working-directory', { defaultDirectory: root });
    await mount('dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: root }); await mount('dsh-sandbox-local');
    const confine = ctx.sandbox.confine.bind(ctx.sandbox); ctx.sandbox.confine = (...args) => { confinedCalls++; return confine(...args); };
    await mount('cordis-plugin-loader', { baseUrl: ctx.baseUrl }); await mount('dsh-agent-preset-registry', { default: 'native-test-coding' });
    unregisterPreset = await ctx.agentPresets.register({ id: 'native-test-coding', plugins: [{ name: '@deepseek-ai/dsh-pwsh-sandbox', isolate: { shell: true } }] });
    const serviceFor = ctx.agentPresets.serviceFor.bind(ctx.agentPresets), instrumented = new WeakSet(), observedSpecs = new WeakSet();
    ctx.agentPresets.serviceFor = (agent, name) => {
      const service = serviceFor(agent, name);
      if (name === 'shell' && service && !instrumented.has(service)) {
        instrumented.add(service); const execute = service.execute.bind(service);
        service.execute = async spec => {
          if (observedSpecs.has(spec)) return execute(spec);
          observedSpecs.add(spec);
          const interval = { cwd: spec.workdir, mode: spec.sandboxPolicy.mode, sessionId: spec.sandboxPolicy.sessionId }; shellCalls.push(interval);
          if (spec.command.startsWith('Get-Content -LiteralPath ./')) { waiting.add(spec.sandboxPolicy.sessionId); await gate.promise; spec.signal?.throwIfAborted(); }
          interval.startedAt = Date.now();
          const handle = await execute(spec), result = handle.result.bind(handle);
          handle.result = async () => { try { return await result(); } finally { interval.finishedAt = Date.now(); } };
          return handle;
        };
      }
      return service;
    };
    await mount('dsh-agent-default-model', { provider: 'work-default', model: 'native-fixture' });
    await mount('dsh-session-persistence-jsonl', { root: path.join(root, 'sessions') }); await mount('dsh-agent-loop', { agents: [] });
    for (const [name, config] of [['dsh-storage', {}], ['dsh-storage-json', { root: path.join(root, 'storages') }], ['dsh-storage-domain', { backend: 'json' }], ['dsh-workspace', {}],
      ['dsh-session-title', { fallbackMaxWords: 10, fallbackMaxBytes: 160, maxTitleBytes: 256 }]]) await mount(name, config);
    ctx.systemPrompt.section({ name: 'native-context-fixture', order: 1, interpolate: false, text: 'NATIVE_DSH_CONTEXT: preserve the desktop preset and native tools.' });
    ctx.tools.register({ name: 'native_fixture_file', description: 'A native DSH file tool inherited from the desktop context',
      parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: ({ path: name, text }, exec) => {
        const cwd = ctx.workingDirectory.get(exec.agent.session); assert.notEqual(cwd, exec.agent.session.header.cwd);
        assert(['alpha.txt', 'beta.txt', 'followup.txt', 'budget-review.txt'].includes(name)); assert.equal(ctx.sandboxPolicy.resolve({ session: exec.agent.session }).mode, 'danger-full-access');
        fs.writeFileSync(path.join(cwd, name), text); nativeFileCalls.push({ sessionId: exec.agent.session.id, cwd, name });
        return JSON.stringify({ ok: true, path: name });
      } });
    registrations.push(ctx.llm.registerAdapter(['work-default'], new Fixture('native')), ctx.llm.registerAdapter(['chat-only'], new Fixture('polish')));
    const create = ctx.agents.create.bind(ctx.agents);
    ctx.agents.create = async options => {
      if (options.agentOptions?.provider === 'work-default' && options.meta?.cwd !== root) {
        assert.equal(options.agentOptions.model, 'native-fixture'); assert.equal(options.agentOptions.maxTokens, undefined); assert.equal(options.agentOptions.temperature, undefined);
        assert.equal(options.meta.agentPreset, 'native-test-coding'); nativeCreations.push({ id: options.sessionId, cwd: options.meta.cwd });
      }
      const handle = await create(options);
      if (process.env.NATIVE_HANDOFF_TRACE === '1' && options.agentOptions?.provider === 'chat-only') {
        const idle = handle.agent.whenIdle.bind(handle.agent);
        handle.agent.whenIdle = async () => { await idle(); console.log('Polish Agent trace', JSON.stringify(handle.agent.session.snapshotEvents().filter(event => /error|turn\/end/.test(event.type)))); };
      }
      return handle;
    };
    const store = new StateStore(path.join(root, 'channel')), accountId = 'native-owner', peerId = 'native-peer', scope = { accountId, chatType: 'private', peerId, senderId: peerId };
    store.setPersona({name:'进度测试角色',aliases:[],prompt:'PERSONA_WORK_STYLE: 熟悉直接，语气轻松，不说客服套话。'});
    fs.mkdirSync(path.join(store.ensureWorkspace(), '微信agent'), { recursive: true });
    store.configure(accountId, { enabled: true, privatePeers: [peerId, 'wxid_alice', 'visible-author'], groups: [], prompt: 'CHAT_SENTINEL' });
    store.setRoleCardSettings({ ...store.roleCardSettings(), enabled: false }, store.roleCardSettingsView().revision);
    store.setConversationSettings(accountId, 'private', peerId, { ...store.conversationSettings(accountId, 'private', peerId), executionMode: 'work', remoteEnabled: true });
    store.setModelChoice({ provider: 'chat-only', model: 'polish-fixture' }); store.setModelConfig({ ...store.modelConfig(), maxTokens: 321, temperature: 0.01, webSearch: true });
    const next = store.config.snapshot(store.data); next.remote = { globalAdminIds: [peerId] };
    next.imageGeneration = { enabled: true, defaultProviderId: '0809', providers: [
      { id: '0809', name: '0809', endpoint: 'https://0809.invalid/v1', models: ['gpt-image-2'], defaultModel: 'gpt-image-2', size: '1536x1024' },
      { id: 'second', name: 'Second', endpoint: 'https://second.invalid/v1', models: ['image-pro'], defaultModel: 'image-pro' },
    ] }; store.config.commit(next);
    fs.mkdirSync(path.dirname(wordPath)); const wordBytes = Buffer.from([80, 75, 3, 4, 0, 255, 128, 1]); fs.writeFileSync(wordPath, wordBytes);
    const sent = [], momentsCalls = [], momentsWrites = [], audienceCalls = [], transport = { status: () => ({ online: true, account: { id: accountId }, momentsReadReady: true, momentsWriteReady: true, momentsAudienceReady: true }),
      readMomentsAudience: async (args, signal) => { signal.throwIfAborted(); assert.equal(args.accountId, accountId); audienceCalls.push(args);
        return { accountId, source: 'wechat-contacts-live', fetchedAt: new Date().toISOString(), membershipComplete: true, unavailableCount: 0,
          contacts: [{ id: 'wxid_alice', name: 'Alice', nickname: 'Alice', remark: '', labelIds: ['1'] }], labels: [{ id: '1', name: '同事', memberCount: 1, userIds: ['wxid_alice'] }] }; },
      readMoments: async (args, signal) => { signal.throwIfAborted(); assert.equal(args.accountId, accountId); momentsCalls.push(args);
        if (args.query.action === 'comments') return { accountId, action: 'comments', postId: args.query.postId, source: 'wechat-sns-live',
          items: [{ id: '3', userId: 'visible-author', text: 'NATIVE_COMMENT_SOURCE' }], nextCursor: null };
        return { accountId, action: args.query.action, source: 'wechat-sns-live', items: [{ id: '9007199254740997', author: { userId: accountId, nickname: '合成账号' }, text: 'NATIVE_MOMENTS_FACT', imageCount: 1 }], nextCursor: null, mediaContentIncluded: false }; },
      writeMoments: async (args, signal) => { signal.throwIfAborted(); assert.equal(args.accountId, accountId); assert.match(args.clientId, /^sns_[a-f0-9]{64}$/); momentsWrites.push(args);
        return { accountId, action: args.query.action, postId: args.query.postId ?? '9007199254740999', text: args.query.text,
          liked: true, commentId: '9007199254741000', imageCount: args.query.images?.length ?? 0, delivery: 'server-ack',
          ...(args.query.action === 'publish' ? { audienceConfirmed: true, blockedLabelIds: args.query.blockedLabelIds ?? [], blockedUserIds: args.query.blockedUserIds ?? [],
            authorizationConfirmed: true, authorizationExcludedCount: 0,
            authorizedAudienceUserIds: args.query.blockedUserIds?.includes('wxid_alice') ? [] : ['wxid_alice'],
            audienceSelection: { blockedLabelIds: args.query.blockedLabelIds, blockedUserIds: args.query.blockedUserIds }, audienceSource: 'wechat-contacts-live', audienceFetchedAt: new Date().toISOString() } : {}),
          ...(args.query.replyToCommentId ? { replyToCommentId: args.query.replyToCommentId, replyToUserId: 'visible-author' } : {}),
          ...(args.query.action === 'delete' ? { deleted: true } : {}) }; }, send: async payload => {
      sent.push(payload); const deliveryParts = payload.message.map((part, index) => ({ index, type: part.type, state: 'acknowledged', serverMessageId: `native-ack-${sent.length}-${index}`,
        ...(part.type === 'text' ? {} : { name: part.data.name, bytes: Buffer.from(part.data.base64, 'base64').length, sha256: digest(Buffer.from(part.data.base64, 'base64')) }) }));
      return { delivery: 'server-ack', serverMessageIds: deliveryParts.map(part => part.serverMessageId), deliveryParts };
    } };
    const runner = new DshAgentRunner(ctx, () => store.modelChoice(), () => ({ modelConfig: store.modelConfig(), workspacePath: path.join(store.ensureWorkspace(), '微信agent') }));
    channel = new WechatChannel({ store, runner, transport }); const apiCalls = [];
    channel.work.imageGeneration = new ImageGenerationService({ credentials: { resolve: async () => ({ value: 'synthetic-image-key' }) } }, store, { fetchImpl: async (url, options) => {
      apiCalls.push({ url, body: JSON.parse(options.body) }); const prompt = apiCalls.at(-1).body.prompt;
      if (prompt === 'EMPTY_IMAGE_RESULT') return Response.json({ data: [{ b64_json: '', url: '' }] });
      const encoded = imageBytes.toString('base64').replace(/=+$/, '').match(/.{1,76}/g).join('\r\n');
      return Response.json({ data: [{ b64_json: prompt === 'EXISTING_IMAGE_URL' ? '' : 'data:image/png;base64,' + encoded,
        ...(prompt === 'EXISTING_IMAGE_URL' ? { url: 'data:image/png;base64,' + encoded } : {}) }] });
    } });
    let serial = 0;
    const receive = text => channel.receive({ id: 'native-message-' + ++serial, direction: 'incoming', chatType: 'private', peerId, sender: { id: peerId },
      time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] }, accountId);
    const completed = async (text, newSession = false) => { receive(newSession ? '/work new ' + text : text); await channel.whenIdle(); return channel.work.list(scope).jobs[0]; };
    receive('你好'); await channel.whenIdle();
    assert.equal(store.data.records.at(-1).state, 'sent', JSON.stringify(store.data.records.at(-1)));
    assert.equal(channel.work.list(scope).jobs.length, 0); assert.equal(routingRequests.length, 1);
    assert.equal(nativeRequests.length, 0); assert.equal(polishRequests.length, 0);
    receive(parentRequest); await until(() => waiting.size === 2 || channel.work.list(scope).jobs.some(job => job.state === 'failed'));
    assert.equal(waiting.size, 2, JSON.stringify(channel.work.list(scope).jobs)); assert.equal(channel.work.active.size, 2);
    const parallel = channel.work.list(scope).jobs.filter(job => childRequests.includes(job.request)), parent = channel.work.list(scope).jobs.find(job => job.request === parentRequest);
    assert.equal(parallel.length, 2); assert.equal(parent.state, 'succeeded');
    for (const key of ['id', 'cwd', 'sessionId']) assert.equal(new Set([parent, ...parallel].map(job => job[key])).size, 3, key);
    const modelCount = nativeRequests.length, jobCount = channel.work.list(scope).jobs.length;
    const progressSentBefore = sent.length;
    assert([...channel.work.active.values()].every(value => value.progress && !value.progress.closed));
    assert.equal(progressRequests.length, 0); assert.equal(sent.length, progressSentBefore);
    await Promise.all([...channel.work.active.values()].map(value => value.progress.tick()));
    assert.equal(progressRequests.length, 2); assert.equal(sent.length, progressSentBefore + 2);
    assert.equal(nativeRequests.length, modelCount); assert.equal(channel.work.list(scope).jobs.length, jobCount);
    assert(sent.slice(progressSentBefore).every(payload => payload.message.length === 1 && payload.message[0].type === 'text'));
    for (const job of parallel) {
      const current=channel.work.get(job.id, scope); assert.equal(current.progress.state, 'sent');
      assert.equal(current.progress.acknowledgedMessageIds.length, 1);
      assert.equal(current.delivery.state,'not-ready');
    }
    receive('/work status ' + parallel[0].id); await until(() => !channel.workReplies.size);
    assert.equal(nativeRequests.length, modelCount); assert.equal(channel.work.list(scope).jobs.length, jobCount);
    assert(sent.some(payload => JSON.stringify(payload).includes('正在执行'))); gate.resolve(); await channel.whenIdle();
    const children = channel.work.list(scope).jobs.filter(job => childRequests.includes(job.request));
    for (const job of children) {
      assert.equal(job.state, 'succeeded', JSON.stringify(job)); assert.equal(job.delivery.artifacts[0].state, 'sent'); assert.equal(job.nativeExecution, true);
      assert.equal(job.operations.length, 1); assert.equal(job.operations[0].tool, 'wechat_work_exec');
      const artifact = job.result.artifacts[0], part = sent.flatMap(payload => payload.message).find(part => part.type === 'file' && part.data.name === artifact.name);
      assert.deepEqual(Buffer.from(part.data.base64, 'base64'), fs.readFileSync(path.join(job.cwd, artifact.path)));
      assert(await ctx.sessionPersistence.stat(job.sessionId));
      const persisted = await ctx.sessionPersistence.open(job.sessionId, 'read');
      try { const stored = await persisted.read(); const snapshot = (await ctx.sessionPersistence.list()).find(value => value.header.id === job.sessionId);
        assert.equal(snapshot.header.cwd, job.workspaceRoot);
        assert(stored.events.some(event => event.type === 'working-directory/change' && event.data.cwd === job.cwd));
        assert(stored.events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')); }
      finally { await persisted.close(); }
    }
    assert.equal(nativeFileCalls.length, 2); assert.equal(confinedCalls, 0); assert(shellCalls.every(call => call.mode === 'danger-full-access'));
    const wechatProjects = ctx.workspaceRegistry.list().filter(project => project.path === store.ensureWorkspace() || project.path === path.join(store.ensureWorkspace(), '微信agent'));
    assert.equal(wechatProjects.length, 2); assert.deepEqual(wechatProjects.map(project => project.title).sort(), ['微信工作', '微信聊天']);
    const workProject = wechatProjects.find(project => project.title === '微信工作');
    for (const job of [parent, ...parallel]) assert(workProject.sessionIds.includes(job.sessionId));
    assert(!ctx.workspaceRegistry.list().some(project => [parent, ...parallel].some(job => project.path === job.cwd)));
    const legacyJobId = 'aaaaaaaaaa01', legacySessionId = randomUUID(), legacyFolder = `微信agent/work/${legacyJobId}`,
      legacyCwd = path.join(store.ensureWorkspace(), legacyFolder);
    fs.mkdirSync(legacyCwd, { recursive: true }); fs.writeFileSync(path.join(legacyCwd, 'retained.txt'), 'LEGACY_FILE_UNCHANGED');
    const original = await ctx.sessionPersistence.open(parent.sessionId, 'read');
    let legacyEvents, legacyHeader;
    try { legacyEvents = structuredClone((await original.read()).events); legacyHeader = { ...original.header, id: legacySessionId, cwd: legacyCwd }; }
    finally { await original.close(); }
    for (const event of legacyEvents) if (event.type === 'working-directory/change') event.data.cwd = legacyCwd;
    const legacyWriter = await ctx.sessionPersistence.create(legacyHeader);
    try { await legacyWriter.append(legacyEvents); await legacyWriter.flush(); } finally { await legacyWriter.close(); }
    const legacyProject = await ctx.workspaceRegistry.create(legacyCwd, '微信agent'); await legacyProject.attachSession(legacySessionId);
    channel.work.store.add({ ...parent, id: legacyJobId, folder: legacyFolder, sessionId: legacySessionId, conversationTurn: false });
    const legacyLive = await ctx.agents.resume({ resumeSessionId: legacySessionId, agentOptions: { provider: 'work-default', model: 'native-fixture' },
      setup: local => { local.tools.presentAs('native'); } });
    legacyLive.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: legacyBusyRequest }], source: { kind: 'user' } }));
    try {
      await legacyBusyEntered.promise; assert.equal(legacyLive.agent.status, 'running');
      const deferred = await consolidateWorkProjects(ctx, channel.work.store, store.ensureWorkspace());
      assert.equal(deferred.state, 'partial'); assert.equal(deferred.migrated, 0);
      assert(deferred.pending.some(value => value.sessionId === legacySessionId && value.code === 'WORK_SESSION_BUSY'));
      assert(!ctx.workspaceRegistry.archivedSessionIds.includes(legacySessionId)); assert.equal(ctx.agents.get(legacySessionId), legacyLive.agent);
      assert(ctx.workspaceRegistry.list().some(project => project.id === legacyProject.id));
    } finally { legacyBusyRelease.resolve(); await legacyLive.agent.whenIdle(); await legacyLive.dispose(); }
    const completedLegacyRead = await ctx.sessionPersistence.open(legacySessionId, 'read');
    try { legacyEvents = (await completedLegacyRead.read()).events; } finally { await completedLegacyRead.close(); }
    const sharedLegacyId = randomUUID(), sharedLegacyJob = 'aaaaaaaaaa03';
    const chatCwd = path.join(store.ensureWorkspace(), '微信agent');
    const sharedHandle = await ctx.agents.create({ sessionId: sharedLegacyId,
      meta: { cwd: chatCwd, agentPreset: 'native-test-coding' },
      agentOptions: { provider: 'work-default', model: 'native-fixture' },
      setup: local => { local.tools.presentAs('native'); } });
    sharedHandle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: legacyBusyRequest }], source: { kind: 'user' } }));
    await sharedHandle.agent.whenIdle(); await sharedHandle.dispose();
    const sharedOriginal = await ctx.sessionPersistence.open(sharedLegacyId, 'read');
    let sharedEvents;
    try { sharedEvents = (await sharedOriginal.read()).events; } finally { await sharedOriginal.close(); }
    assert(!sharedEvents.some(event => /error/.test(event.type)));
    assert(sharedEvents.some(event => event.type === 'turn/end'));
    assert(!sharedEvents.some(event => event.type === 'working-directory/change'));
    const chatProject = await ctx.workspaceRegistry.resolveByPath(chatCwd); await chatProject.attachSession(sharedLegacyId);
    channel.work.store.add({ ...parent, id: sharedLegacyJob, folder: legacyFolder, sessionId: sharedLegacyId, conversationTurn: false });
    const sharedModelCount = nativeRequests.length;
    const sharedMigration = await migrateWorkProjectSession(ctx, channel.work.store, sharedLegacyId, legacyCwd, store.ensureWorkspace());
    assert.equal(sharedMigration.state, 'migrated'); assert.equal(nativeRequests.length, sharedModelCount);
    assert.equal(channel.work.store.get(sharedLegacyJob).sessionId, sharedMigration.sessionId);
    const sharedRead = await ctx.sessionPersistence.open(sharedMigration.sessionId, 'read');
    try {
      const sharedAfter = (await sharedRead.read()).events;
      assert.equal(sharedRead.header.cwd, store.ensureWorkspace());
      assert.deepEqual(sharedAfter.slice(0, sharedEvents.length), sharedEvents);
      assert.equal(sharedAfter.at(-1).type, 'working-directory/change'); assert.equal(sharedAfter.at(-1).data.cwd, legacyCwd);
    } finally { await sharedRead.close(); }
    assert(ctx.workspaceRegistry.archivedSessionIds.includes(sharedLegacyId));
    const foreignChatId = randomUUID(), foreignChatWriter = await ctx.sessionPersistence.create({ ...legacyHeader, id: foreignChatId, cwd: chatCwd });
    try { await foreignChatWriter.flush(); } finally { await foreignChatWriter.close(); }
    await chatProject.attachSession(foreignChatId);
    await assert.rejects(migrateWorkProjectSession(ctx, channel.work.store, foreignChatId, legacyCwd, store.ensureWorkspace()), { code: 'WORK_PROJECT_MISMATCH' });
    assert(!ctx.workspaceRegistry.archivedSessionIds.includes(foreignChatId));
    assert(chatProject.sessionIds.includes(foreignChatId)); assert.equal(nativeRequests.length, sharedModelCount);
    const seededLegacyId = randomUUID(), seededLegacy = await ctx.agents.create({ sessionId: seededLegacyId, seed: legacyEvents,
      inheritedEventCount: legacyEvents.length, meta: { cwd: legacyCwd, parentSession: legacySessionId, isSeeded: true, agentPreset: 'native-test-coding' },
      agentOptions: { provider: 'work-default', model: 'native-fixture' } });
    await seededLegacy.dispose(); await legacyProject.attachSession(seededLegacyId);
    channel.work.store.add({ ...parent, id: 'aaaaaaaaaa02', folder: legacyFolder, sessionId: seededLegacyId, conversationTurn: false });
    const seededRead = await ctx.sessionPersistence.open(seededLegacyId, 'read');
    let seededEvents, seededInheritedCount;
    try { seededEvents = (await seededRead.read()).events; seededInheritedCount = seededRead.inheritedEventCount; }
    finally { await seededRead.close(); }
    const beforeMigrationRequests = nativeRequests.length, migration = await consolidateWorkProjects(ctx, channel.work.store, store.ensureWorkspace());
    if (migration.pending.length) await migrateWorkProjectSession(ctx, channel.work.store, legacySessionId, legacyCwd, store.ensureWorkspace());
    assert.equal(migration.state, 'ready', JSON.stringify(migration)); assert.equal(migration.migrated, 2);
    assert(migration.removedProjects.includes(legacyProject.id)); assert.equal(nativeRequests.length, beforeMigrationRequests);
    const migratedJob = channel.work.store.get(legacyJobId); assert.notEqual(migratedJob.sessionId, legacySessionId);
    assert(workProject.sessionIds.includes(migratedJob.sessionId)); assert(ctx.workspaceRegistry.archivedSessionIds.includes(legacySessionId));
    for (const [id, expectedCwd] of [[legacySessionId, legacyCwd], [migratedJob.sessionId, store.ensureWorkspace()]]) {
      const stored = await ctx.sessionPersistence.open(id, 'read');
      try { assert.equal(stored.header.cwd, expectedCwd); assert.deepEqual((await stored.read()).events.slice(0, legacyEvents.length), legacyEvents); }
      finally { await stored.close(); }
    }
    const seededTarget = channel.work.store.get('aaaaaaaaaa02').sessionId;
    for (const id of [seededLegacyId, seededTarget]) {
      const stored = await ctx.sessionPersistence.open(id, 'read');
      try { assert.equal(stored.header.isSeeded, true); assert.equal(stored.inheritedEventCount, seededInheritedCount);
        assert.deepEqual((await stored.read()).events.slice(0, seededEvents.length), seededEvents); }
      finally { await stored.close(); }
    }
    assert.equal(fs.readFileSync(path.join(legacyCwd, 'retained.txt'), 'utf8'), 'LEGACY_FILE_UNCHANGED');
    assert.equal((await consolidateWorkProjects(ctx, channel.work.store, store.ensureWorkspace())).migrated, 0);
    const createdFile = await completed('创建 followup.txt，内容为 CONTEXT_FILE_MARKER');
    assert.equal(createdFile.state, 'succeeded', JSON.stringify(createdFile)); assert.equal(createdFile.delivery.artifacts[0].state, 'sent');
    assert.equal(fs.readFileSync(path.join(createdFile.cwd, 'followup.txt'), 'utf8'), 'CONTEXT_FILE_MARKER');
    const createdOperations = JSON.stringify(createdFile.operations), removedFile = await completed('删除这个文件');
    assert.equal(removedFile.state, 'succeeded', JSON.stringify(removedFile)); assert.equal(removedFile.sessionId, createdFile.sessionId); assert.equal(removedFile.cwd, createdFile.cwd);
    assert.equal(removedFile.continues, createdFile.id); assert(!fs.existsSync(path.join(createdFile.cwd, 'followup.txt')));
    assert.equal(JSON.stringify(channel.work.store.get(createdFile.id).operations), createdOperations);
    assert(shellCalls[0].finishedAt > shellCalls[1].startedAt && shellCalls[1].finishedAt > shellCalls[0].startedAt, 'real native commands did not overlap');
    channel.remote.tasks = () => ({ observedAt: Date.now(), total: 1, running: 1, tasks: [{ id: 'existing-native', title: 'NATIVE_HOST_FACT', status: 'running', cwd: root, seq: 3, queued: 0, jobs: [] }], backgroundJobs: [] });
    const status = await completed('/dsh tasks'); assert.equal(status.request, '/dsh tasks'); assert(status.result.text.includes('NATIVE_HOST_FACT'));
    const moments = await completed('读取当前微信朋友圈'); assert.equal(moments.state, 'succeeded');
    assert.equal(momentsCalls.length, 1); assert.equal(moments.operations.at(-1).tool, 'wechat_moments_read');
    const comments = await completed('拉取当前微信朋友圈评论区'); assert.equal(comments.state, 'succeeded');
    assert.equal(comments.operations.at(-1).tool, 'wechat_moments_comments'); assert.equal(momentsCalls.at(-1).query.postId, '9007199254740997');
    for (const request of ['点赞当前微信朋友圈', '评论当前微信朋友圈', '发布文字朋友圈', '回复当前微信朋友圈评论', '删除当前微信朋友圈']) {
      const job = await completed(request); assert.equal(job.state, 'succeeded'); assert.equal(job.operations.at(-1).result.delivery, 'server-ack');
      assert(job.operations.at(-1).tool.startsWith('wechat_moments_'));
    }
    assert.equal(momentsWrites.length, 5);
    const privacy = await completed('屏蔽同事发布朋友圈'); assert.equal(privacy.state, 'succeeded'); assert.equal(audienceCalls.length, 1);
    assert.deepEqual(privacy.operations.filter(row => /^wechat_moments_/.test(row.tool)).map(row => row.tool), ['wechat_moments_audience','wechat_moments_publish']);
    assert.deepEqual(momentsWrites.at(-1).query.blockedLabelIds, ['1']); assert.deepEqual(momentsWrites.at(-1).query.blockedUserIds, ['wxid_alice']);
    const beforePlans = momentsWrites.length;
    for (const request of ['设置自动发布计划', '预览朋友圈草稿', '设置定时评论回复']) {
      const job = await completed(request); assert.equal(job.state, 'succeeded', JSON.stringify(job)); assert(job.operations.at(-1).result.ok);
    }
    assert.equal(momentsWrites.length, beforePlans); assert.equal(channel.momentsAutomation.publishing.list(accountId).plans.length, 1);
    assert.equal(channel.momentsAutomation.publishing.list(accountId).settings.enabled, false);
    const savedMoments = new WorkStore(store).list(scope).filter(job => job.operations.some(op => /^wechat_moments_/.test(op.tool)));
    for (const name of ['wechat_moments_comments', 'wechat_moments_reply', 'wechat_moments_delete']) assert(savedMoments.some(job => job.operations.some(op => op.tool === name)));
    for (const name of ['wechat_moments_plan', 'wechat_moments_draft', 'wechat_moments_reply_schedule']) assert(savedMoments.some(job => job.operations.some(op => op.tool === name)));
    const word = await completed('找到已有的新闻摘要 Word 并发给我'); assert.equal(word.delivery.artifacts[0].state, 'sent');
    assert.deepEqual(fs.readFileSync(path.join(word.cwd, word.result.artifacts[0].path)), wordBytes); assert.deepEqual(fs.readFileSync(wordPath), wordBytes);
    let retiredFileCalls = 0;
    transport.files = async () => { retiredFileCalls++; throw Error('Retired attachment API must not run'); };
    const beforeFile = { requests: nativeRequests.length, sent: sent.length };
    channel.receive({ direction: 'incoming', chatType: 'private', peerId, sender: { id: peerId }, time: Math.floor(Date.now() / 1000),
      messageType: 49, id: 'retired-attachment', serverMessageId: '18446744073709551001',
      message: [{ type: 'file', data: { name: 'retired.docx', bytes: wordBytes.length } }] }, accountId);
    await channel.whenIdle(); assert.equal(nativeRequests.length, beforeFile.requests); assert.equal(sent.length, beforeFile.sent);
    const retired = await completed(retiredFileRequest, true);
    assert.equal(retiredFileCalls, 0); assert.equal(retired.result.artifacts.length, 0);
    assert(!retired.operations.some(operation => operation.tool === 'wechat_file'));
    delete transport.files;
    const old = channel.work.create(scope, 'OLD_TASK_REQUEST：旧 SSH 与沙箱失败', undefined, { defer: true }); channel.work.cancel(old.id, scope);
    channel.work.store.update(old.id, { result: { text: 'OLD_TASK_RESULT：历史失败', files: [] } });
    const createdAt = Date.now() - 1000;
    store.remember('old-dialogue', createdAt, { ...scope, key: 'old-dialogue', mode: 'work', state: 'sent', createdAt, question: 'OLD_DIALOGUE_QUESTION：旧工作', reply: 'OLD_DIALOGUE_REPLY：旧限制', createdWorkJobIds: [old.id] });
    const dog = await completed('生成一张小狗的图片给我'); assert.equal(dog.request, '生成一张小狗的图片给我'); assert.equal(dog.imageRequest, undefined);
    assert.equal(dog.delivery.artifacts[0].state, 'sent'); assert.equal(apiCalls.length, 1); assert.equal(apiCalls[0].url, 'https://0809.invalid/v1/images/generations');
    assert.equal(apiCalls[0].body.model, 'gpt-image-2'); assert.equal(apiCalls[0].body.size, '1536x1024'); assert.deepEqual(fs.readFileSync(path.join(dog.cwd, 'dog.png')), imageBytes);
    assert.equal(dog.imageArchives.length, 1); assert.equal(dog.imageArchives[0].state, 'saved');
    assert.deepEqual(fs.readFileSync(path.join(dog.workspaceRoot, dog.imageArchives[0].path)), imageBytes);
    assert.equal(dog.result.artifacts[0].path, 'dog.png');
    const poster = await completed('使用 second 的 image-pro 生成橙猫海报'); assert.equal(poster.delivery.artifacts[0].state, 'sent');
    assert.equal(apiCalls[1].url, 'https://second.invalid/v1/images/generations'); assert.equal(apiCalls[1].body.model, 'image-pro'); assert.equal(apiCalls[1].body.size, '2048x2048');
    assert.equal(poster.imageArchives[0].state, 'saved'); assert.notEqual(poster.imageArchives[0].path, dog.imageArchives[0].path);
    const empty = await completed('验证空图片响应'); assert.equal(empty.state, 'failed'); assert.equal(apiCalls.length, 3);
    assert.equal(empty.result.artifacts.length, 0); assert.equal(empty.operations[1].result.code, 'WORK_IMAGE_ALREADY_ATTEMPTED');
    assert(!fs.existsSync(path.join(empty.cwd, 'empty.png'))); assert(empty.result.originalText.includes('0809'));
    const url = await completed('验证已有图片链接'); assert.equal(url.delivery.artifacts[0].state, 'sent'); assert.equal(apiCalls.length, 4); assert.deepEqual(fs.readFileSync(path.join(url.cwd, 'url.png')), imageBytes);
    await completed('回顾刚才的工作对话');
    const fallback = await completed('测试润色数字保护'); assert.equal(fallback.result.polish.state, 'fallback'); assert.equal(fallback.result.text, '原生 DSH 返回 42。');
    const apiFailure = await completed('测试润色 API 故障'); assert.equal(apiFailure.state, 'succeeded'); assert.equal(apiFailure.result.polish.state, 'fallback'); assert.equal(apiFailure.result.text, '原生 DSH 返回 42。');
    const alpha = children.find(job => job.request.includes('alpha.txt'));
    retained = await ctx.agents.resume({ resumeSessionId: alpha.sessionId, agentOptions: { provider: 'work-default', model: 'native-fixture' }, signal: new AbortController().signal });
    await retained.agent.whenIdle(); const retainedAgent = retained.agent, retainedSeq = retainedAgent.session.seq, retainedEvents = retainedAgent.session.snapshotEvents(), retainedPresentation = ctx.tools.modeFor(retainedAgent);
    const consolidatedLive = await consolidateWorkProjects(ctx, channel.work.store, store.ensureWorkspace(), AbortSignal.timeout(5000));
    assert(!consolidatedLive.pending.some(row => row.sessionId === alpha.sessionId));
    assert.equal(ctx.agents.get(alpha.sessionId), retainedAgent); assert.equal(retainedAgent.session.seq, retainedSeq);
    assert.deepEqual(retainedAgent.session.snapshotEvents(), retainedEvents);
    const nextTask = channel.work.create(scope, '继续这项工作，只检查现有文件', alpha.id, { conversationTurn: true }); await channel.whenIdle();
    const continued = channel.work.get(nextTask.id, scope); assert.equal(continued.state, 'succeeded', JSON.stringify(continued)); assert.equal(continued.sessionId, alpha.sessionId); assert.equal(continued.cwd, alpha.cwd);
    assert(retainedAgent.session.seq > retainedSeq); assert.deepEqual(retainedAgent.session.snapshotEvents().slice(0, retainedEvents.length), retainedEvents); assert.equal(ctx.agents.get(alpha.sessionId), retainedAgent);
    const previousOperations = JSON.stringify(continued.operations), repeated = await completed('继续这项工作，只检查现有文件');
    assert.equal(repeated.state, 'succeeded', JSON.stringify(repeated)); assert.equal(repeated.sessionId, alpha.sessionId);
    assert.equal(JSON.stringify(channel.work.store.get(continued.id).operations), previousOperations);
    assert.equal(repeated.operations.filter(operation => operation.tool === 'wechat_work_read').length, 1);
    assert.equal(ctx.tools.modeFor(retainedAgent), retainedPresentation); assert.equal(ctx.agents.get(alpha.sessionId), retainedAgent);
    const revoked = store.config.snapshot(store.data); revoked.remote = { globalAdminIds: [] }; store.config.commit(revoked); administrator = false;
    const beforeRevokedMessage = { native: nativeRequests.length, jobs: channel.work.list(scope).jobs.length, sent: sent.length };
    receive('解释工具调用'); await channel.whenIdle();
    assert.equal(nativeRequests.length, beforeRevokedMessage.native); assert.equal(channel.work.list(scope).jobs.length, beforeRevokedMessage.jobs);
    assert.equal(sent.length, beforeRevokedMessage.sent);
    assert.match(store.data.records.at(-1).reason, /其他成员需呼叫 Agent 名字/);
    const granted = store.config.snapshot(store.data); granted.remote = { globalAdminIds: [peerId] }; store.config.commit(granted); administrator = true;
    const oneMore = await completed('生成一张小狗的图片给我', true); assert.notEqual(oneMore.sessionId, dog.sessionId); assert.notEqual(oneMore.cwd, dog.cwd); assert.equal(apiCalls.length, 5);
    for (const job of [dog, poster, url, oneMore]) {
      const part = sent.flatMap(payload => payload.message).find(part => part.type === 'image' && part.data.name === job.result.artifacts[0].name);
      assert.deepEqual(Buffer.from(part.data.base64, 'base64'), imageBytes); assert.equal(job.delivery.artifacts[0].state, 'sent');
    }
    for (let index = 0; index < 2; index++) policyHandles.push(await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'work-default', model: 'native-fixture' }, meta: { cwd: root },
      setup: async local => { await ctx.agentPresets.mount(local, 'native-test-coding'); } }));
    const [one, two] = policyHandles.map(handle => handle.agent.session), { setSandboxMode } = host('@deepseek-ai/dsh-sandbox-policy');
    setSandboxMode(one, 'read-only'); assert.equal(ctx.sandboxPolicy.resolve({ session: two }).mode, 'danger-full-access');
    const shell = ctx.agentPresets.serviceFor(policyHandles[0].agent, 'shell'), operations = [];
    const context = { cwd: root, shell, resolvePolicy: () => ctx.sandboxPolicy.resolve({ session: one }), limits: { commandTimeoutSeconds: 10 }, assertAllowed() {}, onOperation: operation => operations.push(operation) };
    const tools = workTools(context), exec = { agent: policyHandles[0].agent, signal: new AbortController().signal };
    const write = args => tools.find(tool => tool.name === 'wechat_work_write').execute(args, exec).then(JSON.parse);
    assert.equal((await write({ path: 'policy.txt', text: 'blocked', revision: null })).code, 'WORK_PERMISSION_DENIED'); assert(!fs.existsSync(path.join(root, 'policy.txt')));
    setSandboxMode(one, 'danger-full-access'); assert.equal((await write({ path: 'policy.txt', text: 'LIVE_POLICY', revision: null })).ok, true);
    const execute = command => tools.find(tool => tool.name === 'wechat_work_exec').execute({ command }, exec).then(JSON.parse);
    assert.equal((await execute('exit 7')).exitCode, 7);
    const timeoutTools = workTools({ ...context, limits: { commandTimeoutSeconds: 1 } });
    const timeout = JSON.parse(await timeoutTools.find(tool => tool.name === 'wechat_work_exec').execute({ command: 'Start-Sleep -Seconds 20' }, exec)); assert.equal(timeout.timedOut, true);
    const controller = new AbortController(), cancelled = tools.find(tool => tool.name === 'wechat_work_exec').execute({ command: 'Start-Sleep -Seconds 20' }, { ...exec, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new ChannelError('WORK_CANCELLED', '合成取消请求')), 300);
    try { await assert.rejects(cancelled, error => error.code === 'WORK_CANCELLED'); assert.equal(operations.at(-1).result.cancelled, true); } finally { clearTimeout(timer); }
    assert.equal(confinedCalls, 0);
    assert.deepEqual(store.history(accountId, 'private', peerId, 100).filter(entry => !entry.files?.length).map(entry => entry.text), ['你好', '聊天回应', '解释工具调用']);
    assert.deepEqual(channel.memory.load(scope).entries.filter(entry => !entry.files?.length).map(entry => entry.text), ['你好', '聊天回应', '解释工具调用']);
    assert.equal(store.history(accountId, 'private', peerId, 100).filter(entry => entry.files?.length).length, 1);
    const restored = new WorkStore(store); assert.equal(restored.get(status.id).state, 'succeeded'); assert.equal(restored.get(apiFailure.id).state, 'succeeded');
    assert.equal(restored.get(retired.id).state, 'succeeded');
    assert.deepEqual(restored.get(retired.id).operations, JSON.parse(JSON.stringify(retired.operations)));
    const report = { ok: true, root, modelRequests: nativeRequests.length, routingRequests: routingRequests.length, polishRequests: polishRequests.length, progressRequests: progressRequests.length, actualImageApiCalls: apiCalls.length,
      nativeFileCalls: nativeFileCalls.length, nativeShellCalls: shellCalls.length, assertions: [
        'original user text reaches native DSH unchanged with only scoped conversation style', 'native DSH context and inherited tool remain available', 'native tool declarations reach the model in the isolated SDK host',
        'native work dialogue and every public work report retain the current persona', 'native periodic progress uses isolated evidence without starting work or sending artifacts; explicit status remains available',
        'DSH default model and preset are retained despite different chat settings', 'work and chat use two fixed projects with exact native header membership', 'DSH working-directory service uses the actual task folder',
        'native parent starts two children with unique task IDs, sessions and folders', 'two real command tasks overlap without blocking explicit status', 'native file tools need no WeChat output registration',
        'collected files preserve bytes and individual simulated WeChat ACKs', 'completed work sessions retain native user source and persisted cwd',
        'legacy project migration preserves every event and file without a model request and retains the archived original',
        'busy legacy sessions defer consolidation without stopping activity', 'forked legacy sessions preserve their exact inherited markers and prefix', 'old shared-project work migrates only with the saved task association and retains its exact prefix', 'unrelated chat history is never moved into work', 'full access avoids sandbox confinement and ACL preparation',
        'existing external Word is returned as an immutable copy', 'retired attachment tools stay absent from the real native SDK',
        'received file metadata stays silent and no attachment transport is invoked',
        'standalone work does not preload prior work or dialogue bodies', 'history is queried only through an explicit native tool',
        '0809 defaults and selected image provider/model/size reach the actual API request', 'wrapped base64 and existing URL responses preserve image bytes', 'empty image failures name the actual provider without retry or fallback',
        'generated native images have exact independent main-directory archives and retain relative delivery paths',
        'a repeated image invocation with a new filename makes no second API request', 'work classification reads only owned work context without tools or chat persona',
        'greetings return to chat without creating native work', 'work result polishing has no tools or chat context',
        'polish changes to numbers and API errors fall back to the native original', 'natural create/delete instructions share the native session and original file context',
        'startup consolidation preserves live idle work Agents without waiting on their persistence locks',
        'desktop-loaded history is appended in place and the original Agent and prefix remain', 'repeated followups refresh tool callbacks and restore original tool presentation',
        'revoked administrators return to nickname chat and plain text creates no native task', 'explicit independent requests use independent sessions', 'session permission changes remain isolated and affect the next file operation',
        'actual exit code, timeout and cancellation are recorded', 'native completion classifications survive restart', 'work results remain outside chat memory',
        'read-only moments tool reaches the native model, invokes the scoped account reader and disappears after administrator revocation',
        'native model invokes logged-account like tool with durable request identity', 'native model invokes comment tool and preserves its confirmed operation',
        'native model invokes text publishing and persisted work records reload without repeating social writes',
        'native model reads real audience IDs and chooses blocked labels and contacts on publishing',
        'native model registers a disabled publishing plan through the shared tools', 'native model generates and retains a draft through the isolated chat API without posting',
        'native model configures scheduled comment replies and new operation records survive restart'],
      productionWechatMessages: 0, productionImageApiCalls: 0 };
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  } finally {
    gate.resolve(); await channel?.close();
    for (const handle of [retained, ...policyHandles].filter(Boolean)) { handle.agent.cancel({ kind: 'disposed' }); await handle.agent.whenIdle(); await handle.dispose(); }
    for (const unregister of registrations) unregister(); await unregisterPreset?.(); for (const fork of forks.reverse()) await fork.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
