const synonyms = { 換: '换', 開: '开', 啟: '启', 關: '关', 聊: '聊', 執: '执', 話: '话', 狀: '状', 態: '态', 當: '当', 現: '现', 請: '请', 幫: '帮', 調: '调', 為: '为', 進: '进', 轉: '转', 個: '个', 麼: '么', 還: '还', 嗎: '吗' };
const normalize = text => text.normalize('NFKC').replace(/[換開啟關聊執話狀態當現請幫調為進轉個麼還嗎]/gu, char => synonyms[char]);
const requestPrefix = /^(?:(?:请你?|麻烦你?|帮我|给我|现在|马上|立即|先|能不能|可不可以|可以|能否|能|你)[\s,，:：]*)+/u;
const mode = '(工作|执行|干活|聊天|闲聊|对话)(?:模式|状态)?';
const action = '(?:切换|调整|返回|回到|切|换|改|转|进入|开启|启用|打开|恢复)(?:一下)?(?:到|成|为|回|入)?(?:一下)?';
const setMode = new RegExp('^' + action + '(?:(?:当前|本|这个)会话的?)?' + mode + '(?:一下|去)?$', 'u');
const targetOf = name => ['工作', '执行', '干活'].includes(name) ? 'work' : 'chat';
function trimEnding(value) {
  let previous;
  do {
    previous = value;
    value = value.trim().replace(/[。.!！?？]+$/u, '').replace(/(?:[,，]?\s*(?:谢谢(?:你)?|麻烦了)|好吗|好么|行吗|可以吗|吧|呀|啊|啦|了|吗|么)$/u, '').trim();
  } while (value !== previous);
  return value;
}

/** Match complete requests; names and wording never confer administrator authority. */
export function executionModeCommand(text, names = []) {
  let value = normalize(String(text ?? '').trim());
  if (!value || value.length > 400) return null;
  for (const name of [...names].filter(name => typeof name === 'string' && name).sort((a, b) => b.length - a.length)) {
    if (value.startsWith(normalize(name))) { value = value.slice(normalize(name).length).replace(/^[\s,，:：]+/u, ''); break; }
  }
  value = value.replace(/^\/agent\s+/i, '');
  const explicit = /^\/mode(?:\s+([\s\S]*))?$/i.exec(value);
  if (explicit) {
    const target = (explicit[1] ?? '').trim().toLowerCase();
    if (['status', '状态'].includes(target)) return { action: 'status' };
    if (['work', '工作', '工作模式'].includes(target)) return { action: 'set', target: 'work' };
    if (['chat', '聊天', '聊天模式'].includes(target)) return { action: 'set', target: 'chat' };
    return { action: 'help' };
  }
  if (/["“”「」『』`\n\r]/u.test(value) || /引用|转发|示例|例句|翻译|复述|怎么|如何|怎样|假如|假设|如果|例如|他说|她说|有人说|意思|原理|方法|日志|提示|弹窗|文件|代码|文档|按钮/u.test(value.split(/[,，]/u)[0])) return null;
  value = trimEnding(value).replace(/\s+/gu, '');
  // Requests such as 能不能 are affirmative questions; remove them before testing negation.
  value = value.replace(requestPrefix, '');
  if (/^(?:(?:当前|现在|目前)(?:的)?(?:执行)?模式|(?:当前|现在|目前)(?:是|用的是|用|使用的|处于)?(?:什么|哪种|哪个)?(?:执行)?模式|(?:是|用的是|用|使用的|处于)(?:什么|哪种|哪个)(?:执行)?模式|(?:查看|看看|查一下)(?:当前|现在|目前)(?:的)?(?:执行)?模式|(?:告诉我|看看)(?:现在|当前)(?:是|用的)?(?:什么|哪种|哪个)模式|(?:当前|现在|目前)?(?:是|处于)(?:工作|聊天|执行|干活|闲聊|对话)模式|(?:是)?工作模式还是聊天模式)$/u.test(value)) return { action: 'status' };
  // Only these explicit complementary clauses may precede a direct mode request.
  const complement = /^(?:别聊了|不闲聊了)[,，](.+)$/u.exec(value);
  const backToChat = /^(?:不干活了|别执行任务了)[,，](.+)$/u.exec(value);
  if (complement || backToChat) value = (complement ?? backToChat)[1].replace(requestPrefix, '');
  if (/(?:不要|不用|无需|不必|不需要|别|不能|保持|继续用)/u.test(value)) return null;
  value = value.replace(/^(?:把|将)(?:(?:当前|本|这个)会话的?)?(?:执行)?模式/u, '')
    .replace(/^(?:把|将)(?:(?:当前|本|这个)会话|你|机器人|助手)/u, '')
    .replace(/^(?:把|将)(?=(?:工作|执行|干活|聊天|闲聊|对话)模式)/u, '');
  const set = setMode.exec(value)
    ?? /^(工作|执行|干活|聊天|闲聊|对话)模式(?:先)?(?:打开|开启|启用|开起来)$/u.exec(value);
  let target = set ? targetOf(set[1]) : null;
  if (/^(?:从现在)?开始(?:工作|干活)$/u.test(value)) target = 'work';
  if (/^(?:退出|结束|关闭|停用|取消)(?:工作|执行|干活)模式$|^(?:工作|执行|干活)模式(?:先)?(?:关闭|关掉|停用|取消)$/u.test(value)) target = 'chat';
  if (target) {
    if ((complement && target !== 'work') || (backToChat && target !== 'chat')) return { action: 'help' };
    return { action: 'set', target };
  }
  // Mixed instructions require a separate mode request instead of executing their tail.
  if (/^(?:切换|切回|切到|切|换|调整|进入|开启|恢复|退出|改成|改为).{0,20}(?:工作|聊天|执行|干活|闲聊|对话)模式/u.test(value) || /^切换模式$/u.test(value)) return { action: 'help' };
  return null;
}
