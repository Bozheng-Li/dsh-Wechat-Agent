# 模块验收与结果边界 · 2026-11-06

本轮基于 `0.2.0-preview.4` 之后的当前源码审查，以下修复已纳入 `0.2.0-preview.6`。记忆、人设与视觉设计由各自验收记录补充；本记录重点说明其余模块的业务约束、实际执行路径以及证据能证明的范围。

## 本轮发现并修复

| 触发条件 | 原结果 | 修复与当前验证 |
| --- | --- | --- |
| 素材理解尚未结束，用户明确保存空说明；或者将说明改成别的内容后又改回 | 仅比较说明文本，无法识别这些后发生的编辑，迟到的模型描述会覆盖用户最终选择 | 按单张素材的 `revision` 核对任务发起时的版本，已被编辑的素材跳过提交。两个回归在修复前失败、修复后通过；重启后空说明仍保留 |
| 理解第一张素材时，用户编辑另一张素材 | 需要继续保留第一张的有效理解结果，不能因整个素材库版本变化而一并丢弃 | 仅比较该素材版本，独立条目的并发编辑不阻断有效结果；新回归通过 |
| 搜索服务返回 HTTP 200，但声明正文超过 1 MiB，并保持连接继续传输 | 在读取正文前报错，却没有取消正文流，失败查询继续占用连接直至搜索超时 | 拒绝超大响应前取消正文。真实本地 HTTP 流复现了连接未释放；修复后服务端收到关闭事件，检查通过 |
| 用户选择视觉模型后，提供方将该模型当前能力改为纯文本 | 仅检查模型 ID 存在，保存仍返回成功，直到图片处理才失败 | 保存前调用 `visionSelection` 复核能力；已复现原服务返回错误的保存成功结果。统一构建后，配置保留、正常保存、取消和脱敏失败四项服务回归全部通过 |

新增 `tests/module-acceptance.test.mjs` 共 7 项验收：上述 3 项素材并发场景，以及真实本地 HTTP 客户端的分块 JSON 响应与来源限制、拒绝重定向、超大响应释放、响应头之后取消。HTTP 检查使用仅绑定 `127.0.0.1` 的服务和合成凭据，不请求真实搜索账户。

与已有素材库、内置表情和转换检查合跑 **27 项通过、0 项失败**。PNG 原始字节、ZIP 解包、账号隔离、分组开关和保存失败使用实际文件系统验证；GIF/WebP 转换实际启动 Python/Pillow 并核对生成的静态 PNG。该轮直接导入当前源码，没有复用旧 `lib` 的媒体或搜索实现。

执行命令：

```powershell
node --test tests/module-acceptance.test.mjs tests/media-library.test.mjs tests/media-conversion.test.mjs tests/builtin-stickers.test.mjs
```

完整输出、时间与相关源码 SHA-256 保存在本机 `storage/logs/module-acceptance-local.json`。

阶段性统一构建的 Node 全量检查 **337/337 通过**，包括新增四项视觉模型配置服务回归。Python 原生认证回归 **28/28 通过**；DSH 原生接口 **32 项通过**，执行了 17 次合成模型请求，使用本机 DSH `0.2.1-rc.5` 的实际服务和内嵌 Node `24.21.0`。这些原生检查使用隔离 DSH 上下文，未修改运行中的桌面 profile。

本机记录为 `storage/logs/full-audit-node.tap`、`storage/logs/full-audit-python.json` 和 `storage/logs/full-audit-native.json`。原生验证命令需要指定 DSH 安装目录：

```powershell
npm run test:python
npm run test:native -- D:\deepseek-harness
```

真实一分钟定时检查随后通过：从任务开始到提醒请求为 **60,486 ms**，比计划时间晚 **485 ms**；本地回执放行前任务为 `running`，收到确认后才进入 `completed`，持久执行记录为 `sent`。没有提前提醒或重复发送。该检查使用真实 1 秒调度循环、真实时钟与本地传输，真实微信发送数为 **0**；结果保存于 `storage/logs/full-audit-scheduler-clock.json`。

最新构建后的 Electron 界面全流程 **38 项通过、54 张截图、浏览器错误 0**。本轮辅助函数只接受可见且可用的目标，隐藏标签页、闭合 `details`、禁用或只读控件不能被当作可操作证据；昵称配置与完整记忆预览都先实际展开再检查。新版记忆页额外核对了：概况数字和容量条与所选文件一致；默认窗口折叠、保存及会话独立覆盖；真实方向键、Home/End 的焦点和选择；两页未保存草稿和撤销；延迟保存期间选择器和搜索框禁用、恢复后只写原会话；全局保存失败重试；清空会话记忆保留聊天记录与全局备注。

只读检查实际把隔离测试目录中的全局 Markdown 写为 **8,000,001 字节**，触发后端无法安全读取状态；界面显示原因，禁用备注保存、Markdown 修复、清空与提取，但保留重新读取。修复后逐字节核对原文件完全恢复，界面恢复编辑。此过程没有修改运行账号的记忆。已人工查看桌面深/浅色和 430 px 窄屏记忆截图，未见横向溢出或控件重叠。结果为 `storage/logs/full-audit-ui.json`、`storage/logs/full-audit-ui-fixture.json`；截图在 `storage/logs/ui-preview/`。隔离服务记录真实微信发送数与真实模型请求数均为 **0**。

## 全模块覆盖矩阵

下表列出的既有断言已核对实现与测试内容，Node、Python 和 DSH 原生执行结果见上文。后续若继续修改源码，最终结论应对应主验收的最新构建、真实定时器及界面报告，不能把旧报告直接当作新代码已通过。

| 模块 | 需要验证的实际结果 | 已核对的证据入口 | 证据范围与最终检查 |
| --- | --- | --- | --- |
| 扫码与认证交接 | 仅同轮已确认认证和匹配 NewSync 密钥可以形成会话；账号不匹配、过期扫码、未退出的认证过程不应冒充登录成功 | `tests/image-session.test.mjs`、`tests/native_engine_test.py` | 使用原生认证形状的隔离输入，覆盖协议校验和进程交接；当前微信在线状态另由运行实例核对 |
| 连接与进程生命周期 | 旧 Worker 停止、启动失败不显示在线，正常退出保存主动参与进度，实际断连取消旧请求 | `tests/runtime-workspace.test.mjs`、`tests/dsh-plugin.test.mjs`、`scripts/test-dsh-native.cjs` | 启动实际子进程及 DSH 服务；微信网络部分使用隔离实现 |
| 会话授权与账号隔离 | 非授权会话不进入回复；撤销一群只取消该群；切账号后的迟到查询与任务不能修改或发送到新账号 | `tests/plugin-service.test.mjs`、`tests/worker-send-account.test.mjs` | 通过真实服务入口和 Worker RPC 验证，本轮统一回归已通过 |
| 触发规则与消息队列 | `@`、命令、昵称、随机/固定主动参与按规则触发；多条直接问题不丢失；只合并同群的等待主动参与；重启不重放已处理消息 | `tests/reply-modes.test.mjs`、`tests/dsh-plugin.test.mjs`、`tests/storage-v2.test.mjs` | 调用实际 Channel、StateStore 与持久文件；模型及发送结果受控 |
| 发送回执与取消 | 发出请求不能算发送成功；没有有效消息 ID 为 unknown；部分回执保留；取消与最后一个真实 ACK 竞态保留已确认结果 | `tests/dsh-plugin.test.mjs`、`tests/media-channel-integration.test.mjs`、`tests/outbound-media.test.mjs` | 经过实际队列及协议解析，但 ACK 来自隔离传输；不能据此宣称已向真实微信成功投递测试消息 |
| 定时创建、权限与恢复 | 创建幂等、按发起人/会话约束；离线等待；撤权不发；过期不补发；不明发送重启后保持暂停 | `tests/persona-memory-tasks.test.mjs`、`tests/scheduled-features.test.mjs`、`tests/task-mentions.test.mjs` | 覆盖持久调度、Channel 和发送边界，测试时钟可控 |
| 真实时间调度 | 一分钟前不发送，到期只执行一次，等待 ACK 才完成，执行回执持久保存 | `scripts/test-scheduler-clock.mjs` | 真实 1 秒定时循环检查已通过：60,486 ms 触发、晚 485 ms，收到本地隔离 ACK 后才完成 |
| 群成员提醒 | 按真实成员 ID 解析名称，重名要求消歧，执行时复核当前群；不能用显示名文字冒充 `@`，不支持 `@所有人` | `tests/task-mentions.test.mjs` | 实际成员解析与 SendMsg 的 `atuserlist` 封装、重试和 ACK 校验，成员列表受控 |
| 任务历史与界面状态 | 每个任务一行，重复执行可展开；已完成时间使用实际结果时间；取消中保留“正在核对”，不能覆盖迟到 ACK | `tests/task-history.test.mjs`、`scripts/test-ui-driver.cjs` | 纯视图结果断言加渲染检查；实际调度结果由调度集成检查提供 |
| 素材库与上传 | ZIP、分块上传、重复请求与内容校验正确；不同账号和停用分组不参与发送；保存失败不发布半成品 | `tests/media-library.test.mjs`、`tests/builtin-stickers.test.mjs`、`tests/module-acceptance.test.mjs` | 本轮当前源码与文件系统检查已通过 |
| 图片格式与转换 | PNG/JPEG 保留字节；GIF/WebP 明确使用第一帧静态 PNG；转换失败、取消、超时在发送前停止，源素材保留 | `tests/media-conversion.test.mjs`、`runtime/prepare_reply_image.py` | 本轮实际 Python/Pillow 转换检查已通过 |
| 入站图片与原图 | 兼容 `imgmsg`、转义 XML、Uint64 消息 ID；优先原图再完整图片，逐块核对归属与字节；缩略图不能冒充原图 | `tests/inbound-images.test.mjs`、`tests/persona-memory-tasks.test.mjs` | 实际下载器与协议解析，网络数据受控；真实视觉模型理解需另外验证 |
| 图片理解与笔记 | 同一消息的实际图像进入视觉模型；错误可重试，重试可升级缩略图笔记；与其他会话隔离 | `tests/vision-routing.test.mjs`、`tests/persona-memory-tasks.test.mjs`、`scripts/test-dsh-native.cjs` | 原生 DSH 检查实际附件 admission，包括 2400×1600 原图和多张图片顺序；模型语义正确性不能只由 fixture 回答证明 |
| 出站图片协议 | 图片凭据独立于心跳；完整回复先校验；命令、账号、收件人、总长度与分块 ACK 一致；末片缺 ID 不算已发送 | `tests/outbound-media.test.mjs`、`tests/image-session.test.mjs` | 实际协议实现与原生扫码凭据形状的隔离检查；本轮未发送真实微信图片 |
| 聊天/视觉模型与参数 | 选择保存到磁盘；失效提供方不得悄悄回退；温度和 Token 进入请求；视觉路由不改变聊天选择；显式视觉模型能力在保存前复核 | `tests/agent-settings.test.mjs`、`tests/vision-routing.test.mjs`、`tests/model-capability-settings.test.mjs`、`scripts/test-dsh-native.cjs` | DSH 原生请求层及新增四项服务回归均已通过，拒绝和取消后逐字节核对原配置文件 |
| Tavily/DeepSeek 搜索 | 使用所选提供方和独立凭据，发送有界明确查询；认证、限流、无引用结果分别说明；取消不冒充完成 | `tests/web-search.test.mjs`、`tests/module-acceptance.test.mjs` | 本轮真实本地 HTTP 边界已通过；两条远端服务和真实模型调用搜索需主验收补充 |
| 数据目录与迁移 | 账号、授权、回执、记忆、任务、素材、身份文件整体保留；源目录变动或目标不空不发布混合数据；失败恢复原指向 | `tests/workspace-root.test.mjs`、`tests/runtime-workspace.test.mjs`、`tests/storage-v2.test.mjs` | 使用实际临时目录、文件锁、原子写入及真实 Worker 切换，本轮统一回归已通过 |
| 界面保存、取消和错误提示 | 保存失败留住草稿；撤销恢复已存设置；刷新显示持久结果；断开后不展示旧“已连接” | `scripts/test-ui-driver.cjs`、`tests/plugin-service.test.mjs` | 最新隔离 Electron 全流程 38 项通过、54 张截图，包含延迟保存和实际超大文件只读检查；运行实例另由主验收核对 |

## 证据边界与后续核对

- `model.configure` 已在保存前复核显式视觉模型能力，明确返回 `MODEL_NO_VISION` 并保留旧配置。四项服务回归已经在统一构建后通过；这是服务端行为验证，独立于视觉下拉框的过滤。
- `scripts/test-dsh-native.cjs` 的模型为注册到真实 DSH 中的合成 provider，微信传输也为隔离实现。它证明实际原生 API、工具注册、附件入场、持久会话和参数链路正确，不能替代真实模型对记忆、人设和图片内容的语义验收。
- 本轮未向真实微信发送测试消息或图片，也未发送群通知。当前账号在线、图片上传参数存在，与一次真实消息获得服务端投递回执是不同证据；验收结论必须保持这一界限。
