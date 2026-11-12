import { ChannelError } from '../../shared/contracts.mjs';
import { capabilityCatalog } from '../../prompts/agent/capabilities.mjs';

/** One list owns both the model's declarations and local execution dispatch. */
export function modelToolList(definitions = []) {
  const names = new Set();
  return definitions.map(definition => {
    if (!definition || !/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name) || names.has(definition.name) ||
        typeof definition.execute !== 'function')
      throw new ChannelError('MODEL_TOOLS_INVALID', '模型工具名称重复或定义无效，未开始执行');
    names.add(definition.name);
    return definition;
  });
}

/** DSH serializes these registered definitions into every model request.tools. */
export function registerModelTools(ctx, definitions, { assertAllowed = () => {}, denied = '此会话只能使用本轮提供的工具', native = false, inherit = false, quiet = false, workProgressManaged = false, agent, onDispose, onBeforeTool, deferredGroups = [] } = {}) {
  const tools = modelToolList(definitions), allowed = new Set(tools.map(tool => tool.name));
  // Validate the complete authorized inventory before making any registrations.
  modelToolList([...tools, ...deferredGroups.flatMap(group => group.tools)]);
  const groups = new Map(deferredGroups.map(group => [group.id, group]));
  if (groups.size !== deferredGroups.length || deferredGroups.some(group => !/^[a-z][a-z-]{0,31}$/.test(group.id)) ||
      (groups.size && [...tools, ...deferredGroups.flatMap(group => group.tools)].some(tool => tool.name === 'wechat_capabilities')))
    throw new ChannelError('MODEL_TOOLS_INVALID', '能力目录无效，未开始执行');
  const retain = disposer => { if (typeof disposer === 'function') onDispose?.(disposer); };
  // A DSH deployment/preset may otherwise collapse all functions into run_code.
  // This agent-scoped presentation sends the actual function list to the model.
  if (native && (!agent || ctx.tools.modeFor?.(agent) !== 'native')) retain(ctx.tools.presentAs?.('native'));
  if (!inherit) retain(ctx.tools.restrict({ allow: [] }));
  const register = tool => { retain(ctx.tools.register(tool)); allowed.add(tool.name); };
  for (const tool of tools) register(tool);
  if (groups.size) {
    const catalog = capabilityCatalog(deferredGroups, async (args, execution) => {
      execution?.signal?.throwIfAborted(); assertAllowed();
      if (!Array.isArray(args?.modules) || !args.modules.length || args.modules.length > groups.size ||
          args.modules.some(id => !groups.has(id)))
        return JSON.stringify({ ok: false, code: 'CAPABILITY_UNKNOWN', message: '请选择本轮目录中的能力编号；加载不增加授权。' });
      const loaded = [];
      for (const id of new Set(args.modules)) {
        const group = groups.get(id);
        for (const tool of group.tools) if (!allowed.has(tool.name)) register(tool);
        loaded.push({ id, tools: group.tools.map(tool => tool.name) });
      }
      return JSON.stringify({ ok: true, loaded, message: '所选工具已可用。根据完整参数定义调用；这里只加载能力，没有执行查询、创建或发送。' });
    });
    tools.push(catalog); register(catalog);
  }
  retain(ctx.tools.guard(execution => {
    try {
      assertAllowed();
      return inherit || allowed.has(execution?.name) ? undefined : denied;
    } catch (error) { return error.message; }
  }));
  if (typeof onBeforeTool === 'function' && typeof ctx.on === 'function') {
    // The public around-dispatch hook runs after host approval and guards.
    // It covers deferred and inherited tools without modifying the host registry.
    retain(ctx.on('tools/execute', async (execution, next) => {
      if (agent && execution.agent !== agent) return next();
      execution.signal?.throwIfAborted(); assertAllowed();
      await onBeforeTool(execution.name, execution.arguments, execution);
      execution.signal?.throwIfAborted(); assertAllowed();
      return next();
    }));
  }
  if (quiet) retain(ctx.systemPrompt?.section?.({ name: 'wechat-quiet-tools', order: 90, interpolate: false,
    text: '工具查询、读写、重试和其他中间步骤静默执行，不逐步播报。' +
      (workProgressManaged ? '后台会先发一句简短开工确认，长任务约每 3 分钟单独汇报实际阶段；这些微信消息由通道统一发送，不重复接单或为每次工具操作发消息。'
        : '不重复接单或承诺稍后处理。') +
      '需要用户选择或补充信息时简短提问；结束时一次给出结果，默认一至三句，只说结果和必要的下一步。用户要求详细说明、长文或作品正文时按要求完整给出。失败只说明实际障碍。' +
      (workProgressManaged ? '用户主动询问进度时，按实际状态回应。' : '用户主动询问进度时再回答当前状态。') }));
  return tools;
}
