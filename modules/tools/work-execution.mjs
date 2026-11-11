import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicBytes } from '../../backend/storage/atomic-text.mjs';
import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { promptText } from '../../prompts/loader.mjs';
import { workPath } from '../work/policy.mjs';
import { parseRemoteIntent } from '../remote/intent/index.mjs';
import { readWorkArtifact } from '../work/artifacts.mjs';
import { WORK_ARTIFACT_LIMITS } from '../../shared/work-artifacts.mjs';
import { workExecutionPolicy, workFilePath } from '../work/permissions.mjs';
import { workImageRequest } from '../../shared/work-image-request.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const READ_PAGE_CHARS = 6000;
const streamText = stream => {
  const text = String(typeof stream === 'string' ? stream : stream?.text ?? '');
  return { text: text.slice(-8000), capturedChars: text.length, truncated: text.length > 8000 || stream?.truncated === true };
};
function readCursor(cursor, target, revision) {
  let value;
  try {
    if (typeof cursor !== 'string' || cursor.length > 400 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'offset,path,revision,v' || value.v !== 1 ||
        value.path !== digest(target) || !/^[a-f0-9]{64}$/.test(value.revision) || !Number.isInteger(value.offset) || value.offset < 0) throw Error();
  } catch { throw new ChannelError('WORK_READ_CURSOR_INVALID', '文件分页游标无效或不属于此路径，请从该文件重新读取'); }
  if (value.revision !== revision) throw new ChannelError('WORK_FILE_CHANGED', '文件在分页读取期间已变化，请从头读取，不能拼接不同版本的正文');
  return value.offset;
}
export function workTools({ cwd, request = '', shell, resolvePolicy, limits, assertAllowed, onOperation, connections, queryStatus, imageGeneration, imageRequest }) {
  const selectedImage = imageRequest === undefined ? undefined : workImageRequest(imageRequest);
  let selectedImageAttempted = false;
  const attemptedImages = new Set();
  const tool = (name, key, properties, required, execute) => ({
    name, description: promptText('work/tools.json', key),
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async (args, exec) => {
      assertAllowed(); exec.signal?.throwIfAborted();
      let result;
      try { result = await execute(args, exec); }
      catch (error) {
        result = exec.signal?.aborted ? { ok: false, cancelled: true, ...publicError(exec.signal.reason, '工作操作已取消') }
          : { ok: false, ...publicError(error, '工作工具执行失败') };
      }
      await onOperation({ tool: name, ...(args.path ? { path: args.path } : {}), ...(Array.isArray(args.paths) ? { paths: [...args.paths] } : {}),
        ...(args.action ? { action: args.action, ...(args.id ? { id: args.id } : {}) } : {}),
        ...(args.alias ? { alias: args.alias } : {}), ...(args.command ? { command: args.command.slice(0, 4000) } : {}), result });
      assertAllowed(); exec.signal?.throwIfAborted();
      return JSON.stringify(result);
    },
  });
  const policy = exec => workExecutionPolicy(resolvePolicy, shell, cwd, exec);
  const file = (relative, exec, write = false) => workFilePath(cwd, relative,
    resolvePolicy || shell?.ctx?.sandboxPolicy || shell?.ctx?.get?.('sandboxPolicy') ? policy(exec) : undefined, write);
  const definitions = [
    tool('wechat_work_list', 'list', { path: { type: 'string' } }, [], ({ path: relative = '.' }, exec) => ({ ok: true,
      items: fs.readdirSync(file(relative, exec), { withFileTypes: true }).filter(entry => entry.name !== '.wechat-work').slice(0, 100)
        .map(entry => ({ name: entry.name, directory: entry.isDirectory(), link: entry.isSymbolicLink() })) })),
    tool('wechat_work_read', 'read', { path: { type: 'string' },
      offset: { type: 'integer', minimum: 0, description: '从第几个 Unicode 字符开始，默认 0；与 cursor 二选一。' },
      limit: { type: 'integer', minimum: 1, maximum: READ_PAGE_CHARS, description: '本页最多返回的字符数，默认 6000。' },
      cursor: { type: 'string', maxLength: 400, description: '原样使用上次同一路径返回的 nextCursor，继续读取同一版本。' },
    }, ['path'], ({ path: relative, offset, limit = READ_PAGE_CHARS, cursor }, exec) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > READ_PAGE_CHARS ||
          offset !== undefined && (!Number.isInteger(offset) || offset < 0) || cursor !== undefined && offset !== undefined)
        throw new ChannelError('WORK_READ_RANGE_INVALID', '请提供有效的文件字符范围：offset 不小于 0，limit 为 1–6000，cursor 与 offset 不能同时填写');
      const target = file(relative, exec), stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > 512000) throw new ChannelError('WORK_FILE_INVALID', '工作文本文件最多为 500 KB');
      const bytes = fs.readFileSync(target);
      if (bytes.length > 512000) throw new ChannelError('WORK_FILE_INVALID', '工作文本文件最多为 500 KB');
      const revision = digest(bytes), characters = Array.from(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const start = cursor === undefined ? offset ?? 0 : readCursor(cursor, target, revision);
      if (start > characters.length) throw new ChannelError('WORK_READ_RANGE_INVALID', '读取起点超出文件正文，请使用已返回的字符范围');
      const end = Math.min(start + limit, characters.length), hasMore = end < characters.length;
      return { ok: true, path: relative, text: characters.slice(start, end).join(''), revision,
        bytes: bytes.length, totalChars: characters.length, offset: start, returnedChars: end - start,
        truncated: start > 0 || hasMore, hasMore,
        nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, path: digest(target), revision, offset: end })).toString('base64url') : null };
    }),
    tool('wechat_work_write', 'write', { path: { type: 'string' }, text: { type: 'string' }, revision: { type: ['string', 'null'] } }, ['path', 'text', 'revision'], ({ path: relative, text, revision }, exec) => {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 512000) throw new ChannelError('WORK_FILE_INVALID', '工作文本文件最多为 500 KB');
      const target = file(relative, exec, true);
      const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
      if ((previous ? digest(previous) : null) !== revision) throw new ChannelError('WORK_FILE_CHANGED', '文件已变化，请重新读取后再修改');
      atomicBytes(target, Buffer.from(text));
      return { ok: true, path: relative, bytes: Buffer.byteLength(text), revision: digest(Buffer.from(text)) };
    }),
    tool('wechat_work_output', 'output', { paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: WORK_ARTIFACT_LIMITS.count }, sendAs: { type: 'string', enum: ['auto', 'file', 'image'] } }, ['paths'], ({ paths, sendAs = 'auto' }, exec) => {
      if (!Array.isArray(paths) || !paths.length || paths.length > WORK_ARTIFACT_LIMITS.count) throw new ChannelError('WORK_ARTIFACT_LIMIT', '请指定 1–8 个最终成果文件');
      const prepared = paths.map(relative => {
        const target = file(relative, exec), inside = path.relative(cwd, target);
        const external = inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside);
        return { target, external, value: readWorkArtifact(external ? path.dirname(target) : cwd,
          external ? path.basename(target) : inside, undefined, sendAs) };
      });
      const artifacts = prepared.map(({ external, value }) => {
        if (!external) return value.metadata;
        const relative = `attachments/${value.metadata.sha256.slice(0, 16)}/${value.metadata.name}`;
        const target = file(relative, exec, true), bytes = Buffer.from(value.segment.data.base64, 'base64');
        if (fs.existsSync(target) && digest(fs.readFileSync(target)) !== value.metadata.sha256)
          throw new ChannelError('WORK_FILE_CHANGED', '回传副本已变化，请核对后重新登记');
        atomicBytes(target, bytes);
        return readWorkArtifact(cwd, relative, undefined, sendAs).metadata;
      });
      return { ok: true, artifacts, message: '成果已登记，任务结束后由微信通道回传；尚未发送，不要声称已经送达' };
    }),
    tool('wechat_work_exec', 'execute', { command: { type: 'string' } }, ['command'], async ({ command }, exec) => {
      if (typeof command !== 'string' || !command.trim() || command.length > 12000) throw new ChannelError('WORK_COMMAND_INVALID', '工作命令应为 1–12000 字符');
      if (!shell || shell.sandboxMode === undefined || typeof shell.resolve !== 'function' || typeof shell.execute !== 'function')
        throw new ChannelError('WORK_EXECUTION_UNAVAILABLE', 'DSH 未提供可解析会话权限的 PowerShell 执行器，命令未执行；请检查 DSH 工作预设');
      const actualPolicy = policy(exec);
      const spec = shell.resolve({ command, workdir: cwd, timeoutMs: limits.commandTimeoutSeconds * 1000, onExpiry: 'kill',
        sandboxPolicy: actualPolicy, signal: exec.signal });
      if (spec.sandboxPolicy?.mode !== actualPolicy.mode || path.resolve(spec.sandboxPolicy.workspaceRoot ?? '') !== path.resolve(actualPolicy.workspaceRoot) ||
          spec.sandboxPolicy.sessionId !== actualPolicy.sessionId || path.resolve(spec.workdir) !== path.resolve(cwd) || spec.onExpiry !== 'kill' ||
          spec.timeoutMs !== limits.commandTimeoutSeconds * 1000 || spec.signal !== exec.signal)
        throw new ChannelError('WORK_SANDBOX_INVALID', 'DSH 执行配置未保留任务目录或超时停止策略，命令未执行');
      let result;
      try { result = await (await shell.execute(spec)).result(); }
      catch (error) {
        if (exec.signal?.aborted) throw exec.signal.reason;
        throw new ChannelError('WORK_EXECUTION_FAILED', error?.win32Code === 5 && actualPolicy.mode === 'danger-full-access'
          ? '此 DSH 会话使用完全权限，但操作系统拒绝启动命令或访问执行目录，命令未执行'
          : error?.win32Code === 5
          ? 'DSH Windows 沙箱无法设置任务目录写权限，命令未执行；请检查此工作空间的目录权限'
          : 'DSH 命令未能取得执行结果，请在 DSH 检查执行器与权限配置；未视为执行成功');
      }
      if (result.sandbox?.mode !== actualPolicy.mode) throw new ChannelError('WORK_SANDBOX_INVALID', 'DSH 执行结果与本次会话权限不一致，执行状态需要在 DSH 中核对');
      const stdout = streamText(result.stdout), stderr = streamText(result.stderr);
      return { ok: result.exitCode === 0 && !result.aborted && !result.timedOut && !result.sandbox.denied && !result.sandbox.runnerFailed,
        ...(result.aborted ? { cancelled: true } : {}),
        exitCode: result.exitCode, timedOut: !!result.timedOut, stdout: stdout.text, stderr: stderr.text,
        outputTruncated: stdout.truncated || stderr.truncated,
        stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
        stdoutCapturedChars: stdout.capturedChars, stderrCapturedChars: stderr.capturedChars,
        sandbox: { mode: result.sandbox.mode, enforcement: result.sandbox.enforcement ?? 'unknown', denied: !!result.sandbox.denied, runnerFailed: !!result.sandbox.runnerFailed } };
    }),
  ];
  if (imageGeneration) {
    const catalog = imageGeneration.catalog(), providerIds = catalog.providers.map(provider => provider.providerId), models = [...new Set(catalog.providers.flatMap(provider => provider.models))];
    const definition = tool('wechat_work_generate_image', 'generate-image', {
      prompt: { type: 'string' }, path: { type: 'string' }, size: { type: 'string' },
      providerId: { type: 'string', ...(providerIds.length ? { enum: providerIds } : {}), description: '已配置的生图接口编号；省略时使用默认接口。' },
      model: { type: 'string', ...(models.length ? { enum: models } : {}), description: '所选接口模型列表中的模型名；省略时使用该接口的默认模型。' },
    }, ['prompt', 'path'], async (args, exec) => {
    if (selectedImage && Object.entries(selectedImage).some(([key, value]) => args[key] !== undefined && args[key] !== value))
      throw new ChannelError('WORK_IMAGE_REQUEST_CHANGED', '本任务已选定生图参数，请沿用本轮已选择的调用，不切换接口、模型或改写要求');
    const { prompt, path: relative, size, providerId, model } = selectedImage ?? args;
    if (!/\.(?:png|jpe?g)$/i.test(relative)) throw new ChannelError('WORK_ARTIFACT_INVALID', '生图文件名应以 .png 或 .jpg 结尾');
    workPath(cwd, relative);
    const target = file(relative, exec, true);
    if (fs.existsSync(target)) throw new ChannelError('WORK_FILE_CHANGED', '生图文件已存在，请使用新的成果文件名，避免覆盖已有图片');
    if (selectedImage && selectedImageAttempted)
      throw new ChannelError('WORK_IMAGE_ALREADY_ATTEMPTED', `${selectedImage.providerId} / ${selectedImage.model}：本次已选生图调用已经尝试执行，未再次请求；请按第一次调用的结果回复，新的生图需要用户重新提出要求`);
    const provider = catalog.providers.find(item => item.providerId === (providerId ?? catalog.defaultProviderId));
    const attempt = JSON.stringify({ prompt, providerId: providerId ?? catalog.defaultProviderId,
      model: model ?? provider?.defaultModel, size: size ?? provider?.size });
    if (attemptedImages.has(attempt))
      throw new ChannelError('WORK_IMAGE_ALREADY_ATTEMPTED', '本次任务已经尝试过相同的生图调用，未重复请求；请按第一次调用的真实结果回复');
    attemptedImages.add(attempt);
    if (selectedImage) selectedImageAttempted = true;
    let generated;
    try { generated = await imageGeneration.generate({ prompt, size, providerId, model }, exec.signal, assertAllowed); }
    catch (error) {
      if (error instanceof ChannelError && error.imageGeneration) return { ok: false, ...publicError(error),
        providerId: error.imageGeneration.providerId, providerName: error.imageGeneration.providerName, model: error.imageGeneration.model,
        imageGeneration: error.imageGeneration, automaticRetry: false, automaticFallback: false };
      throw error;
    }
    assertAllowed(); exec.signal.throwIfAborted();
    const actual = relative.slice(0, -path.extname(relative).length) + generated.extension, destination = file(actual, exec, true);
    if (fs.existsSync(destination)) throw new ChannelError('WORK_FILE_CHANGED', '生图目标文件已存在，已有图片保留；请使用新文件名');
    atomicBytes(destination, generated.bytes);
    const { metadata } = readWorkArtifact(cwd, actual, undefined, generated.sendAs ?? 'auto');
    return { ok: true, artifacts: [metadata], providerId: generated.providerId, providerName: generated.providerName, model: generated.model,
      prompt: prompt.slice(0, 4000),
      message: generated.sendAs === 'file'
        ? 'API 原图已生成并保存，超过 10 MiB 图片发送上限，任务结束后作为原图文件附件回传；尚未发送'
        : 'API 图片已生成并保存，任务结束后原生回传微信；尚未发送' };
    });
    definition.description += '\n当前生图接口与模型：' + JSON.stringify(catalog);
    if (selectedImage) {
      for (const [key, value] of Object.entries(selectedImage)) definition.parameters.properties[key] = { type: 'string', enum: [value] };
      definition.description += '\n本任务执行已选择的生图调用：' + JSON.stringify(selectedImage) + '。失败后只报告真实原因，不执行其他脚本、重复请求或切换接口。';
    }
    definitions.push(definition);
  }
  if (connections) {
    const properties = { alias: { type: 'string' } };
    definitions.push(tool('wechat_work_ssh_connect', 'ssh', properties, ['alias'], ({ alias }, exec) => connections.ssh(alias, exec.signal)),
      tool('wechat_work_ssh_exec', 'ssh-execute', { ...properties, command: { type: 'string' } }, ['alias', 'command'],
        ({ alias, command }, exec) => connections.execute(alias, command, exec.signal)),
      tool('wechat_work_vscode_connect', 'vscode', properties, ['alias'], ({ alias }, exec) => connections.vscode(alias, exec.signal)));
  }
  if (queryStatus) definitions.push(tool('wechat_work_status', 'status',
    { action: { type: 'string', enum: ['computer', 'tasks', 'task'] }, id: { type: 'string' } }, ['action'], async (args, exec) => {
      const [query] = parseRemoteIntent(JSON.stringify({ queries: [args] }), request);
      return { ok: true, action: query.action, text: await queryStatus(query, exec.signal) };
    }));
  if (selectedImage) {
    const image = definitions.find(definition => definition.name === 'wechat_work_generate_image');
    if (!image) throw new ChannelError('IMAGE_GENERATION_DISABLED', '此生图任务没有可用的生图工具');
    return [image];
  }
  return definitions;
}
