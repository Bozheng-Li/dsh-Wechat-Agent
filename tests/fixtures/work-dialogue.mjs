// Scripted model responses for routing tests. Production routing uses the model.
const questions = new Set(['你好', '解释一下这段代码', '示例：写一个文件', '不要执行命令，先分析问题',
  '不要打开 vscode 连接 scut2', '“用ssh方式链vscode中的scut2服务器”', '怎么用 SSH 连接 vscode', '能不能并行启动',
  '能不能并行多开 DSH？', '不要生成图片，只解释怎么调用', '“帮我运行代码”是什么意思']);
// Explicit synthetic decisions; this fixture is never used by production.
export function fixtureWorkRoute(input) {
  const data = JSON.parse(input.text);
  const action = questions.has(data.message) ? 'chat' : data.currentTaskId ? 'continue' : 'new';
  return { text: JSON.stringify({ action, taskId: action === 'continue' ? data.currentTaskId : null }) };
}
export async function fixtureWorkDialogue(input, plan) {
  if (input.mode !== 'work-dialogue') throw Error('ordinary chat/memory runner entered work fixture');
  const data = { message: input.text, ...input.workContext }, exec = { signal: input.signal };
  const invoke = async (name, args = {}) => JSON.parse(await input.tools.find(tool => tool.name === name).execute(args, exec));
  if (plan) return plan(data, invoke);
  if (data.message === '/dsh tasks') {
    const result = await invoke('wechat_work_status', { action: 'tasks' });
    return { text: result.text ?? result.message };
  }
  if (/^\/work(?:\s|$)/i.test(data.message)) {
    const body = data.message.replace(/^\/work\s*/i, ''), control = /^(status|cancel|continue)(?:\s+([a-f0-9]{12}))?(?:\s+([\s\S]+))?$/i.exec(body);
    const command = !body ? { action: 'help' } : control
      ? { action: control[1].toLowerCase(), id: control[2], request: control[3] }
      : { action: 'create', request: body };
    if (command.action === 'help') return { text: '请用 /work status 查询，或说明要执行的任务。' };
    if (command.action === 'status') {
      const result = await invoke(command.id ? 'wechat_work_task' : 'wechat_work_tasks', command.id ? { id: command.id } : {});
      return { text: result.ok ? '已读取你的实际工作任务状态。' : result.message };
    }
    if (command.action === 'cancel') {
      const id = command.id ?? (await invoke('wechat_work_tasks')).tasks[0]?.id;
      if (!id) return { text: '你还没有工作任务。' };
      const result = await invoke('wechat_work_cancel', { id });
      return { text: result.ok ? '已经请求停止这个任务。' : result.message };
    }
    if (command.action === 'continue') {
      const result = await invoke('wechat_work_continue', { id: command.id, request: command.request });
      return { text: result.ok ? '好，我接着处理这个任务。' : result.message };
    }
    const result = await invoke('wechat_work_start', { request: command.request });
    return { text: result.ok ? '好，我来处理这个任务，结果出来后发你。' : result.message };
  }
  if (questions.has(data.message)) {
    await invoke('wechat_work_tasks');
    return { text: '可以随时问我任务情况，独立任务能各开一个 DSH 会话并行处理。' };
  }
  const result = await invoke('wechat_work_start', { request: data.message });
  return { text: result.ok ? '好，我来处理这个任务，结果出来后发你。' : result.message };
}
