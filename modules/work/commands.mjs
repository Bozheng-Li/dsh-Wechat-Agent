const command = /^\/work(?:\s+([\s\S]*))?$/i;
export function workConnectionRequest(text) {
  const value = String(text ?? '').trim();
  if (/^["“「『`]/u.test(value) || /^(?:转发|引用|例句|示例|翻译|复述|解释)[：:\s]/u.test(value) ||
      /(?:写|生成|制作).{0,30}(?:教程|脚本|示例|说明|模板|代码)/iu.test(value) ||
      /(?:不要|不用|无需|不必|不需要|别).{0,12}(?:[连链]|打开|启动|使用|ssh|vscode)/iu.test(value) ||
      /(?:怎么|怎样|如何|原理)/u.test(value) && !/(?:帮我|给我|请你|麻烦你)/u.test(value)) return false;
  return /(?:\bssh\b|vscode|vs\s*code|remote\s*-?\s*ssh|远程[连链]接)/iu.test(value) &&
    /(?:[连链](?:接|上|一下|到|\s*(?:vscode|vs\s*code|scut\w*))|打开|启动|使用|通过|(?:用|以).{0,12}\bssh\b|connect|open|launch)/iu.test(value);
}
const editorRequest = request => {
  const open = /(?:打开|启动)\s*(?:vscode|vs\s*code)|(?:vscode|vs\s*code).{0,20}(?:远程窗口|新窗口)/iu.test(request);
  if (!open && /(?:vscode|vs\s*code).{0,40}配置/iu.test(request)) return false;
  return open || /[连链](?:接|上|到)?\s*(?:vscode|vs\s*code)|(?:vscode|vs\s*code).{0,20}远程连接/iu.test(request);
};
export const missingConnectionOperation = (request, operations) => workConnectionRequest(request) &&
  !operations.some(op => editorRequest(request) ? op.tool === 'wechat_work_vscode_connect'
    : ['wechat_work_ssh_connect', 'wechat_work_ssh_exec', 'wechat_work_vscode_connect'].includes(op.tool));

export const remoteInspectionRequest = request => workConnectionRequest(request) &&
  /(?:查看|读取|检查|分析|统计|汇总|inspect|read|check|analy[sz]e).{0,80}(?:实验|指标|结果|日志|文件|metrics|results?|logs?)/iu.test(request);

export function workExecutionError(request, operations) {
  if (missingConnectionOperation(request, operations)) return { code: 'WORK_CONNECTION_NOT_EXECUTED',
    message: '连接未执行，还没能连接到你指定的服务器。' };
  if (workConnectionRequest(request) && !operations.some(op => op.result.ok &&
      (editorRequest(request) ? op.tool === 'wechat_work_vscode_connect'
        : ['wechat_work_ssh_connect', 'wechat_work_ssh_exec', 'wechat_work_vscode_connect'].includes(op.tool))))
    return { code: 'WORK_CONNECTION_FAILED', message: '服务器连接没有通过，暂时无法继续这次远程任务。' };
  if (remoteInspectionRequest(request) &&
      !operations.some(op => op.tool === 'wechat_work_ssh_exec')) return { code: 'WORK_REMOTE_COMMAND_NOT_EXECUTED',
    message: 'SSH 认证已经通过，但尚未读取远端结果，这次查询还没完成。' };
  if (remoteInspectionRequest(request) && !operations.some(op => op.tool === 'wechat_work_ssh_exec' && op.result.ok))
    return { code: 'WORK_REMOTE_COMMAND_FAILED', message: '已经连接服务器，但远端结果读取没有成功，这次查询还没完成。' };
  return null;
}

/** Admission precedes chat context. Mode and sender authorization are checked separately. */
export function workCommand(text) {
  const value = String(text ?? '').trim(), matched = command.exec(value);
  if (matched) {
    const body = (matched[1] ?? '').trim();
    if (!body) return { action: 'help' };
    const fresh = /^(?:new|start)\s+([\s\S]+)$/i.exec(body);
    if (fresh) return { action: 'create', request: fresh[1].trim(), newSession: true };
    if (/^(?:new|start)(?:\s|$)/i.test(body)) return { action: 'help' };
    const control = /^(status|cancel|continue)(?:\s+([a-f0-9]{12}))?(?:\s+([\s\S]+))?$/i.exec(body);
    if (control) {
      const action = control[1].toLowerCase();
      if ((action === 'continue' && (!control[2] || !control[3])) || (action !== 'continue' && control[3])) return { action: 'help' };
      return { action, id: control[2]?.toLowerCase(), request: control[3]?.trim() };
    }
    if (/^(status|cancel|continue)(?:\s|$)/i.test(body)) return { action: 'help' };
    return { action: 'create', request: body };
  }
  return null;
}

export const WORK_HELP = '管理员可直接说“切换到工作模式”“切回聊天模式”，或用 /mode work、/mode chat。工作模式仅对当前会话已开启远程查询的全局／会话管理员生效；群聊选择昵称唤醒时，管理员普通消息也需呼叫 Agent 名字或别名，兼容 @ 与显式命令；私聊可直接发送。模型先根据当前消息和该发起人的工作上下文判断聊天、工作或原任务补充。聊天才读取聊天记录与人设；实际工作只用工作上下文。每位发起人有自己的 DSH 会话，普通工作与 /work 要求默认追加；明确指定旧任务时追加对应会话，/work new 主动新开后后续默认追加新会话。其他成员继续昵称聊天。\n管理员也可使用：\n/work <任务要求>\n/work new <新会话任务要求>\n/work status [任务编号]\n/work cancel [任务编号]\n/work continue <任务编号> <修改要求>\n工作与聊天固定使用各自的项目；独立任务和并行工具仍在工作项目内建立新会话。管理员身份按实际微信 ID 校验。';
