/* Run through the installed DSH Electron/Node executable, without mounting a
 * user profile, credentials, skills, network providers or a WeChat session. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { syncBuiltinESMExports } = require('node:module');
const repo = path.resolve(__dirname, '..');
const installation = process.argv[2] || process.env.DSH_INSTALLATION;
if (!installation) throw new Error('Pass the DeepSeek Harness installation directory as an argument or DSH_INSTALLATION');
const suiteTimeoutMs = Number(process.env.WECHAT_NATIVE_TEST_TIMEOUT_MS || 45000);
if (!Number.isSafeInteger(suiteTimeoutMs) || suiteTimeoutMs < 1) throw new Error('WECHAT_NATIVE_TEST_TIMEOUT_MS must be a positive integer');
for (const name of ['tmp', 'logs']) fs.mkdirSync(path.join(repo, 'storage', name), { recursive: true });
if (!process.versions.electron) {
  const run = spawnSync(path.join(installation, 'DeepSeek Harness.exe'), ['--expose-internals', __filename, installation], {
    windowsHide: true, encoding: 'utf8', timeout: suiteTimeoutMs,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
  if (run.error) console.error(run.error.message);
  process.exit(run.status ?? 1);
}
const hostRequire = createRequire(path.join(installation, 'resources/app.asar/dsh/package.json'));
const { Context } = hostRequire('@deepseek-ai/cordis');
const { LlmAdapter } = hostRequire('@deepseek-ai/dsh-llm');
const { buildModelCatalog } = hostRequire('@deepseek-ai/dsh-api-session-controller');
const { DshAgentRunner, WechatChannel, StateStore, TaskScheduler, AgentIdentity, conversationMemoryTool, imageMemoryTool, conversationImageTool, completedText, conversationTaskTool, webSearchTool, ChannelError, selectModel, readModelInfo, emptyNaturalSettings, REPLY_STYLE_REVIEW_NOTE } = require(path.join(repo, 'lib/testing.js'));
const { momentsLikeRequestTool, momentsInteractionTool, momentsImagesTool, momentsPublishingTools, resolveMessageReferences, referenceText } = require(path.join(repo, 'lib/testing.js'));
const fixtureParent = path.resolve(process.env.WECHAT_NATIVE_TEST_TMPDIR || path.join(repo, 'storage/tmp'));
fs.mkdirSync(fixtureParent, { recursive: true });
const root = fs.mkdtempSync(path.join(fixtureParent, 'dsh-native-'));
process.env.DSH_HOME = path.join(root, 'home');
process.env.DSH_AGENTS_HOME = path.join(root, 'agents');
const ctx = new Context();
const requests = [];
const longCompleteReply = '收到你的问题。\n' + '双曲线：x²/a² − y²/b² = 1。抛物线：y² = 2px。\n'.repeat(500) + '完整结尾。';
let mode = 'complete';
let emptyResponses = 0;
class FixtureAdapter extends LlmAdapter {
  async listModels(provider) {
    return ['fixture', 'alternate'].map(id => ({ provider, id, name: `测试模型 ${id}` }));
  }
  async resolveModel(provider, id) {
    return { provider, id, name: `测试模型 ${id}`, inputModalities: ['text', 'image'], defaultMaxTokens: id === 'alternate' ? 131072 : 256000, reasoning: {
      efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], defaultEffort: id === 'alternate' ? 'low' : 'high'
    } };
  }
  async *stream(options) {
    requests.push(options);
    const incomingImages = options.messages.flatMap(message => message.content || []).filter(block => block.type === 'image');
    const expectedTools = mode === 'moments-reply-schedule-tool' ? ['wechat_moments_reply_schedule'] : mode === 'moments-images-tool' && !incomingImages.length ? ['wechat_moments_images'] : ['moments-interaction-tool', 'moments-interaction-auto-tool'].includes(mode) ? ['wechat_moments_interact'] : mode === 'moments-like-tool' ? ['wechat_moments_like_recent'] : mode === 'image-request-tool' && !incomingImages.length ? ['wechat_read_image'] : mode === 'generated-image-memory-tool' && !incomingImages.length ? ['wechat_generated_image_memory'] : mode === 'image-memory-tool' && !incomingImages.length ? ['wechat_image_memory'] : mode === 'task-tool' || mode === 'task-denied' ? ['wechat_task'] : mode === 'search-tool' ? ['wechat_web_search'] : ['memory-tool', 'memory-all-tool', 'channel', 'empty-after-tool'].includes(mode) ? ['wechat_memory'] : [];
    assert.deepEqual((options.tools || []).map(tool => tool.name), expectedTools, 'only current-conversation tools are available; host tools never leak');
    const systems = options.messages.filter(m => m.role === 'system').flatMap(m => m.content).map(b => b.text || '').join('\n');
    assert(systems.includes('微信') || systems.includes('这是内部资料处理任务'));
    assert(!systems.includes('HOST_SECRET_PERSONA'));
    if (mode === 'moments-reply-schedule-tool') {
      const results = options.messages.filter(message => message.role === 'tool').flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => JSON.parse(block.text));
      const latest = results.at(-1); if (latest) assert(latest.ok, JSON.stringify(latest));
      const args = results.length === 0 ? { action: 'list' } : results.length === 1
        ? { action: 'configure', settings: { friendRepliesEnabled: true, maxFriendRepliesPerRun: 3, intervalMinutes: 27 } }
        : results.length === 2 ? { action: 'configure', settings: { friendRepliesEnabled: false } } : null;
      if (results.length === 2) { assert.equal(latest.settings.friendRepliesEnabled, true); assert.equal(latest.settings.enabled, true); }
      if (args) {
        const block = { type: 'tool-call', id: 'native-reply-schedule-' + results.length, name: 'wechat_moments_reply_schedule', arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      assert.equal(latest.settings.enabled, true); assert.equal(latest.settings.friendRepliesEnabled, false);
      assert.equal(latest.settings.maxFriendRepliesPerRun, 3); assert.equal(latest.settings.intervalMinutes, 27);
    }
    if (mode === 'moments-images-tool') {
      if (incomingImages.length) {
        assert.equal(incomingImages.length, 1); const text = '{"images":[{"index":1,"readable":true,"description":"真实附件中的合成图案"}]}';
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      const result = options.messages.filter(message => message.role === 'tool').flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => JSON.parse(block.text)).at(-1);
      if (!result) {
        const block = { type: 'tool-call', id: 'native-moments-images', name: 'wechat_moments_images', arguments: '{"postId":"601"}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      assert(result.ok); assert.equal(result.complete, true); assert.equal(result.images.length, 1); assert.equal(result.images[0].description, '真实附件中的合成图案');
    }
    if (mode === 'moments-interaction-auto-tool') {
      const results = options.messages.filter(message => message.role === 'tool').flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => JSON.parse(block.text));
      const latest = results.at(-1);
      if (latest) assert(latest.ok, JSON.stringify(latest));
      const args = results.length === 0 ? { action: 'list' } : results.length === 1
        ? { action: 'configure_auto', revision: latest.automation.revision, settings: { enabled: true, intervalMinutes: 30, lookbackDays: 2, likeCount: 2, commentCount: 1, skipLiked: true, skipCommented: true } }
        : results.length === 2 ? { action: 'stop_auto' } : results.length === 3 ? { action: 'configure_auto', revision: latest.revision, settings: { enabled: false } } : null;
      if (args) {
        const block = { type: 'tool-call', id: 'native-auto-' + results.length, name: 'wechat_moments_interact', arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      assert.equal(latest.settings.enabled, false); assert.equal(latest.settings.intervalMinutes, 30); assert.equal(latest.settings.likeCount, 2); assert.equal(latest.settings.commentCount, 1);
    }
    if (mode === 'moments-interaction-tool') {
      const result = options.messages.filter(message => message.role === 'tool').flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => JSON.parse(block.text)).at(-1);
      if (!result || result.state === 'draft') {
        const args = result ? { action: 'run', id: result.id, revision: result.revision }
          : { action: 'preview', options: { action: 'both', mode: 'random', count: 2, poolSize: 2, intervalSeconds: 0, commentMode: 'fixed', commentText: '合成原生评论' } };
        if (result) { assert.equal(result.counts.liked, 0); assert.equal(result.counts.commented, 0); }
        const block = { type: 'tool-call', id: 'native-interact-' + args.action, name: 'wechat_moments_interact', arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
        yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      assert(result.ok); assert.equal(result.state, 'completed'); assert.equal(result.counts.liked, 2); assert.equal(result.counts.commented, 2);
    }
    if (mode === 'cancel') {
      await new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
      return;
    }
    if (['image-memory-tool', 'generated-image-memory-tool', 'image-request-tool'].includes(mode)) {
      if (incomingImages.length) {
        assert.equal(incomingImages.length, 1); assert.equal(incomingImages[0].attachment.width, 2400); assert.equal(incomingImages[0].attachment.height, 1600);
        assert.equal(options.tools?.length || 0, 0, 'saved-image vision cannot inherit tools');
        const text = '重新读取原图：画面是合成的黑白网格。';
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      const results = options.messages.filter(message => message.role === 'tool').flatMap(message => message.content || []).filter(block => block.type === 'text').map(block => {
        try { return JSON.parse(block.text); } catch { return null; }
      }).filter(Boolean);
      if (!results.some(result => result.observation)) {
        if (mode === 'image-request-tool') {
          const candidates = JSON.parse(options.tools[0].description.split('图片列表：')[1]); assert.equal(candidates.length, 1);
          const id = 'native-current-image', name = 'wechat_read_image', argumentsText = JSON.stringify({ imageId: candidates[0].imageId, question: '核对画面细节' });
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        const search = results.find(result => result.images?.length);
        const args = search ? { action: 'read', imageId: search.images[0].imageId, question: '核对画面细节' } : { action: 'search', query: '网格' };
        const id = search ? 'native-image-read' : 'native-image-search', name = mode === 'generated-image-memory-tool' ? 'wechat_generated_image_memory' : 'wechat_image_memory', argumentsText = JSON.stringify(args);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      assert(results.some(result => result.ok && typeof result.observation === 'string' && result.observation.includes('黑白网格')));
    }
    if (['moments-like-tool', 'task-tool', 'task-denied', 'search-tool', 'memory-tool', 'memory-all-tool', 'empty-after-tool'].includes(mode) && !options.messages.some(message => message.role === 'tool')) {
      const name = mode === 'moments-like-tool' ? 'wechat_moments_like_recent' : mode === 'search-tool' ? 'wechat_web_search' : mode.startsWith('memory-') || mode === 'empty-after-tool' ? 'wechat_memory' : 'wechat_task';
      const args = name === 'wechat_moments_like_recent' ? { subject: 'speaker' } : name === 'wechat_task' ? { action: 'create', kind: 'message', content: '该喝水啦。', delaySeconds: 300 } : name === 'wechat_memory' ? mode === 'memory-all-tool' ? { section: 'all', query: null, offset: 0, revision: '' } : { section: 'conversation', query: '隔离链路' } : { query: '上海天气' };
      const block = { type: 'tool-call', id: 'native-fixture-tool-call', name, arguments: JSON.stringify(args) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    if (mode === 'memory-all-tool') {
      const results = options.messages.filter(message => message.role === 'tool').flatMap(message => message.content || [])
        .filter(block => block.type === 'text').map(block => JSON.parse(block.text));
      const combined = results.find(result => result.section === 'all');
      assert(combined, 'native provider must receive the combined memory result');
      assert.deepEqual(combined.partitions.map(part => part.section), ['conversation', 'long-term']);
      assert(combined.partitions.every(part => typeof part.text === 'string' && part.revision && part.coverage === 'complete'));
      assert(combined.receiveBounded && combined.allAvailableMemoryReturned);
      assert(combined.partitions[0].text.includes('隔离链路 1'));
      assert(!JSON.stringify(combined).includes('NATIVE_LATER_ONLY'));
      assert(options.tools.some(tool => tool.name === 'wechat_memory'), 'physical coverage must not revoke legitimate follow-up queries');
    }
    if (mode === 'natural-reply' || mode === 'natural-skip') {
      assert(systems.includes('自然陪聊判断')); assert(systems.includes('只输出一个 JSON 对象'));
      const text = '<think>PRIVATE_NATURAL_REASONING</think>' + JSON.stringify(mode === 'natural-reply' ? { action: 'reply', text: '湖边风大，记得把帐篷固定好。' } : { action: 'skip', reason: 'repeated', text: '' });
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (mode === 'style-warning' || mode === 'long-style-warning') {
      const text = mode === 'long-style-warning' ? longCompleteReply : '收到你的问题。双曲线：x²/a² − y²/b² = 1。抛物线：y² = 2px。';
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (mode === 'vision') {
      const images = options.messages.flatMap(message => message.content || []).filter(block => block.type === 'image');
      assert.equal(images.length, 2, 'native DSH must receive actual typed images, not placeholders');
      for (const block of images) assert(block.attachment && !block.data, 'durable admitted image reference');
      assert.equal(images[0].attachment.width, 2400); assert.equal(images[0].attachment.height, 1600);
      const prompt = options.messages.filter(message => message.role === 'user').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert(prompt.includes('第 1 张：已取得原图')); assert(prompt.includes('第 2 张：仅取得微信缩略图'));
      const text = JSON.stringify(['第一张是合成测试图片。', '第二张是合成测试表情包。']);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (mode === 'empty-always' || mode === 'empty-after-tool' || (mode === 'empty-once' && emptyResponses++ === 0)) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: ' ' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: ' ' } };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE_TEST_REASONING' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE_TEST_REASONING' } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text: '<think>HIDDEN</think>DSH 原生回复完成' };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: '<think>HIDDEN</think>DSH 原生回复完成' } };
    yield { type: 'finish', reason: { kind: mode === 'truncate' ? 'max-tokens' : 'stop' } };
  }
}

async function verifyPluginLifecycle(hostContext) {
  const { apply } = require(path.join(repo, 'lib/index.js'));
  const home = path.join(root, 'lifecycle-home'), pluginRoot = path.join(home, 'wechat-agent');
  const seed = new StateStore(pluginRoot), owner = 'lifecycle-owner', group = 'lifecycle@chatroom';
  seed.configure(owner, { enabled: true, privatePeers: [], groups: [group], prompt: '' });
  seed.setConversationSettings(owner, 'group', group, { mode: 'participate', minMessages: 5, maxMessages: 5, recordsPath: '' });
  const incoming = id => ({ id, serverMessageId: id, direction: 'incoming', chatType: 'group', peerId: group,
    sender: { id: 'fixture-member' }, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: id } }] });
  seed.remember('seed-three', Date.now(), undefined, { accountId: owner, message: incoming('seed-three'), progress: { count: 3, target: 5 } });
  // This isolated fixture contains no private material. Skip OS ACL subprocesses
  // so the only child boundary under test is WorkerClient's synthetic IPC.
  fs.writeFileSync(path.join(pluginRoot, 'storage/state/private-acl-v1.json'), JSON.stringify({ protectedPaths: ['storage'] }));
  const previousHome = process.env.DSH_HOME, originalSpawn = childProcess.spawn;
  let child, dispose, rpc, closeCalls = 0;
  const snapshot = online => ({ online, state: online ? 'online' : 'starting', account: { id: owner }, login: { state: 'idle' }, runtimeReady: true });
  const publish = online => child.emit('message', { type: 'status', status: snapshot(online) });
  const status = async () => {
    const result = await rpc('status', {}, undefined, { principal: { kind: 'owner' } });
    assert.equal(result.ok, true); assert.equal(result.value.startupError, undefined); return result.value;
  };
  const progress = async () => (await status()).conversations.find(value => value.peerId === group).progress;
  childProcess.spawn = (_executable, args) => {
    assert.equal(args[0], path.join(repo, 'lib/worker.cjs'));
    assert.equal(args[1], pluginRoot);
    child = new EventEmitter();
    Object.assign(child, { pid: process.pid, connected: true, exitCode: null, signalCode: null });
    child.send = (request, callback) => {
      callback?.();
      assert.equal(request.op, 'close', 'lifecycle fixture must never start a real connection or send');
      queueMicrotask(() => {
        closeCalls++; publish(false);
        child.emit('message', { type: 'result', id: request.id, ok: true, value: null });
        child.connected = false; child.exitCode = 0; child.emit('close', 0, null);
      });
    };
    child.kill = () => { throw new Error('graceful synthetic worker should not require kill'); };
    queueMicrotask(() => child.emit('message', { type: 'ready', status: snapshot(false) }));
    return child;
  };
  syncBuiltinESMExports(); process.env.DSH_HOME = home;
  const start = async () => {
    dispose = undefined; rpc = undefined;
    await apply({ agentDefaultModel: hostContext.agentDefaultModel, sessionPersistence: hostContext.sessionPersistence,
      effect: factory => { dispose = factory(); },
      connection: { register: (_owner, channel, handler) => { assert.equal(channel, '/wechat-agent'); rpc = handler; } },
    });
    assert.equal(typeof dispose, 'function'); assert.equal(typeof rpc, 'function'); await status();
  };
  try {
    await start(); publish(false);
    assert.deepEqual(await progress(), { count: 3, target: 5 }, 'initial offline snapshots must preserve a restored threshold');
    publish(true);
    child.emit('message', { type: 'message', accountId: owner, message: incoming('after-restart-fourth') });
    assert.deepEqual(await progress(), { count: 4, target: 5 });
    await dispose(); dispose = undefined;
    assert.deepEqual(new StateStore(pluginRoot).progress(owner, 'group', group), { count: 4, target: 5 }, 'worker offline and child-close events during disposal must not reset progress');
    assert(!fs.existsSync(path.join(pluginRoot, 'owner.lock')));
    await start(); publish(false);
    assert.deepEqual(await progress(), { count: 4, target: 5 });
    publish(true); publish(false);
    assert.deepEqual(await progress(), { count: 0, target: null }, 'a real online-to-offline transition while running must reset progress');
    await dispose(); dispose = undefined;
    assert.equal(closeCalls, 2);
  } finally {
    try { await dispose?.(); }
    finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); process.env.DSH_HOME = previousHome; }
  }
}

(async () => {
  const forks = [];
  const mount = async (name, config = {}) => {
    const module = hostRequire(`@deepseek-ai/${name}`);
    const fork = ctx.plugin(module.default || module, config); forks.push(fork); await fork.await();
    return fork;
  };
  await mount('dsh-session');
  await mount('dsh-session-projection');
  await mount('dsh-agent');
  await mount('dsh-llm');
  await mount('dsh-attachment-local', { dshHome: process.env.DSH_HOME });
  await mount('dsh-system-prompt', { personaPrefix: 'HOST_SECRET_PERSONA' });
  await mount('dsh-fs-local');
  await mount('dsh-working-directory', { defaultDirectory: root });
  await mount('dsh-tools', { mode: 'native' });
  const hostTool = ctx.tools.register({ name: 'host_fixture_forbidden', description: 'Must never be inherited by a WeChat agent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => { throw new Error('Inherited host tool executed'); } });
  await mount('dsh-agent-default-model', { provider: 'wechat-test-fixture', model: 'fixture', reasoningEffort: 'high' });
  await mount('dsh-session-persistence-jsonl', { root: path.join(root, 'sessions') });
  await mount('dsh-agent-loop', { agents: [] });
  const pathObserver = ctx.plugin({ name: 'wechat-test-session-path', inject: ['sessionPersistence'], apply(scoped) {
    assert.equal(scoped.sessionPersistence.name, 'session-persistence-jsonl');
    assert.equal(scoped.sessionPersistence.root, path.join(root, 'sessions'));
    assert.notEqual(scoped.sessionPersistence.root, path.join(process.env.DSH_HOME, 'sessions'));
  } });
  forks.push(pathObserver); await pathObserver.await();
  // A Host default must remain effective when the plugin selects "default".
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: 0.65 }));
  const providers = ['wechat-test-fixture', 'wechat-test-alternate'];
  const registration = ctx.llm.registerAdapter(providers, new FixtureAdapter());
  const catalog = await buildModelCatalog(ctx);
  assert.deepEqual(catalog.groups.map(group => group.id), providers); assert.equal(catalog.failures.length, 0);
  assert(catalog.groups.every(group => group.models.some(model => model.id === 'alternate')));
  const store = new StateStore(path.join(root, 'channel'));
  const workspace = path.join(root, 'workspace'), alternateWorkspace = path.join(root, 'workspace-next');
  fs.mkdirSync(workspace); fs.mkdirSync(alternateWorkspace);
  const { personaFromPreset } = await import("../prompts/personas/catalog.mjs");
  const { personaDraft } = await import("../frontend/shared/drafts.mjs");
  const preset = personaFromPreset();
  const savedPersona = { ...personaDraft({ ...preset, name: '小胖', aliases: ['胖胖'],
    background: '测试音乐助手背景', personality: '温和且有分寸', style: '短句接话\n\n' + preset.style }), aliases: ['胖胖'] };
  assert.equal(typeof savedPersona.prompt, 'string');
  const runtime = { persona: savedPersona,
    modelConfig: { maxTokens: 1536, temperature: 0.25 }, workspacePath: workspace };
  store.setPersona(savedPersona);
  const identity = new AgentIdentity(path.join(root, 'identity'));
  identity.edit('# 微信全局身份\nNATIVE_GLOBAL_FIRST：自然接话。', identity.view().revision);
  const runner = new DshAgentRunner(ctx, () => store.modelChoice(), () => ({ ...runtime, persona: store.persona(), identityMarkdown: identity.view().markdown })), controller = new AbortController();
  const first = await runner.run({ text: '第一问', group: true, mode: 'participate', prompt: '回答简洁', signal: controller.signal,
    onSession: id => {
      assert.equal(ctx.sessions.get(id).header.cwd, workspace);
      assert.equal(ctx.workingDirectory.get(ctx.sessions.get(id)), workspace, 'prompt suppression must not change the effective workspace');
    } });
  assert.equal(first.text, 'DSH 原生回复完成');
  assert.equal(requests[0].provider, 'wechat-test-fixture'); assert.equal(requests[0].model, 'fixture'); assert.equal(requests[0].reasoningEffort, 'high');
  assert.equal(requests[0].temperature, 0.25); assert.equal(requests[0].maxTokens, 1536);
  const firstSystem = requests[0].messages.filter(m => m.role === 'system').flatMap(m => m.content).map(b => b.text || '').join('\n');
  assert(!requests[0].messages.some(message => JSON.stringify(message.content).includes('Current working directory:')), 'WeChat model input must omit the unrelated host working-directory notice');
  assert(firstSystem.includes('NATIVE_GLOBAL_FIRST'));
  assert(firstSystem.includes(fs.readFileSync(path.join(repo, 'prompts/reply/language.md'), 'utf8')));
  for (const value of ['小胖', '胖胖', '测试音乐助手背景', '温和且有分寸', '短句接话', '回答简洁', '本轮主动接群内当前话题']) assert(firstSystem.includes(value), value);
  for (const name of ['角色背景', '性格与互动', '表达方式', '角色语气示例'])
    assert(firstSystem.includes(`【${name}】\n遵守原则：`), 'The native request must scope actual editor-saved fields: ' + name);
  const persisted = await ctx.sessionPersistence.open(first.sessionId, 'read');
  try {
    assert.equal(persisted.header.cwd, workspace);
    const artifact = ctx.sessionPersistence.locate(persisted.header).path;
    const relative = path.relative(path.join(root, 'sessions'), artifact);
    assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'workspace is metadata; the Host owns the session persistence root');
  } finally { await persisted.close(); }
  const unrelated = await ctx.agents.create({ sessionId: 'unrelated-workspace-check',
    agentOptions: { provider: 'wechat-test-fixture', model: 'fixture' }, signal: controller.signal, meta: { cwd: alternateWorkspace } });
  try {
    const assembly = await ctx.systemPrompt.assemble({ agent: unrelated.agent, scope: unrelated.agent.ctx, signal: controller.signal });
    assert(assembly.contexts.some(entry => entry.name === 'working-directory:current' && entry.text.includes('Current working directory:')),
      'an unrelated host agent retains the required workspace context');
    assert.equal(ctx.workingDirectory.get(unrelated.agent.session), alternateWorkspace);
  } finally { await unrelated.dispose(); }
  await selectModel(ctx, store, { provider: 'wechat-test-alternate', model: 'alternate' });
  assert.deepEqual(new StateStore(path.join(root, 'channel')).modelChoice(), { provider: 'wechat-test-alternate', model: 'alternate' });
  runtime.persona.name = '阿胖'; runtime.modelConfig = { maxTokens: 768, temperature: null }; runtime.workspacePath = alternateWorkspace;
  store.setPersona(runtime.persona);
  identity.edit('# 微信全局身份\nNATIVE_GLOBAL_SECOND：结合当前会话。', identity.view().revision);
  const second = await runner.run({ text: '第二问', group: true, sessionId: first.sessionId, signal: controller.signal,
    persona: store.conversationPersona('fake-owner', 'group', 'native-room@chatroom'),
    history: [{ direction: 'incoming', senderId: 'member', text: 'SELECTED_RECENT_CORRECTION' }],
    memory: 'SELECTED_MEMORY_FACT',
    onSession: id => {
      const session = ctx.sessions.get(id);
      assert.equal(session.header.cwd, workspace);
      const saved = JSON.stringify(session.snapshotEvents(0));
      assert(saved.includes('第一问') && saved.includes('PRIVATE_TEST_REASONING'), 'context isolation must not delete the native audit log');
    } });
  assert.equal(second.sessionId, first.sessionId);
  assert.deepEqual(requests[1].messages.map(message => message.role), ['system', 'user']);
  const secondInput = JSON.stringify(requests[1].messages);
  for (const value of ['第二问', 'SELECTED_RECENT_CORRECTION', 'SELECTED_MEMORY_FACT']) assert(secondInput.includes(value));
  for (const value of ['第一问', 'PRIVATE_TEST_REASONING', 'DSH 原生回复完成']) assert(!secondInput.includes(value), 'old native dialogue must not bypass the selected WeChat context');
  assert.equal(requests[1].provider, 'wechat-test-alternate'); assert.equal(requests[1].model, 'alternate'); assert.equal(requests[1].reasoningEffort, 'low');
  assert.equal(requests[1].temperature, 0.65, 'null temperature must preserve the Host default');
  assert.equal(requests[1].maxTokens, 768);
  const secondSystem = requests[1].messages.filter(m => m.role === 'system').flatMap(m => m.content).map(b => b.text || '').join('\n');
  assert(secondSystem.includes('NATIVE_GLOBAL_SECOND')); assert(!secondSystem.includes('NATIVE_GLOBAL_FIRST'));
  assert(secondSystem.includes('配置名字："阿胖"')); assert(!secondSystem.includes('NATIVE_ROOM_PERSONA'));
  assert(secondSystem.includes('测试音乐助手背景'));
  assert(secondSystem.includes(fs.readFileSync(path.join(repo, 'prompts/reply/language.md'), 'utf8')));
  registration.replace(['wechat-test-fixture']);
  assert.equal((await buildModelCatalog(ctx)).groups.length, 1);
  await assert.rejects(runner.run({ text: '所选服务已停用', group: false, signal: controller.signal }), error => error.code === 'MODEL_UNAVAILABLE');
  assert.equal(requests.length, 2);
  await selectModel(ctx, store, null);
  await runner.run({ text: '恢复跟随默认', group: true, sessionId: first.sessionId, signal: controller.signal });
  assert.equal(requests[2].provider, 'wechat-test-fixture'); assert.equal(requests[2].model, 'fixture'); assert.equal(requests[2].reasoningEffort, 'high');
  const restoredSystem = requests[2].messages.filter(message => message.role === 'system').flatMap(message => message.content).map(block => block.text || '').join('\n');
  for (const name of ['角色背景', '性格与互动', '表达方式', '角色语气示例']) assert(restoredSystem.includes(`【${name}】\n遵守原则：`));
  assert(restoredSystem.includes('配置名字："阿胖"') && !restoredSystem.includes('NATIVE_ROOM_PERSONA'));
  runtime.modelConfig.maxTokens = null;
  await runner.run({ text: '自动使用当前模型输出额度', sessionId: first.sessionId, signal: controller.signal });
  assert.equal(requests.at(-1).maxTokens, 256000, 'automatic output must reach the native adapter with its model allowance');
  await selectModel(ctx, store, { provider: 'wechat-test-fixture', model: 'alternate' });
  await runner.run({ text: '切换模型后跟随新额度', sessionId: first.sessionId, signal: controller.signal });
  assert.equal(requests.at(-1).maxTokens, 131072);
  runtime.modelConfig.maxTokens = 65536;
  await runner.run({ text: '手动设置大于旧上限的额度', sessionId: first.sessionId, signal: controller.signal });
  assert.equal(requests.at(-1).maxTokens, 65536);
  runtime.modelConfig.maxTokens = null;
  await selectModel(ctx, store, null);
  mode = 'style-warning'; const styleRequestCount = requests.length;
  const reviewed = await runner.run({ text: '小胖你把双曲线和抛物线的都写出来', signal: controller.signal });
  assert.equal(reviewed.text, '收到你的问题。双曲线：x²/a² − y²/b² = 1。抛物线：y² = 2px。');
  assert.equal(reviewed.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE); assert.equal(requests.length, styleRequestCount + 1);
  mode = 'long-style-warning'; const longRequestCount = requests.length;
  const longReviewed = await runner.run({ text: '请完整写出所需数学内容', signal: controller.signal });
  assert(longReviewed.text.length > 12000); assert.equal(longReviewed.text, longCompleteReply);
  assert.equal(longReviewed.replyStyleWarning, REPLY_STYLE_REVIEW_NOTE); assert.equal(requests.length, longRequestCount + 1);
  mode = 'truncate';
  await assert.rejects(runner.run({ text: '截断测试', group: false, signal: controller.signal,
    onSession: id => assert.equal(ctx.sessions.get(id).header.cwd, alternateWorkspace) }), error => error.code === 'MODEL_INCOMPLETE');
  mode = 'cancel'; const cancelling = new AbortController();
  const pending = runner.run({ text: '取消测试', group: false, signal: cancelling.signal });
  const timeout = setTimeout(() => cancelling.abort(new ChannelError('CANCELLED', 'test cancellation')), 100);
  await assert.rejects(pending); clearTimeout(timeout);
  mode = 'complete';
  store.configure('fake-owner', { enabled: true, privatePeers: ['fake-friend'], groups: [], prompt: '' });
  const sent = [];
  const transport = { status: () => ({ online: true, account: { id: 'fake-owner' } }), send: async params => { sent.push(params); return { delivery: 'server-ack', serverMessageIds: [`mock-ack-${sent.length}`] }; } };
  const channel = new WechatChannel({ store, runner, transport });
  assert(!Object.hasOwn(channel.workbench, 'knowledge'), 'retired document retrieval is not constructed');
  assert(typeof channel.workbench.answerKnowledge === 'undefined', 'retired document answering is not exposed');
  mode = 'channel';
  const incoming = n => ({ id: `mock-${n}`, serverMessageId: String(n), direction: 'incoming', chatType: 'private', peerId: 'fake-friend', sender: { id: 'fake-friend' }, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: `隔离链路 ${n}` } }] });
  channel.receive(incoming(1), 'fake-owner'); channel.receive(incoming(2), 'fake-owner'); await channel.whenIdle();
  assert.equal(sent.length, 2); assert(store.data.records.every(r => r.state === 'sent'));
  await channel.close();
  const reloaded = new WechatChannel({ store: new StateStore(path.join(root, 'channel')), runner, transport });
  reloaded.receive(incoming(1), 'fake-owner'); await reloaded.whenIdle(); await reloaded.close(); assert.equal(sent.length, 2);
  const scheduler = new TaskScheduler({ store, channel });
  const scope = { accountId: 'fake-owner', chatType: 'private', peerId: 'fake-friend', source: 'chat', senderId: 'fake-friend', senderName: '测试朋友', requestKey: 'native-tool-message', requestedAt: Date.now() };
  mode = 'task-tool';
  await runner.run({ text: '五分钟后提醒我喝水', signal: controller.signal, tools: [conversationTaskTool(scheduler, scope, () => {}, '五分钟后提醒我喝水')] });
  assert.equal(scheduler.list('fake-owner').tasks.length, 1, 'real native tool execution persists exactly one scoped task');
  assert.equal(scheduler.list('fake-owner').tasks[0].peerId, 'fake-friend');
  assert(requests.at(-1).messages.filter(message => message.role === 'tool').some(message => JSON.stringify(message).includes('persisted')));
  mode = 'task-denied';
  await runner.run({ text: '请翻译“五分钟后提醒我喝水”', signal: controller.signal, tools: [conversationTaskTool(scheduler, { ...scope, requestKey: 'quoted-example' }, () => {}, '请翻译“五分钟后提醒我喝水”')] });
  assert.equal(scheduler.list('fake-owner').tasks.length, 1, 'model tool calls cannot turn quoted examples into schedules');
  mode = 'moments-like-tool';
  const likeStore = new StateStore(path.join(root, 'moments-likes')), likeReads = [], likeWrites = [];
  likeStore.configure('fake-owner', { enabled: true, privatePeers: ['fake-friend'], groups: [], prompt: '' });
  let uncertainLike = false;
  const likeChannel = new WechatChannel({ store: likeStore, runner, transport: {
    status: () => ({ online: true, account: { id: 'fake-owner' }, momentsReadReady: true, momentsWriteReady: true }),
    readMoments: async request => { likeReads.push(request); return { accountId: 'fake-owner', action: 'user', items: [
      { id: '301', author: { userId: 'fake-friend', nickname: '合成好友' }, createdAt: 1700000301, text: '原生工具隔离测试', likedByCurrentAccount: false, deleted: false },
    ], nextCursor: null }; },
    writeMoments: async request => { likeWrites.push(request); if (uncertainLike) throw new ChannelError('MOMENTS_RESULT_UNKNOWN', '合成回执未知');
      return { accountId: 'fake-owner', action: 'like', postId: request.query.postId, liked: true, delivery: 'server-ack' }; },
  } });
  try {
    const tool = requestId => momentsLikeRequestTool({ like: (args, signal) => likeChannel.moments.likeRecent(args, scope, requestId, '帮我朋友圈点个赞', signal) });
    const nativeResult = () => requests.at(-1).messages.filter(message => message.role === 'tool').flatMap(message => message.content || [])
      .filter(block => block.type === 'text').map(block => JSON.parse(block.text)).find(value => value.requestedCount === 1);
    await runner.run({ text: '帮我朋友圈点个赞', signal: controller.signal, tools: [tool('native-like-request')] });
    assert.equal(likeReads[0].query.userId, 'fake-friend'); assert.equal(likeWrites[0].query.postId, '301');
    assert.equal(nativeResult().liked, 1); assert.equal(nativeResult().results[0].delivery, 'server-ack');
    await runner.run({ text: '帮我朋友圈点个赞', signal: controller.signal, tools: [tool('native-like-request')] });
    assert.equal(nativeResult().reusedRequest, true); assert.equal(likeReads.length, 1); assert.equal(likeWrites.length, 1);
    uncertainLike = true;
    await runner.run({ text: '帮我朋友圈点个赞', signal: controller.signal, tools: [tool('native-like-unknown')] });
    assert.equal(nativeResult().ok, false); assert.equal(nativeResult().liked, 0); assert.equal(nativeResult().results[0].state, 'unknown');
    assert.equal(likeWrites.length, 2);
  } finally { await likeChannel.close(); }
  mode = 'moments-interaction-tool';
  const interactionStore = new StateStore(path.join(root, 'moments-interactions')), interactionWrites = [];
  interactionStore.configure('fake-owner', { enabled: true, privatePeers: ['fake-friend'], groups: [], prompt: '' });
  interactionStore.setConversationSettings('fake-owner', 'private', 'fake-friend', { ...interactionStore.conversationSettings('fake-owner', 'private', 'fake-friend'), remoteEnabled: true, adminIds: ['fake-friend'] });
  const interactionPosts = ['601', '602'].map((id, index) => ({ id, author: { userId: 'synthetic-friend-' + index, nickname: '合成好友 ' + index },
    text: '合成真实读取来源 ' + index, createdAt: Math.floor(Date.now() / 1000) - index, imageCount: 0, deleted: false, contentAvailable: true, likedByCurrentAccount: false, visibleCommentEntries: 0, comments: [] }));
  const interactionChannel = new WechatChannel({ store: interactionStore, runner, transport: {
    status: () => ({ online: true, account: { id: 'fake-owner' }, momentsReadReady: true, momentsWriteReady: true }),
    readMoments: async request => ({ accountId: 'fake-owner', action: request.query.action, source: 'wechat-sns-live', nextCursor: null,
      items: structuredClone(request.query.action === 'detail' ? interactionPosts.filter(post => post.id === request.query.postId) : interactionPosts) }),
    writeMoments: async request => { interactionWrites.push(request); return { accountId: 'fake-owner', action: request.query.action, postId: request.query.postId,
      ...(request.query.action === 'like' ? { liked: true } : { text: request.query.text, commentId: String(900 + interactionWrites.length) }), delivery: 'server-ack' }; },
  } });
  try {
    const tool = momentsInteractionTool({ manage: (args, signal) => interactionChannel.moments.manageInteractions(args, scope, 'native-interaction-request', signal) });
    await runner.run({ text: '给朋友圈随机点赞评论两条，评论写合成原生评论', signal: controller.signal, tools: [tool] });
    assert.equal(interactionWrites.length, 4);
    await runner.run({ text: '核对同一轮朋友圈互动', signal: controller.signal, tools: [tool] });
    assert.equal(interactionWrites.length, 4, 'native repeats must return the same finished round');
    mode = 'moments-interaction-auto-tool';
    await runner.run({ text: '合成测试：设置每30分钟检查最近2天，点赞2条评论1条，跳过已赞已评，然后停止本轮并关闭自动互动', signal: controller.signal, tools: [tool] });
    const automatic = interactionChannel.momentsAutomation.interactions.automation.list('fake-owner');
    assert.equal(automatic.settings.enabled, false); assert.equal(automatic.nextRunAt, 0); assert.equal(automatic.settings.intervalMinutes, 30);
    assert.equal(automatic.settings.commentCount, 1); assert.equal(interactionWrites.length, 4, 'configuring a future schedule never sends an immediate interaction');
    mode = 'moments-reply-schedule-tool';
    interactionChannel.momentsAutomation.configure('fake-owner', { enabled: true, intervalMinutes: 17 });
    const replyTool = momentsPublishingTools({ manage: (args, signal) => interactionChannel.moments.managePublishing(args, scope, 'native-reply-schedule-request', signal) })
      .find(tool => tool.name === 'wechat_moments_reply_schedule');
    await runner.run({ text: '合成测试：查询定时回复，开启好友朋友圈接续回复，每27分钟最多3条，然后只关闭好友接续，保留自己的回复设置', signal: controller.signal, tools: [replyTool] });
    const replySettings = interactionChannel.momentsAutomation.rule('fake-owner').settings;
    assert.equal(replySettings.friendRepliesEnabled, false); assert.equal(replySettings.enabled, true);
    assert.equal(replySettings.maxFriendRepliesPerRun, 3); assert.equal(replySettings.intervalMinutes, 27); assert.equal(interactionWrites.length, 4);
    interactionChannel.momentsAutomation.configure('fake-owner', { enabled: false });
    mode = 'moments-images-tool';
    const imageBytes = fs.readFileSync(path.join(repo, 'assets/stickers', fs.readdirSync(path.join(repo, 'assets/stickers'), { recursive: true }).find(file => file.endsWith('.png'))));
    const imagePost = { ...interactionPosts[0], imageCount: 1, media: [{ id: 'native-photo', type: 'image' }] }; let imageReads = 0;
    interactionChannel.transport.readMomentsImages = async request => {
      imageReads++; assert.equal(request.query.postId, imagePost.id);
      return { accountId: 'fake-owner', postId: imagePost.id, post: imagePost, source: 'wechat-sns-images-live', complete: true, imageCount: 1,
        items: [{ index: 1, mediaId: 'native-photo', data: imageBytes.toString('base64'), bytes: imageBytes.length, mediaType: 'image/png', sha256: require('node:crypto').createHash('sha256').update(imageBytes).digest('hex') }] };
    };
    const imageTool = momentsImagesTool({ readImages: (args, signal) => interactionChannel.moments.readImages(args, scope, signal) });
    await runner.run({ text: '读取这条朋友圈图片，补充评论信息', signal: controller.signal, tools: [imageTool] });
    assert.equal(imageReads, 1); assert.equal(interactionWrites.length, 4, 'reading images cannot send a social write');
  } finally { await interactionChannel.close(); }
  mode = 'search-tool'; const searches = [];
  await runner.run({ text: '上海天气怎么样', sessionId: first.sessionId, signal: controller.signal, tools: [webSearchTool(() => ({ search: async request => { searches.push(request); return { content: '合成测试天气', sources: [{ title: '测试来源', url: 'https://example.com/weather' }] }; } }))] });
  assert.deepEqual(requests.at(-1).messages.map(message => message.role), ['system', 'user', 'assistant', 'tool'], 'a resumed tool turn must retain its own call/result without old turns');
  assert(!JSON.stringify(requests.at(-1).messages).includes('第一问'));
  assert.deepEqual(searches, [{ query: '上海天气', maxResults: 5 }]);
  mode = 'memory-tool';
  const snapshot = channel.memory.snapshot(scope);
  channel.memory.append(scope, { key: 'native-later-memory', time: Math.floor(Date.now() / 1000), direction: 'incoming',
    senderId: 'fake-friend', senderName: '测试朋友', text: '隔离链路 NATIVE_LATER_ONLY' });
  await runner.run({ text: '查询之前的隔离链路记录', signal: controller.signal,
    tools: [conversationMemoryTool(channel.memory, channel.longMemory, scope, () => {}, { snapshot })] });
  const memoryResults = requests.at(-1).messages.filter(message => message.role === 'tool').map(message => JSON.stringify(message)).join('\n');
  assert(memoryResults.includes('隔离链路 1')); assert(memoryResults.includes('隔离链路 2'));
  assert(!memoryResults.includes('NATIVE_LATER_ONLY'), 'native tool results cannot acquire later room context');
  mode = 'memory-all-tool';
  const combinedTool = conversationMemoryTool(channel.memory, channel.longMemory, { ...scope, requestedAt: Date.now() }, () => {}, { snapshot });
  const combinedBefore = requests.length;
  await runner.run({ text: '核对之前的隔离链路记录及长期记忆', signal: controller.signal, tools: [combinedTool] });
  assert.equal(requests.length - combinedBefore, 2, 'one combined lookup and one final reply use two native requests');
  assert.equal(combinedTool.getReadState().allAvailableMemoryReturned, true);
  mode = 'vision';
  const sharp = createRequire(hostRequire.resolve('@deepseek-ai/dsh-attachment-local'))('sharp');
  const pixels = Buffer.alloc(2400 * 1600 * 3);
  for (let y = 0; y < 1600; y++) for (let x = 0; x < 2400; x++) pixels.fill((x % 17 === 0 || y % 17 === 0) ? 0 : 240, (y * 2400 + x) * 3, (y * 2400 + x) * 3 + 3);
  const highResolution = await sharp(pixels, { raw: { width: 2400, height: 1600, channels: 3 } }).png().toBuffer();
  const original = { mediaType: 'image/png', data: highResolution.toString('base64'), quality: 'original' };
  const png = { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC', quality: 'thumbnail' };
  assert.deepEqual(await runner.describeImages([original, png], controller.signal), ['第一张是合成测试图片。', '第二张是合成测试表情包。']);
  channel.imageMemory.thumbnailMaker = data => sharp(data).resize({ width: 384, height: 384, fit: 'inside' }).png().toBuffer();
  const savedSource = { key: 'native-saved-image', messageId: 'native-saved-image', direction: 'incoming', time: Date.now(), senderId: 'fake-friend', senderName: '测试朋友', text: '[合成图片]',
    attachments: [{ type: 'image', resourceId: 'native-grid', description: '合成黑白网格图片。' }] };
  const saved = await channel.imageMemory.capture(scope, savedSource, savedSource.attachments[0], original, controller.signal);
  assert(saved.hasThumbnail); assert.equal(channel.imageMemory.content(scope, saved.id).data, original.data);
  mode = 'image-memory-tool'; const imageRequestsBefore = requests.length;
  await runner.run({ text: '查看之前保存的网格图片', signal: controller.signal, tools: [imageMemoryTool(channel.imageMemory, runner, scope, () => {})] });
  const imageRequests = requests.slice(imageRequestsBefore);
  assert(imageRequests.some(request => request.messages.some(message => message.content?.some(block => block.type === 'image'))));
  assert(requests.at(-1).messages.filter(message => message.role === 'tool').some(message => JSON.stringify(message).includes('重新读取原图')));
  const generatedScope = { ...scope, collection: 'generated', senderId: 'fake-friend' },
    generatedSource = { ...savedSource, messageId: 'native-generated-grid', direction: 'outgoing', senderId: scope.accountId, text: '请求生成网格' },
    generatedAttachment = { type: 'image', resourceId: 'native-generated-grid', generation: {
      jobId: 'abcdef012345', fileName: 'grid.png', requesterId: 'fake-friend', deliveryState: 'sent', serverMessageIds: ['9007199254740999'], prompt: '生成网格' } };
  const generated = await channel.imageMemory.capture(generatedScope, generatedSource, generatedAttachment, original, controller.signal);
  assert.equal(channel.imageMemory.content(generatedScope, generated.id).data, original.data);
  const quoteKey = 'native-generated-image-quote', quoteTime = Date.now(), quoteMessage = {
    id: quoteKey, time: quoteTime, chatType: scope.chatType, peerId: scope.peerId, sender: { id: scope.senderId },
    message: [{ type: 'text', data: { text: '引用这张生成图，实际是什么样？' } },
      { type: 'reply', data: { id: `wx:${scope.peerId}:9007199254740999`, messageType: 3, senderId: scope.accountId, senderName: 'Agent' } }],
  };
  store.remember(quoteKey, quoteTime, { ...scope, key: quoteKey, createdAt: quoteTime, state: 'skipped', question: '引用这张生成图，实际是什么样？' }, { accountId: scope.accountId, message: quoteMessage });
  const quoted = await resolveMessageReferences(channel, scope,
    store.history(scope.accountId, scope.chatType, scope.peerId).find(entry => entry.key === quoteKey), controller.signal);
  assert.equal(quoted[0].images[0].id, generated.id);
  mode = 'generated-image-memory-tool'; const generatedBefore = requests.length;
  await runner.run({ text: '你刚才生成的网格是什么样？微信引用显示版本不支持，没有图片。\n\n' + referenceText(quoted), signal: controller.signal,
    tools: [imageMemoryTool(channel.imageMemory, runner, generatedScope, () => {})] });
  const generatedRequests = requests.slice(generatedBefore);
  assert.equal(generatedRequests.length, 4, 'native search, read, isolated vision and final reply');
  assert.equal(generatedRequests.filter(request => request.messages.some(message => message.content?.some(block => block.type === 'image'))).length, 1);
  assert(generatedRequests.at(-1).messages.filter(message => message.role === 'tool').some(message => JSON.stringify(message).includes('重新读取原图')));
  assert(JSON.stringify(generatedRequests[0].messages).includes(`image-memory://generated/${generated.id}`));
  assert(store.history(scope.accountId, scope.chatType, scope.peerId).find(entry => entry.key === quoteKey).text.includes('重新读取原图'));
  assert(channel.memory.view(scope).text.includes('重新读取原图'));
  assert.equal(channel.imageMemory.list(scope).storedCount, 1, 'native generated memory must not overwrite received memory');
  channel.memory.append(scope, savedSource);
  const requestTransport = { media: async input => { assert.equal(input.resourceId, 'native-grid'); return original; } };
  const beforeArchiveOnly = requests.length;
  await channel.memory.enrich(scope, runner, requestTransport, controller.signal); assert.equal(requests.length, beforeArchiveOnly);
  mode = 'image-request-tool'; const currentBefore = requests.length;
  await runner.run({ text: '看当前图片中的网格', signal: controller.signal, tools: [conversationImageTool(channel.memory, runner, requestTransport, scope, () => {}, { snapshot: channel.memory.load(scope), currentKey: savedSource.key })] });
  assert.equal(requests.length - currentBefore, 3, 'chat selects one photo, isolated vision reads it, then chat finishes');
  assert.equal(requests.slice(currentBefore).filter(request => request.messages.some(message => message.content?.some(block => block.type === 'image'))).length, 1);
  assert(channel.memory.view(scope).text.includes('重新读取原图'));
  assert.throws(() => completedText([{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'ACCOUNT_QUOTA', message: 'private provider detail' } } } }]), error => error.message.includes('余额或额度不足') && !error.message.includes('private provider'));
  mode = 'complete'; await scheduler.close();
  const naturalStore = new StateStore(path.join(root, 'natural-chat')), naturalRoom = 'native-natural@chatroom';
  naturalStore.configure('fake-owner', { enabled: true, privatePeers: [], groups: [naturalRoom], prompt: '' });
  naturalStore.setConversationSettings('fake-owner', 'group', naturalRoom, { mode: 'natural', intervalMode: 'fixed', fixedMessages: 100, minMessages: 100, maxMessages: 100, recordsPath: '',
    natural: { ...emptyNaturalSettings(), activeHours: false, intervalMode: 'fixed', fixedMinutes: 1, minGapMinutes: 1, followupSeconds: 0 } });
  let naturalNow = Date.now(); const naturalSent = [], nativeNaturalBefore = requests.length;
  const naturalTransport = { status: () => ({ online: true, account: { id: 'fake-owner' } }), send: async params => { naturalSent.push(params); return { delivery: 'server-ack', serverMessageIds: ['native-natural-ack'] }; } };
  const naturalChannel = new WechatChannel({ store: naturalStore, runner, transport: naturalTransport, now: () => naturalNow, random: () => 0 });
  const searchBeforeNatural = runtime.modelConfig.webSearch; runtime.modelConfig.webSearch = true;
  try {
    naturalChannel.natural.tick(); mode = 'natural-reply'; naturalNow += 60000; naturalChannel.natural.tick(); await naturalChannel.whenIdle();
    assert.equal(requests.length, nativeNaturalBefore + 1, 'native natural decision and reply use one model request');
    assert.deepEqual(naturalSent[0].message, [{ type: 'text', data: { text: '湖边风大，记得把帐篷固定好。' } }]);
    assert.equal(naturalStore.naturalState('fake-owner', 'group', naturalRoom).unanswered, 1);
    mode = 'natural-skip'; naturalNow += 120000; naturalChannel.natural.tick(); await naturalChannel.whenIdle();
    assert.equal(requests.length, nativeNaturalBefore + 2); assert.equal(naturalSent.length, 1);
    assert.equal(naturalStore.data.records.at(-1).state, 'skipped'); assert.equal(naturalStore.data.records.at(-1).naturalReason, 'repeated');
    assert.equal(naturalStore.naturalState('fake-owner', 'group', naturalRoom).unanswered, 1);
  } finally {
    if (searchBeforeNatural === undefined) delete runtime.modelConfig.webSearch; else runtime.modelConfig.webSearch = searchBeforeNatural;
    mode = 'complete'; await naturalChannel.close();
  }
  const reasoningStore = new StateStore(path.join(root, 'reasoning-choice'));
  const reasoningRunner = new DshAgentRunner(ctx, () => reasoningStore.modelChoice(), () => runtime);
  const reasoningBefore = requests.length;
  assert((await ctx.llm.listModels('wechat-test-fixture')).every(model => !model.reasoning), 'native list intentionally omits reasoning metadata');
  const nativeModelInfo = await readModelInfo(ctx, { provider: 'wechat-test-fixture', model: 'alternate' }, controller.signal);
  assert.deepEqual(nativeModelInfo, { provider: 'wechat-test-fixture', model: 'alternate',
    reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], defaultEffort: 'low' } });
  assert.equal(requests.length, reasoningBefore, 'capability discovery must never generate a model response');
  await assert.rejects(selectModel(ctx, reasoningStore, { provider: 'wechat-test-fixture', model: 'alternate', reasoningEffort: 'unsupported' }),
    error => error.code === 'MODEL_REASONING_UNSUPPORTED');
  assert.equal(requests.length, reasoningBefore, 'unsupported reasoning is rejected before generation');
  await selectModel(ctx, reasoningStore, { provider: 'wechat-test-fixture', model: 'alternate', reasoningEffort: 'high' });
  assert.deepEqual(new StateStore(path.join(root, 'reasoning-choice')).modelChoice(),
    { provider: 'wechat-test-fixture', model: 'alternate', reasoningEffort: 'high' });
  const reasoningFirst = await reasoningRunner.run({ text: '合成推理选项检查', signal: controller.signal });
  assert.equal(requests.at(-1).reasoningEffort, 'high', 'explicit choice overrides this model default low');
  await selectModel(ctx, reasoningStore, { provider: 'wechat-test-fixture', model: 'alternate' });
  await reasoningRunner.run({ text: '同一会话恢复模型默认', sessionId: reasoningFirst.sessionId, signal: controller.signal });
  assert.equal(requests.at(-1).reasoningEffort, 'low', 'clearing an explicit effort cannot inherit the preceding turn high');
  await selectModel(ctx, reasoningStore, { provider: 'wechat-test-fixture', model: 'fixture', reasoningEffort: 'low' });
  await reasoningRunner.run({ text: '同一会话换模型和推理强度', sessionId: reasoningFirst.sessionId, signal: controller.signal });
  assert.equal(requests.at(-1).provider, 'wechat-test-fixture'); assert.equal(requests.at(-1).reasoningEffort, 'low');
  await selectModel(ctx, reasoningStore, null);
  await reasoningRunner.run({ text: '重新跟随宿主明确默认', sessionId: reasoningFirst.sessionId, signal: controller.signal });
  assert.equal(requests.at(-1).reasoningEffort, 'high', 'DSH currentSelection explicit effort remains authoritative');
  await selectModel(ctx, reasoningStore, { provider: 'wechat-test-fixture', model: 'alternate', reasoningEffort: 'high' });
  await reasoningRunner.run({ text: '当前任务保留已经捕获的推理强度', signal: controller.signal,
    onSession: () => selectModel(ctx, reasoningStore, { provider: 'wechat-test-fixture', model: 'alternate', reasoningEffort: 'low' }) });
  assert.equal(requests.at(-1).reasoningEffort, 'high', 'a concurrent saved choice must not alter the in-flight agent');
  assert.equal(reasoningStore.modelChoice().reasoningEffort, 'low');
  assert.equal(requests.length, reasoningBefore + 5);
  assert.throws(() => completedText([{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', message: 'PRIVATE_PROVIDER_DETAIL' } } } }]),
    error => error.code === 'MODEL_INCOMPLETE' && error.message.includes('请求参数') && error.message.includes('推理强度') && !error.message.includes('PRIVATE_PROVIDER_DETAIL'));
  assert.throws(() => completedText([{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'PRIVATE_PROVIDER_DETAIL' } } } }]),
    error => error.code === 'MODEL_INCOMPLETE' && error.message.includes('请求额度或调用频率') && !error.message.includes('PRIVATE_PROVIDER_DETAIL'));
  const beforeEmpty = requests.length;
  mode = 'empty-once'; emptyResponses = 0;
  const recoveredEmpty = await reasoningRunner.run({ text: '合成空白正文恢复', signal: controller.signal });
  assert.equal(recoveredEmpty.text, 'DSH 原生回复完成'); assert.equal(recoveredEmpty.emptyResponseRetries, 1);
  assert.equal(requests.length - beforeEmpty, 2);
  assert.equal(requests.at(-1).model, requests.at(-2).model);
  assert.equal(requests.at(-1).reasoningEffort, requests.at(-2).reasoningEffort);
  mode = 'empty-always';
  await assert.rejects(reasoningRunner.run({ text: '合成连续空白正文', signal: controller.signal }), { code: 'MODEL_EMPTY' });
  assert.equal(requests.length - beforeEmpty, 4);
  mode = 'empty-after-tool'; let executedTools = 0;
  await assert.rejects(reasoningRunner.run({ text: '查询隔离链路', signal: controller.signal,
    tools: [{ ...combinedTool, execute: async (...args) => { executedTools++; return combinedTool.execute(...args); } }] }), { code: 'MODEL_EMPTY' });
  assert.equal(executedTools, 1); assert.equal(requests.length - beforeEmpty, 6);
  mode = 'complete';
  const { summarizeMemory, MAX_COMPRESSION_INPUT_CHARS } = require(path.join(repo, 'modules/memory/conversation/compaction.mjs'));
  const beforeBatches = requests.length;
  assert.equal(await summarizeMemory('合成会话素材。'.repeat(6000), 4000, reasoningRunner, controller.signal), 'DSH 原生回复完成');
  assert(requests.length - beforeBatches >= 4);
  assert(requests.slice(beforeBatches).every(request => request.messages.filter(message => message.role === 'user')
    .flatMap(message => message.content).reduce((total, block) => total + (block.text?.length ?? 0), 0) < MAX_COMPRESSION_INPUT_CHARS + 4000));
  await verifyPluginLifecycle(ctx);
  const report = { ok: true, dsh: hostRequire('./package.json').version, node: process.versions.node,
    assertions: ['shared native model catalog', 'model choice persistence', 'real provider/model routing on resume', 'chosen model reasoning defaults', 'removed provider refuses fallback', 'return to DSH default', 'real temperature and maxTokens request controls', 'null temperature preserves Host default', 'persona and participation instructions in model prompt', 'workspace stored on create and retained on resume', 'configured Host session root observed through injection', 'Host session root stays independent of workspace', 'real agent create', 'persistent resume', 'complete prompt isolation', 'no inherited tools', 'final reasoning filtering', 'max-token refusal', 'cancellation', 'queued channel-to-agent-to-ACK', 'reload deduplication', 'real plugin apply and WorkerClient shutdown preserve participation progress', 'initial offline snapshots preserve progress but live disconnect resets it'], requests: requests.length, at: new Date().toISOString() };
  report.assertions.push('native scoped tool registration and actual task creation', 'quoted task requests denied inside the native tool boundary', 'native search tool calls only the bounded public query', 'actual DSH image admission and two ordered multimodal blocks');
  report.assertions.push('durable global identity reloaded in the native prompt', 'the single global assistant and common language policy survive native create and resume', 'native scoped memory tool preserves the receive-time boundary');
  report.assertions.push('actual editor-saved persona fields and examples receive their own principles on native create and persisted resume');
  report.assertions.push('native memory lookup accepts null keywords and empty first-page cursors, returns both complete partitions, retains the receive-time snapshot and keeps legitimate follow-up queries available');
  report.assertions.push('native DSH preserves a 2400x1600 original within its admission budget', 'per-image thumbnail limits reach the native vision prompt');
  report.assertions.push('retired document retrieval and answering are absent from the native workbench');
  report.assertions.push('independent image memory keeps original bytes and generates a bounded thumbnail', 'native saved-image search and read supply the stored 2400x1600 original to isolated vision and return its observation');
  report.assertions.push('native generated-image search and read retain the actual 2400x1600 pixels, bind the exact quoted message and persist visual observations into quotation history and memory');
  report.assertions.push('native natural-chat timer runs through the shared channel and real ACK boundary', 'natural decision and public reply use one native model request', 'natural skip produces no WeChat message or signature', 'natural chat inherits no search, task or host tools even with search enabled');
  report.assertions.push('native boilerplate reply keeps all formulas and returns a local review note with one model request');
  report.assertions.push('native complete replies beyond 12000 characters preserve all content and the ending with one model request');
  report.assertions.push('receipt-time archiving makes zero native provider requests', 'current-photo tool routes exactly one isolated native vision request and saves its observation', 'native account-quota error identifies insufficient model balance without leaking diagnostics');
  report.assertions.push('selected-model detail lookup discovers native efforts missing from the shared list without generation', 'explicit reasoning choice persists and reaches the native model', 'unsupported effort is rejected before generation', 'same-session reasoning reset and model change cannot reuse an old effort', 'return to DSH default preserves its explicit effort', 'in-flight model selection includes the captured reasoning effort', 'invalid request points to model parameters without leaking provider details',
    'resumed native context contains only the current persona, selected WeChat history and memory',
    'surface rebasing retains and reopens the complete native audit log across multiple turns',
    'resumed tool calls retain the complete current call and result without prior native dialogue');
  report.assertions.push('native whitespace completion recovers once with the same model and reasoning effort',
    'repeated native emptiness stops after two requests without exposing reasoning', 'native executed tools are never replayed after an empty final answer',
    'native long-memory requests use bounded batches and a final ordered consolidation');
  report.assertions.push('native DSH registers and executes wechat_moments_like_recent with actual-sender lookup and synthetic server acknowledgement',
    'native repeated like requests reuse the durable selection without another read or write',
    'native tool results preserve an unknown acknowledgement without claiming a successful like');
  report.assertions.push('native DSH validates and executes random interaction preview then run with per-post synthetic like and comment receipts',
    'native repeated interaction calls retain the chosen posts and do not resubmit',
    'native DSH can list, configure, stop and disable revision-bound automatic interaction settings without sending immediate social actions');
  report.assertions.push('native DSH registers the existing reply-schedule tool with independent friend continuation and own-comment switches, preserving settings through partial updates without immediate writes');
  fs.writeFileSync(path.join(repo, 'storage/logs/dsh-plugin-native-test.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const fork of forks.reverse()) await fork.dispose();
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  // The standalone SDK fixture has no user work and may retain infrastructure
  // timers; all per-message Agent handles and channel work have already drained.
  setTimeout(() => process.exit(process.exitCode || 0), 20);
});
