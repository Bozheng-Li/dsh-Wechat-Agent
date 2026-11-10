import { ChannelError, publicError } from '../../shared/contracts.mjs';
import { promptText } from '../../prompts/loader.mjs';
import { parseRemoteIntent } from '../remote/intent/index.mjs';
import { workAdministrator } from '../work/policy.mjs';
import { workTools } from './work-execution.mjs';
import { workImageRequest } from '../../shared/work-image-request.mjs';

export const WORK_TURN_TASK_LIMIT = 8;
const taskRequest = request => {
  if (typeof request !== 'string' || !request.trim() || request.length > 12000)
    throw new ChannelError('WORK_REQUEST_INVALID', '工作要求应为 1–12000 字');
  return request.trim();
};

/** Model-selected operations on independent DSH work sessions. */
export function workSessionTools({ channel, scope, signal, request, createTask, taskState, readDialogue = () => ({ entries: [] }), createdTaskCount = () => 0 }) {
  const assertAllowed = () => { signal.throwIfAborted(); channel.work.assertAllowed(scope, signal); };
  const tool = (name, key, properties, required, execute) => ({
    name, description: promptText('work/dialogue-tools.json', key),
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    execute: async (args, execution = {}) => {
      assertAllowed(); execution.signal?.throwIfAborted();
      try {
        const result = await execute(args, execution.signal ? AbortSignal.any([signal, execution.signal]) : signal);
        assertAllowed(); execution.signal?.throwIfAborted();
        return JSON.stringify({ ok: true, ...result });
      } catch (error) {
        if (['STATE_WRITE_FAILED', 'CONFIG_CHANGED', 'WORK_NOT_AUTHORIZED'].includes(error?.code) || signal.aborted || execution.signal?.aborted) throw error;
        return JSON.stringify({ ok: false, ...publicError(error, '这次工作操作没有完成') });
      }
    },
  });
  const definitions = [
    tool('wechat_work_tasks', 'tasks', {}, [], () => taskState()),
    tool('wechat_work_task', 'task', { id: { type: 'string', pattern: '^[a-f0-9]{12}$' } }, ['id'], ({ id }) => taskState(id)),
    tool('wechat_work_history', 'history', { limit: { type: 'integer', minimum: 1, maximum: 8 } }, [],
      ({ limit = 4 }) => readDialogue(limit)),
    tool('wechat_work_start', 'start', { request: { type: 'string', minLength: 1, maxLength: 12000 } }, ['request'],
      ({ request }) => createTask(taskRequest(request))),
    tool('wechat_work_parallel', 'parallel', { requests: { type: 'array', minItems: 2, maxItems: WORK_TURN_TASK_LIMIT,
      items: { type: 'string', minLength: 1, maxLength: 12000 } } }, ['requests'], ({ requests }) => {
      if (!Array.isArray(requests) || requests.length < 2 || requests.length + createdTaskCount() > WORK_TURN_TASK_LIMIT)
        throw new ChannelError('WORK_QUEUE_FULL', '并行调用请提供 2–8 个独立任务，本条消息最多创建 8 个任务');
      // Validate the entire model-selected batch before saving its first task.
      const validated = requests.map(taskRequest), tasks = [];
      for (const request of validated) {
        try { tasks.push(createTask(request).task); }
        catch (error) {
          if (['STATE_WRITE_FAILED', 'CONFIG_CHANGED', 'WORK_NOT_AUTHORIZED'].includes(error?.code)) throw error;
          return { ok: false, tasks, capacity: channel.work.capacity(), complete: false,
            error: publicError(error, '部分独立任务未创建'), message: '仅 tasks 中的任务已保存，其他任务未创建；不要重复创建已保存的任务' };
        }
      }
      return { tasks, capacity: channel.work.capacity(), complete: true,
        message: '独立任务已保存；按实际并行容量启动各自的 DSH 会话，超出容量的任务等待空闲' };
    }),
    tool('wechat_work_continue', 'continue', { id: { type: 'string', pattern: '^[a-f0-9]{12}$' },
      request: { type: 'string', minLength: 1, maxLength: 12000 } }, ['id', 'request'],
      ({ id, request }) => createTask(taskRequest(request), id)),
    tool('wechat_work_cancel', 'cancel', { id: { type: 'string', pattern: '^[a-f0-9]{12}$' } }, ['id'], ({ id }) => {
      channel.work.owned(id, scope);
      const job = channel.work.cancel(id, scope);
      return { task: { id: job.id, state: job.state }, stopping: channel.work.active.get(id)?.controller.signal.aborted === true };
    }),
  ];
  const imageGeneration = channel.work.imageGeneration;
  if (imageGeneration) {
    // Reuse the execution tool's live API/model schema; the dialogue schedules
    // its work rather than blocking other user replies on an image HTTP call.
    const image = workTools({ imageGeneration }).find(tool => tool.name === 'wechat_work_generate_image');
    const definition = tool(image.name, 'generate-image', image.parameters.properties, image.parameters.required, args => {
      taskRequest(args.prompt);
      if (typeof args.path !== 'string' || !/\.(?:png|jpe?g)$/i.test(args.path))
        throw new ChannelError('WORK_ARTIFACT_INVALID', '生图文件名应以 .png 或 .jpg 结尾');
      const catalog = imageGeneration.catalog();
      if (!catalog.enabled) throw new ChannelError('IMAGE_GENERATION_DISABLED', '尚未启用生图 API，请在设置 → 生图 API 配置接口、模型和密钥');
      const provider = catalog.providers.find(value => value.providerId === (args.providerId ?? catalog.defaultProviderId));
      if (!provider)
        throw new ChannelError('IMAGE_GENERATION_PROVIDER', '所选生图接口未配置，请从生图接口列表中选择');
      if (args.model !== undefined && (!provider || !provider.models.includes(args.model)))
        throw new ChannelError('IMAGE_GENERATION_MODEL', '所选接口未配置这个生图模型，请从该接口的模型列表中选择');
      const imageRequest = workImageRequest({ prompt: args.prompt, path: args.path, size: args.size ?? provider.size ?? '1024x1024',
        providerId: provider.providerId, model: args.model ?? provider.defaultModel });
      return { ...createTask(imageRequest.prompt, undefined, { imageRequest }),
        imageGeneration: { providerId: imageRequest.providerId, providerName: provider.name, model: imageRequest.model, size: imageRequest.size } };
    });
    definition.description += '\n当前生图接口与模型：' + JSON.stringify(imageGeneration.catalog());
    definitions.push(definition);
  }
  if (workAdministrator(channel.store, scope) && channel.remote) definitions.push(
    tool('wechat_work_status', 'status', { action: { type: 'string', enum: ['computer', 'tasks', 'task'] },
      id: { type: 'string' } }, ['action'], async (args, signal) => {
      const [query] = parseRemoteIntent(JSON.stringify({ queries: [args] }), request);
      return { action: query.action, text: await channel.remote.query(query, scope, signal) };
    }));
  return definitions;
}
