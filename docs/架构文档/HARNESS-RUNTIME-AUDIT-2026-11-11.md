# 运行时深测与优化方向（2026-11-11）

> **证据截止与后续变更：** 本文涉及本地实现的“当前”“最新”“已关闭”“开放”，均指本轮各自留存的候选及截至 2026-11-11 11:09（北京时间）的专项复验。第二轮全量回归随后完成，其成绩仍归属于该轮实际执行阶段，不代表一个固定的 11:09 构建通过整套验收。12:26 恢复工作时，共享工作树又有源码重构；这些后续改动不由本报告认证，也不据旧证据宣称现工作树仍有相同缺陷。正文的源码路径、行号与状态按对应证据阶段保留，后续候选需要独立核验。

本报告审计本次会话中未提交工作树的 DSH 原生接入、工作执行、定时提醒、微信传输和朋友圈运行时。审计期间其他并行工作更新了源码与 bundle，因此下文分开保留初始候选和最后复验，旧原生/界面结果不能直接视为新候选通过。结果用于提出优化方案；本审计没有修改业务实现、加载用户 DSH profile、调用付费模型或向真实微信发送消息。

**最紧急的问题是工作操作记录与工具注册表不一致。** 初始候选四种工具执行并保存后，重新加载 `WorkStore` 会报 `WORK_STATE_INVALID`；10:40–10:41 复验曾确认新增 `wechat_file` 也有相同问题，共五种。11:08–11:09 最新候选的最小复验已确认文件分支修复，当前缺失范围回到原来的四种工具。并行工作的请求指标也已观察到跨任务混记，10:40 复验的最小合同仍确认过滤参数缺失。现有原生测试有充分的有效覆盖，但部分夹具落后于当前功能，不能把脚本的失败一概归为业务失败，也不能把某个脚本 `exit 0` 一概视为没有错误。

## 1. 环境与证据边界

| 项目 | 本轮实测值 |
| --- | --- |
| 审计日期 | 2026-11-11，Asia/Shanghai |
| 代码基线 | 初始候选与最后复验分开；保留全部已有未提交修改 |
| 构建入口 | 主审计执行 `npm test` 中的 build；本报告未另行构建 |
| DSH 安装 | `D:/deepseek-harness`，`0.2.1-rc.5` |
| Node | 外部命令 `24.16.0`；DSH 内部 `24.21.0` |
| 初始候选 bundle | `lib/testing.js`，SHA-256 `56A519E9E03DF03B4A6BD6C86D8433769B3407D1877D78313FAB6130D602EFCF`；第 2 节原生/时钟测试使用此候选 |
| 10:40 合同复验 bundle | `lib/testing.js`，SHA-256 `2ECFC7D11C17C22F00323EA2E7CD143692ECF9487BE4CFB96F4EB1DEEA549A4D`；第 2.1 节使用此候选 |
| 文件分支收尾复验 bundle | `lib/testing.js`，SHA-256 `D2D053595C78702A86857A60C0716741C5557F00762730FBE379D5BF4366455E`；第 2.3 节仅复验文件操作持久化 |
| 原生测试真实部分 | 已安装 DSH SDK、Agent/Session、工具声明与派发、会话持久化、工作目录、实际 PowerShell、实际文件和本机状态查询 |
| 合成部分 | 模型输出、搜索服务、生图服务、微信账号、微信发送和朋友圈回执 |
| 新增审计产物 | `storage/logs/harness-audit-2026-11-11/runtime/` 与 `runtime-final/`；本地证据通常被 Git 忽略 |

真实微信扫码、在线联系人同步、微信服务器收发、图文整帖发布、真实云模型质量、付费生图和真实 SSH 主机未在本轮执行，不能由合成 ACK 或 SDK 测试推导为已通过。既有历史实测只作为历史资料，本轮不重复背书。

## 2. 初始候选执行记录

| 命令/场景 | 实际结果 | 证据与解释 |
| --- | --- | --- |
| `node scripts/test-dsh-native.cjs D:/deepseek-harness` | 低负载复跑通过：76 次模型请求、68 个报告断言 | [dsh-native-low-load.json](../../storage/logs/harness-audit-2026-11-11/runtime/dsh-native-low-load.json)、[日志](../../storage/logs/harness-audit-2026-11-11/runtime/dsh-native-low-load.log)。首次与全量回归并发执行触发 45 秒 watchdog，不能据此判断业务回归。 |
| 原版 `node scripts/test-native-handoff.cjs D:/deepseek-harness` | 失败 | 模型夹具第 116 行工具集合断言未包含当前的 `wechat_memory`、`wechat_generated_image_memory`；随后第 324 行观察到子任务数 `0 != 2`。[原版日志](../../storage/logs/harness-audit-2026-11-11/runtime/work-native.log)。 |
| 审计副本 `test-native-handoff-instrumented.cjs` | 通过：49 个报告断言，58 次 native 请求、25 次路由、57 次润色、3 次原生文件调用、6 次真实 PowerShell 调用、5 次合成生图 API 调用 | 仅修正副本工具预期、路径并添加诊断；业务代码未改。[结果](../../storage/logs/harness-audit-2026-11-11/runtime/work-native-adapted.json)。此结果不替代原版门禁修复。 |
| 原版 `node scripts/test-remote-native.cjs D:/deepseek-harness` | 失败：在 querying tasks 阶段 30 秒超时 | 插桩确认夹具收到内部记忆维护请求后，也进入“原始长任务”的 `finish` 等待；主流程则在等待 `channel.whenIdle()`，形成测试死锁。[插桩日志](../../storage/logs/harness-audit-2026-11-11/runtime/remote-native-instrumented.log)。 |
| 审计副本 `remote-native-adapted.cjs` | 通过：10 项检查，2 次主请求、2 次辅助维护请求 | 副本单独响应内部资料请求，保留 `REMOTE_QUERY_INTENT` 分支。原始运行中 Agent、Session、事件序列均保留，真实电脑查询成功；真实微信消息为 0。[日志](../../storage/logs/harness-audit-2026-11-11/runtime/remote-native-adapted.log)。 |
| `node scripts/test-search-native.cjs D:/deepseek-harness` | 主流程 7 个场景、15 次请求通过，进程退出 0；另有一个后台 native turn 断言错误 | 覆盖延迟加载、主服务、回退、禁用、内部隔离、原生继承与生图隔离；日志还有 `assert(system.includes('wechat_web_search') && system.includes('公开'))`。只能记“主场景通过，后台夹具异常待处理”，不能记无错误通过。[结果](../../storage/logs/harness-audit-2026-11-11/runtime/search-native.json)、[日志](../../storage/logs/harness-audit-2026-11-11/runtime/search-native.log)。 |
| `node scripts/test-scheduler-clock.mjs` | 通过 | 真实计时 61.202 秒，晚到 1.199 秒；ACK 前任务 `running`、记录 `sending`，ACK 后完成；一条确认、一条提醒，无重复提醒。[结果](../../storage/logs/harness-audit-2026-11-11/runtime/scheduler-clock.json)。 |
| `node --test tests/work-mode.test.mjs` | 24 项：23 通过、1 失败，141.037 秒 | 原版管理员群工作测试将 `memory.snapshot` 替换为无条件抛普通 `Error`，与现实现的按需记忆接收时快照冲突。[日志](../../storage/logs/harness-audit-2026-11-11/runtime/work-mode-rerun.log)。 |
| 副本 `work-mode-adapted.test.mjs`，仅运行管理员群工作案例 | 1/1 通过 | 只取消“调用 snapshot 就失败”的夹具；保留禁止聊天 context、长期记忆 capture 的断言及原来的输出/重启断言。[日志](../../storage/logs/harness-audit-2026-11-11/runtime/work-mode-adapted.log)。 |
| `node storage/logs/harness-audit-2026-11-11/runtime/runtime-probes.mjs` | 10 组观察完成，发现 4 个工具持久化失败等问题 | [探针代码](../../storage/logs/harness-audit-2026-11-11/runtime/runtime-probes.mjs)、[结构化结果](../../storage/logs/harness-audit-2026-11-11/runtime/runtime-probes.json)。探针命令退出 0 表示成功采集证据，不代表被测产品全部正确。 |
| `node storage/logs/harness-audit-2026-11-11/runtime/scheduler-cross-conversation.mjs` | 跨会话队头阻塞复现 | 同账号两个不同且均已授权的私聊；观察 205 ms 时慢会话在执行，另一到期会话仍 pending 且未提交；释放慢任务后两者均完成。[结构化结果](../../storage/logs/harness-audit-2026-11-11/runtime/scheduler-cross-conversation.json)。未观察无限等待，真实微信消息与模型调用均为 0。 |

SDK 进程有 `crashpad CreateFile ... 0x2` 输出；低负载原版 native 与适配版 work/remote 在相同警告下均通过，因此未将这个警告直接判为运行时失败。

复现审计副本：先执行 `prepare-native-copies.mjs`，再运行其生成的 native 副本；在适配工作结果 JSON 已存在时，`prepare-followup-copies.mjs` 会生成 remote/work-mode 副本并从合成工作目录提取指标证据。所有生成器都位于同一 runtime 目录；它们不会改写 `scripts/`、`tests/` 或业务源码。

### 2.1 10:40 候选的关键合同复验

2026-11-11 10:40:45–10:41:06 +08:00 执行 `node storage/logs/harness-audit-2026-11-11/runtime-final/contracts.mjs`。没有重建，也没有复用旧日志；[结果](../../storage/logs/harness-audit-2026-11-11/runtime-final/contracts.json) 保存当时 bundle 与六个相关源码文件的前后 SHA-256，七个文件在探针期间均未变化。

| 复验范围 | 实际结果 | 强度与限制 |
| --- | --- | --- |
| 工作工具 → 操作落盘 → `WorkStore` 重载 | `wechat_moments_images`、`wechat_moments_like_recent`、`wechat_moments_interact`、`wechat_web_search`、新增 `wechat_file` 均执行成功并写入一条操作，重载均 `WORK_STATE_INVALID`；`wechat_work_list` 对照成功 | 真实最新工具定义与存储；服务为合成响应。`wechat_file` 实际测 list，不借此宣称真实 DOCX 下载读取通过 |
| 最新工作指标生产调用合同 | 源码调用仍无 `sessionId`；两个会话各发一条流请求时，两个观察器各记录 2 次并都混入 1/4 字符输入；显式绑定会话的对照各只记录 1 次 | 真实最新 observer 的最小中间件合同，不是新一轮完整 DSH Agent 集成；初始 native 的 9/7 数字仍只归初始候选 |

新增微信入站文件与 DOCX 功能的协议、正文、安全边界和测试由[对话与工具专项](HARNESS-MEMORY-TOOLS-AUDIT-2026-11-11.md)另列。最终候选全量门禁以主报告为准，本节只记录 10:40 复验候选的 RT-01/RT-02 合同复验，不将初始包审计、原生或 UI 成绩移记到新候选。

### 2.2 后续构建变化与引用测试诊断

10:48:45 工作树中的 `lib/testing.js` 再次更新为 SHA-256 `53A23153B5F015CCB1337BE58FA2159D72A1F7C39F0F13438C244DED59C89E00`。只读哈希核对确认，`work/store.mjs`、`work/runner.mjs`、`tools/index.mjs`、`tools/work-execution.mjs` 和 `agent/request-metrics.mjs` 与 10:40 合同复验一致；`tools/files.mjs` 有变化，其当前实现仍通过 `onOperation` 保存 `wechat_file` 操作。该源码核对不等于新构建的完整原生复跑，前述动态合同结果仍归属于 10:40 复验候选。

主回归在 `message-references.test.mjs` 附近长时间没有新 stdout 时，另起无构建诊断命令 `node --test --test-timeout=120000 tests/message-references.test.mjs`。主进程随后完成该文件并进入后续测试，重复诊断自身也持续产生 I/O，因此没有证据把本次现象判为引用解析或通道关闭死锁。测试 fixture 没有 `transport.files`，文件工具访问器直接返回 `null`，不能把新文件功能直接归因为这次等待。

重复诊断从 10:48:24 运行至 10:55:03，仅为减少重复 I/O 而结束其自有 runner/child；取消前子进程仍有 775 次写操作、1,495,606 字节写入，且运行期间发生上述 bundle 更新。本次记为**诊断取消，不计通过或失败**，不把它作为固定新候选的验收成绩。[取消记录](../../storage/logs/harness-audit-2026-11-11/runtime-final/message-references-diagnostic-cancelled.json)。主回归实际成绩以主报告为准。

### 2.3 最新候选的文件操作持久化分支已修复

2026-11-11 11:08:19–11:09:09 +08:00，仅运行既有合同探针的 `wechat_file` 分支副本：`node storage/logs/harness-audit-2026-11-11/runtime-cutoff/persistence-wechat-file.mjs`。最新 `D2D053…` bundle 中，真实 `wechat_file list` 定义执行成功，操作写盘后 `WorkStore` 重载成功，原操作与既有合成 ACK 均完整保留。命令退出 0；bundle、存储、结果分类、文件工具、工具组合与 worker 测试共六个文件的前后 SHA-256 一致。[结构化结果](../../storage/logs/harness-audit-2026-11-11/runtime-cutoff/persistence-wechat-file.json)、[日志](../../storage/logs/harness-audit-2026-11-11/runtime-cutoff/persistence-wechat-file.log)。没有重新构建、启动全量或原生测试，也没有真实模型/微信调用。

当前白名单新增了 `wechat_file`，但仍未包含 `wechat_moments_images`、`wechat_moments_like_recent`、`wechat_moments_interact`、`wechat_web_search`；这四项本次仅核对源码，动态失败证据仍来自第 2.1 节。RT-01 / 总报告 F02 因而是**文件分支已关闭、其余四项仍开放**，不能继续写作五项当前失败。

同批只读审查确认，`work/outcome.mjs` 将未恢复的文件操作失败计入任务结果，列文件不算有效产出，并按动作、附件选择和分页条件匹配重试；`worker-send-account.test.mjs` 增加文件 IPC 的账号校验、精确消息编号、会话替换和错误脱敏案例。本轮没有执行这些新增测试，文件正文与完整性专项成绩仍以对话与工具附录为准。

## 3. 已验证的问题

### RT-01 · P0 · 新工具写入工作记录后无法重载

当前触发：工作任务调用 `wechat_web_search`、`wechat_moments_images`、`wechat_moments_like_recent` 或 `wechat_moments_interact`，结果经 `onOperation` 写入工作索引，随后重启或重新构造 `WorkStore`。`wechat_file` 曾有相同问题，已在第 2.3 节确认修复。

初始探针实际执行四种工具定义，取得 `ok: true`，保存一条合法工作任务；四次重载均报 `WORK_STATE_INVALID`。10:40 复验候选重复确认这四种失败，并以真实 `wechat_file list` 定义确认当时的第五种失败；同流程旧工具 `wechat_work_list` 对照成功。搜索使用真实 `webSearchTool` 及与生产 runner 相同的记录包装，搜索服务为合成响应。文件工具由 `work-execution.mjs` 注入，并在 `files.mjs` 通过相同 `onOperation` 写入；其白名单遗漏已修复，11:09 重载与原回执保留复验通过。

根因：[工作存储](../../modules/work/store.mjs) 第 12–16 行独立维护旧工具白名单，第 51 行据此拒绝整个索引；[工具组合](../../modules/tools/index.mjs) 和 [工作 runner](../../modules/work/runner.mjs) 已注册并记录新工具。`WechatChannel` 构造会同步创建 `WorkService`，后者同步加载 `WorkStore`，因此影响可能扩大到通道初始化。这里没有观察真实用户实例崩溃，而是证明了合法当前数据无法被当前加载器接受。

方案：由同一能力契约生成注册、持久化解码、结果分类和诊断名称；工具执行权限与历史事件兼容分开。已存储的旧/扩展工具事件可以作为历史事实安全读取，不得因此自动注册可执行工具，也不得丢弃确认回执。先为仍缺失的四种事件做兼容修复，守护已通过的文件操作重载，再清理重复名单。

验收：每个会记录操作的工具均跑“真实定义调用 → 写盘 → 全部服务重建 → 原操作/回执保留”；未知未来事件按明确兼容策略显示，损坏数据仍拒绝；历史重载不得执行外部副作用。此项应作为下一次更新的发布阻断项。

### RT-02 · P1 · 并行工作和辅助请求的指标串记

触发：同时执行多个 DSH 工作任务，或工作期间运行进度/润色等辅助请求。

初始候选原生工作审计中两个子任务分别执行“写文件 → PowerShell → 完成”，每个固定 3 次 native 请求；记录的 `requestMetrics` 却分别为 **9 次和 7 次**，其中包含 `toolsCount=0` 的辅助请求。证据来自实际 DSH 会话的落盘任务：[work-metrics-isolation.json](../../storage/logs/harness-audit-2026-11-11/runtime/work-metrics-isolation.json)。10:40 候选的最小合同复验仍确认生产调用未绑定会话、两路各一请求被各计两次；它证明当时问题仍在，但不把旧 9/7 数字当作后续候选的原生复跑结果。

根因：[工作 runner](../../modules/work/runner.mjs) 第 91 行调用 `observeModelRequests` 时未传 `sessionId`；[指标观察器](../../modules/agent/request-metrics.mjs) 只有收到 `sessionId` 才过滤全局 LLM 流。现有 [隔离单测](../../tests/request-metrics-isolation.test.mjs) 总是显式传入归属，覆盖不了生产调用遗漏。

方案：生产注册点绑定实际 `agent.session.id`，加入 `requestId/parentRequestId/jobId` 归属；分别计主工作、视觉、进度、润色、记忆维护请求。诊断只保留计数与必要标识，不复制正文或凭据。

验收：原生并行 A/B 各 3 次时各只记 3；额外启动视觉和进度不得改变主任务计数；失败、取消和恢复仍归于正确会话。后续 token/延迟 A/B 必须先通过此项，否则成本比较有偏差。

### RT-03 · P1 · 持久化任务缺少完整载入 schema 校验

触发：`storage/tasks/schedules.json` 可解析且版本/归属正确，但某条任务的 `schedule.kind` 损坏。

探针先通过公开创建方法保存合法任务，再把 `schedule.kind` 改为 `unsupported`，重新构造 `TaskScheduler` **没有拒绝**。当前 [调度器](../../modules/tasks/scheduler.mjs) 加载时主要验证顶层、归属、数组和提醒目标；创建时的完整 schedule 检查没有复用于历史数据。

方案：为 task/run 的 ID 唯一性、账号/会话、状态、schedule 判别联合、时间戳、retry 字段、关联记录和回执增加版本化持久化 schema。历史一次性任务允许已过期，不能直接调用要求“未来一年”的创建校验代替载入校验。坏条目隔离与整库拒绝的策略需明确，同时保持原文件与可诊断原因。

验收：损坏种类、非法状态、重复 ID、断裂 run 引用、非法日期和错误账号都在执行前被发现；合法逾期任务仍按现有补发/合并策略执行；无任务因错误格式变成隐式重复任务。

### RT-04 · P1 · Worker 不响应取消时没有本地收敛上限

探针启动独立本地 worker，让它接受 IPC 但不响应 send/cancel；调用 `send` 后立即取消，200 ms 后 Promise 仍未完成，pending 为 1。随后显式关闭测试 worker 完成清理。

[WorkerClient](../../backend/wechat/worker-client.mjs) 第 46–70 行的 send 默认 `timeoutMs=0`；取消只发 IPC，不在本地结束等待。这有合理背景：完整多分块文件传输不能被固定 200 秒总时长截断，而且取消期间晚到 ACK 必须保留。[底层传输](../../backend/wechat/protocol/transport.ts) 已有逐请求超时，因此普通慢网络不等于本问题；缺口是 worker 仍存活但卡死/不合作。

方案：增加“无进展”deadline、worker 心跳和取消握手 deadline，区分传输进行中与完全无进展；截止后把操作记为 unknown，终止等待并保留晚到 ACK 的关联入口。只回收本插件持有的 worker，不能自动重发或影响无关进程。

验收：正常长文件可超旧总时长完成；卡死 worker 的取消在有界时间内收敛；晚到 ACK 不丢失；前半已确认的多段发送不得退化为全部未发送；关闭插件不会无限等待。

### RT-05 · P1 · 测试夹具与当前功能契约脱节

三类证据已分开：原版 work 工具表落后；原版 remote 夹具漏处理内部维护请求而死锁；work-mode 方法级禁止快照与新按需记忆接口冲突。另有 search 主场景绿色但后台断言错误。

方案：建立可复用的 SDK fixture，按 session/mode/parentRequest 路由模型响应；声明预期主调用和允许的辅助调用，监听所有 `turn/end` 的错误与未处理异常。工具集合由权限矩阵契约推导，并单独断言敏感工具不可用；不要用整体字符串白名单取代能力契约。共享夹具也不能由生产实现生成所有期望值，以免自证。

验收：恢复原版 native/work/remote/search 门禁无后台异常；每个主流程至少增加一次跨进程重载；测试结束确认 Agent、子进程、计时器和文件锁已释放。全量 npm 的 work-mode 失败可由本条解释，但仍须正式修复测试后才能宣称总门禁全绿。

## 4. 其余运行时优化方向

以下是基于当前实现和探针的设计改进，除非注明，不代表已经观察到真实业务事故。

| ID / 优先级 | 当前证据与改进方向 | 验收方式 |
| --- | --- | --- |
| RT-06 / P1 | **统一副作用日志和恢复协议。** 朋友圈已采用 `clientId + inputHash + pending/succeeded/rejected/unknown`，任务/工作/恢复各有状态实现。抽出小型公共 receipt/operation 契约与状态归约器，保留业务差异；不把未知当失败重试。 | 在“意图落盘前/后、发送前/后、ACK 前/后、结果落盘前/后”各崩溃点重启；确认过的副作用不重复，未知不自动重放，明确未发允许有界重试。 |
| RT-07 / P1 | **工作创建和并行子任务幂等键。** 当前 `WorkService.create` 每次随机生成任务 ID，`work_start/work_parallel` 依赖模型不要重复及每轮最多 8 项。为同一 tool-call/batch item 增加持久化 operation key，区分“同请求重试”与“用户明确再做一遍”。本轮未伪造模型重试事故。 | 模型/会话恢复重复同一调用只生成原来的子任务；并行批次中途写盘失败后仅补未创建项；新用户请求仍能新建。 |
| RT-08 / P1 | **调度公平性与背压。** `TaskScheduler.drain` 顺序 await 单任务；补充探针在同账号、两个不同且均已授权的私聊中确认：观察 205 ms 时第二会话的到期任务仍未提交，释放第一会话后才执行。这证明当前存在跨会话队头阻塞，不把有限观察窗说成已观测无限挂起。按账号/会话保序，跨会话有界并行；给简单提醒与长 Agent 任务独立配额，显示排队延迟。 | 慢模型任务不能无限挡住另一个会话的简单提醒；同一会话发送顺序与 ACK 语义保持；集中到期、离线恢复和取消时不形成突发群发。 |
| RT-09 / P1 | **统一可靠写入实现。** `atomicBytes` 有 fsync，`atomicJson` 没有；两者均可能在 Windows 重命名冲突时同步等待最多 310 ms。统一持久化等级，重要意图/回执 fsync；采用单写者异步队列或专用存储进程减少主事件循环停顿。不能仅凭缺少 fsync 声称已经丢数据。 | 真实子进程 kill 和故障注入验证旧/新文件完整性；500/5000 任务与大工作索引下测 p95/p99 写入和提醒延迟；所有路径保留原文件，失败后停止后续副作用。 |
| RT-10 / P1 | **长运行终止与取消预算。** 工作操作已有 200 次工具上限、队列 20、并行上限和单命令超时；但会话等待/清理依赖原生 Agent 合作。补总 wall-time、无进展、工具循环和模型费用预算，并区分等待用户/等待外部任务。 | 永不 idle 的合成 Agent、无效重复工具循环、断线和取消都能有界停止；仍运行的外部操作不被伪报完成；继续工作使用原会话证据。 |
| RT-11 / P2 | **调度时间政策明示。** 实测纽约 2026-03-08 的 02:30 转到 03:30；回拨日 01:45 EDT 后请求 01:30 直接到次日，跳过当日第二次 01:30。上海默认无此问题，支持 IANA 时区就应明确策略。 | 明确 DST 缺失/重复时间、系统时间回拨、休眠跨期、时区更新政策；保留周期合并；为每种政策设时间向量测试及用户可读下一次时间。 |
| RT-12 / P1 | **统一 capability manifest。** 注册、延迟发现、持久化、UI 名称、权限判定、结果分类目前多处维护，RT-01 已证明漂移。manifest 应含能力名、只读/写入、权限、幂等、schema 版本、超时/取消、结果类型；服务端仍逐次核验权限。 | 所有已注册能力在历史解码、日志/UI 和评测目录可映射；延迟加载不扩权；聊天/工作/内部处理/owner 权限矩阵全覆盖，账号切换后的旧调用拒绝。 |
| RT-13 / P2 | **重载和异常隔离粒度。** 整个 `WorkStore` 失败会中断 `WechatChannel` 构造；可提供只读诊断/导出和受影响子功能降级，避免一个历史条目使全部聊天无法启动。不可静默丢掉坏记录或清空存储。 | 一个损坏工作事件能定位到文件/记录，健康功能按明确策略运行；未知副作用保持封锁；修复后恢复原工作记录，不启动历史命令。 |
| RT-14 / P2 | **历史索引与保留窗口。** scheduler tasks/runs、work jobs/operations、朋友圈动作日志会持续累积；列表截断不等于磁盘或内存有界。先测数据量曲线，再考虑分段 journal、快照或 SQLite 单写者；去重凭据/回执保留独立于展示历史清理。 | 1 万/10 万记录加载、检索、内存与写放大基线；历史清理后 ACK、幂等键及 tombstone 不丢，旧未知状态不被重新执行。 |
| RT-15 / P1 | **真实边界分层验收。** 合成 ACK 和原生 SDK 已覆盖大量逻辑，仍应准备 opt-in 测试账号/测试会话的真实接收、文本/多媒体发送、断线、换账号、朋友圈只读/写入及回读；外部写入必须使用明确指定范围。 | 报告分列 offline、native fixture、live model、live WeChat；逐项保留服务端 ID、内容 hash、准确目标和取消结果，凭据与原聊天正文不进入公开报告。 |
| RT-16 / P2 | **能力可用性与失败解释。** 媒体/朋友圈能力 readiness、协议支持、服务错误、空数据、范围未覆盖是不同情况；已有多处细致区分，应统一错误类别和 UI 展示，避免“不可读取”变为“没有”。 | 模拟未支持、权限不足、账号变化、空页、分页未覆盖、429/超时/协议错误；每种输出可判读且不会触发误重试，源错误细节不泄露凭据。 |

## 5. 现有能力应保留的运行时不变量

这些已经存在，不应当作为“还没有做”的优化重复提出：

- 微信成功以有效服务端 ACK 为准；多段部分成功、未知结果保留，恢复流程拒绝已确认段的重复发送。
- 朋友圈写入已在调用前持久化意图，内容 hash 与稳定请求 ID 绑定；重复请求复用确认结果，未知不自动重做；发布核对使用真实回读或已保存删除回执，不靠“页面没读到”推断删除。
- 当前账号、会话、发起人和管理员权限多次核验；执行期间撤权/换号会阻止继续执行或回传。延迟加载工具不会增加授权。
- 原生工作保留 DSH 默认模型、预设和工具；普通聊天、内部处理、视觉与工作任务分别组织上下文，不能为了统一 harness 把所有权限放入一个全能 Agent。
- 工作执行结果与微信回传状态分离；命令非零退出、超时、取消有实际执行证据。已有文件返回副本并验证字节，工作会话续接保留原 Session。
- 定时提醒已支持真实群成员 @、重启前后确认记录、明确未发的延迟重试、未知暂停、取消晚到 ACK 保存和漏过周期合并。
- 朋友圈互动已保存选定候选、逐条状态和回执；跨轮次与重启防止重抽、重赞或重评论，手动/自动流程共享边界。

## 6. 功能覆盖与仍需补齐的证据

| 实际功能 | 本轮覆盖 | 尚未证明的范围 |
| --- | --- | --- |
| 模型选择、推理强度、原生 create/resume、空回复恢复、取消 | 原版 native 76 请求通过 | 真实模型质量、实际账户配额与网络错误频率 |
| 会话自然接话、默认回复、搜索/任务/图片工具、重启去重 | 原版 native、主审计全量回归 | 真微信接收和真实发送 ACK |
| 工作启动、子任务并行、原生文件/PowerShell、成果回传 | 适配原生夹具 49 断言通过；原版夹具待修 | 真实 SSH/VS Code 目标、长期无人值守、插件升级后真实 profile 的恢复 |
| 工作继续、桌面已加载 Session、历史归并、撤权与权限变更 | 适配原生夹具实际 SDK 验证 | 多版本 DSH 升级兼容性和系统级资源故障 |
| 文本/文件/图片回执与补发 | 主回归与原生合成逐段 ACK；worker 故障探针 | 实际大文件吞吐、微信限流、晚到 ACK 网络条件 |
| 一次性/每日/间隔提醒，Agent 任务及 @ | 真实一分钟测试、主回归、持久化/公平性/DST 探针 | 多日运行、系统休眠、跨 DST 真时钟运行、批量到期性能 |
| 远程电脑与 DSH 任务查询 | 适配 remote 原生 10 项，真实只读本机状态 | 用户实际远程工作环境；原版夹具门禁仍失败 |
| 朋友圈读/评论列表/赞/评/回复/发布/删除/屏蔽/计划 | 原版 native 和适配 work 工具链，协议/自动化主回归 | 本轮真实图文整帖、服务器可见范围、视频上传/媒体下载等未接通能力 |
| 朋友圈素材、图片理解、自动互动、发布核对 | 主回归、native 图像工具/自动设置；存储重载探针 | 真实内容质量/隐私误判率、多天自动化、人类核对过的误触发数据集 |

建议顺序：先修 RT-01，并以回归测试守护已修复的图片时间与权限边界，随后修 RT-02/RT-03 和原版门禁；再实施副作用状态统一、取消收敛、调度公平性与性能基线。框架重写应放在这些证据之后，避免引入第二套调度/会话/权限中心。
