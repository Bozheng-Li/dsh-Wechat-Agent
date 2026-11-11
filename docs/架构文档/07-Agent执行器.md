# Agent 执行器

[返回总架构](01-总架构.md)

## 职责

`modules/agent/runner.mjs` 的 `DshAgentRunner` 封装微信聊天侧对 DSH Agent/Session 的调用；选择插件配置模型或 DSH 默认模型，构建系统提示、历史和可用工具，提取最终正文。`models.mjs` 校验所选模型与视觉模型，`request-context.mjs` 隔离续接时的上下文，`output.mjs` 提取完成文本，`reply-style.mjs` 与 `request-metrics.mjs` 负责风格检查、模型请求指标。

## 执行流程

1. `run(...)` 冻结本轮模型与运行设置；图片输入选择具备视觉能力的模型，非视觉输入继续使用当前选择。未配置 `maxTokens` 时交给 DSH 模型适配器决定输出预算。
2. 组合身份、讲话人、任务信息、最近历史和记忆；`prompts/reply/compose.mjs` 负责最终系统提示。普通聊天会话禁用桌面/编程预设，并仅注册当前允许的微信工具；内部判断与视觉等模式不暴露执行工具。
3. `ctx.agents.create` 或 `resume` 建立/继续会话，工作区由 `workspace.mjs` 登记。`setup` 挂载 `wechat-agent` 系统提示、工具和请求参数钩子；通过 `ctx.attachments.admitPromptContent` 注入真实图片字节。
4. 以 `agent.followup` 提交用户消息，`whenIdle` 后从事件中提取最终回复；模型空输出在符合条件时用同一模型补发一次说明，不换模型。完成后取消/释放句柄。
5. 回复由 `modules/conversation/reply.mjs` 统一发送；执行器本身不直接写微信。

## 能力边界

`describeImage`/`describeImages` 单独使用视觉请求，表情包不调用视觉模型；`summarize` 负责记忆压缩；长期事实提取与复核使用内部隔离模式。`SearchService` 属于执行器提供的工具后端，但是否开放依赖 `modelConfig.webSearch`。`polishReply` 在原文上补齐固定语言边界，`reviewMemoryReply` 仅在需要时核对记忆依据；工作结果的独立润色见 `modules/work/polish.mjs`。

原生工作执行器是不同类 `modules/work/runner.mjs::DshWorkRunner`：保留 DSH 原生预设和工具、按任务目录执行，不继承聊天人设与微信历史。两者都调用 DSH Agents，但权限与上下文不应混用。

## 测试

参考 `tests/model-reasoning-runner.test.mjs`、`tests/model-output-tokens.test.mjs`、`tests/vision-routing.test.mjs`、`tests/empty-response-recovery.test.mjs`、`tests/request-context.test.mjs`、`tests/persona-delivery.test.mjs`。修改提示拼装需同时验证工具权限、图片输入和续接行为。
