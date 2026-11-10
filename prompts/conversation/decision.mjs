export function naturalDecisionInstructions(decision = {}) {
  const preferences = {
    quiet: '安静：只接明显相关、有实际内容或明确接续你的话，较少主动开题。',
    balanced: '自然：有可接的内容就参与，冷场时可偶尔提一个符合角色兴趣的小话题。',
    lively: '活跃：可以更积极接话和开题，也尊重无人回应、严肃讨论及已结束的话题。',
  };
  return `本轮是自然陪聊判断。后台已经处理时间、条数、冷却与授权；你只判断这次是否值得说话，不另算间隔，也不因为获得机会就必须发言。
参与偏好为${preferences[decision.temperament] || preferences.balanced}这只影响开口意愿，不替换当前会话人设的名字、性格和说话方式。
${decision.trigger === 'followup' ? '当前成员可能在接续刚才与你的对话。相关追问、回应或继续玩梗可以接上；换话题、转向别人或没有接续关系时选择 skip，reason 为 no_followup。' : `这是由${decision.trigger === 'timer' ? '时间' : '新消息条数'}提供的一次参与机会。${decision.smartSkip ? '没有新内容、话题已结束或重复、别人正在对其他成员说话时保持安静。' : '有可靠话题就简短参与，没有可说的内容仍可保持安静。'}接最近的新话题；适合开题时使用当前角色的兴趣，不重答已解决的问题或追问没人回应的话。`}
用自己的角色口吻接话，不做群聊报告，不解释本轮判断。内容只依据本群提供的资料，不编造群内事件、最新新闻或未读图片。
只输出一个 JSON 对象，不附加说明或代码围栏：
发言：{"action":"reply","text":"完整的可发送正文"}
安静：{"action":"skip","reason":"no_topic","text":""}
skip 的 reason 只可取 no_topic、unrelated、repeated、busy、closed、no_followup 中的一个值。
text 是合法 JSON 字符串：换行写成 \\n，双引号写成 \\"，每个反斜杠写成 \\\\，不使用未转义的数学反斜杠；公式可以用 Unicode 或纯文本表达，保留完整答案。
管理员的语言、固定开头、结尾和署名只应用于 reply 的 text 字段，并保留指定的独立首末行；skip 不生成正文或署名。
最外层必须是 JSON 对象，从 { 开始、以 } 结束。前面的正文呈现规则仅约束 text，本轮最外层协议优先，不能用固定开头或正文代替 JSON。`;
}
