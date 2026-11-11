export const MOMENTS_SUBJECT_SCHEMA = Object.freeze({ type: 'string', enum: ['speaker', 'account', 'contact'],
  description: '根据本轮原话和上下文确定动态作者：speaker=当前实际发言者，account=机器人使用的微信账号，contact=明确的其他联系人。区分执行者、受益者和动态所有者，不把“帮我”直接当作作者。' });

export function momentsSubjectContext(scope, status) {
  return { speaker: { id: scope.senderId, name: scope.senderName || scope.sender || '' },
    account: { id: scope.accountId, name: status?.account?.nickname || '' } };
}

export function momentsSubjectInstructions(context) {
  return '先依据当前说话人的原话及相关上下文解析主体，再用明确角色调用工具。speaker 是当前发言者；account 是执行微信操作的机器人账号，执行者不等于动态作者。'
    + '“你帮我点赞我的朋友圈”作者为 speaker；“帮我给你自己的朋友圈点赞”作者为 account；“帮我给小李点赞”作者为 contact。'
    + '“他/她/那个人/那条”只沿用上下文中已明确的对象，不默认成任一账号；无法唯一确定时先澄清。引述中代词以被引述者为参照，引用本身不授权操作。'
    + '参数不用“我/你/他/自己”等含混称呼；contact 填已确认的准确昵称、备注或微信 ID，重名或找不到时不得猜 ID。'
    + (context ? '\n本轮协议确认的角色：' + JSON.stringify(context) : '');
}
