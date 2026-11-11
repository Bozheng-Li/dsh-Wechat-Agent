# 代码结构与维护入口

源码按前端、后端支持、功能模块、提示词和共用契约分开。功能模块各有自己的目录，记忆模块再按会话、长期、图片和查询拆分。页面通过 RPC 使用后端，共用同一份授权、队列和发送状态。

```text
dsh-Wechat-Agent/
├─ frontend/                     管理界面
│  ├─ index.jsx                  DSH 浏览器入口
│  ├─ components/                公共组件
│  ├─ hooks/                     轮询、草稿和工作台操作
│  ├─ pages/                     各功能页面，每项独立目录
│  ├─ shared/                    RPC 客户端和表单转换
│  └─ styles/                    样式和主题
├─ backend/                      运行与平台支持
│  ├─ index.mjs                  DSH 服务端入口
│  ├─ worker.mjs                 Worker 构建入口
│  ├─ app/                       插件装配、生命周期、运行服务
│  ├─ rpc/                       权限入口和操作注册
│  ├─ config/                    YAML 读取、校验与配置事务
│  ├─ storage/                   状态、原子写入、备份和目录迁移
│  ├─ platform/                  包资源定位
│  └─ wechat/                    Worker、IPC、微信协议与传输
├─ modules/                      功能模块
│  ├─ agent/                     模型执行、身份、人设输入、管理操作
│  ├─ conversation/              接收、排队、回复、自然陪聊、管理操作
│  ├─ memory/
│  │  ├─ conversation/           会话窗口和压缩
│  │  ├─ long-term/              长期事实、提取和编辑
│  │  ├─ images/                 图片保存、查询和读取工具
│  │  ├─ query/                  组合记忆查询工具
│  │  └─ actions.mjs             记忆管理操作
│  ├─ media/                     素材库、内置表情、格式校验、管理操作
│  ├─ moments/                   动态、评论、好友点赞、计划发布与独立朋友圈素材库
│  ├─ tasks/                     调度、对话任务工具、管理操作
│  ├─ tools/                     模型工具统一注册、原生 tools 列表、工作会话与并行调度
│  ├─ work/                      独立工作队列、DSH 执行能力、结果与回执
│  ├─ remote/
│  │  ├─ authorization/          全局／会话管理员策略和 Owner 操作
│  │  ├─ commands/               明确查询指令解析
│  │  ├─ intent/                 自然文字准入与有限只读意图解析
│  │  ├─ computer/               固定只读系统状态查询
│  │  ├─ tasks/                  现有 DSH Agent 状态快照
│  │  └─ service.mjs             权限复核和结果格式化
│  ├─ search/                    联网搜索
│  ├─ digests/                   群聊简报
│  ├─ recovery/                  发送恢复
│  ├─ diagnostics/               运行检查
│  └─ workbench/                 工作台协调、存储和共用函数
├─ prompts/                      所有模型提示和工具说明
│  ├─ loader.mjs                 UTF-8 模板读取、校验和插值
│  ├─ identity/                  默认全局身份 Markdown
│  ├─ personas/                  唯一默认助手、正文格式化与入口
│  ├─ reply/                     回复规则、任务和组合
│  ├─ conversation/              自然陪聊决策提示
│  ├─ memory/                    压缩、提取、上下文和查询说明
│  ├─ vision/                    看图任务和工具说明
│  ├─ moments/                   朋友圈发布、取材整理及公开性检查
│  ├─ tasks/                     任务工具说明
│  ├─ work/                      编程工作提示和工具说明
│  ├─ remote/                    意图判断提示、查询帮助与固定消息
│  ├─ digests/                   简报生成提示
│  ├─ recovery/                  恢复提示
│  ├─ diagnostics/               检查提示
│  └─ format/                    提示块边界
├─ shared/                       前后端共用契约和纯函数
├─ config.yaml                   安全的默认业务配置
├─ tests/                        回归与测试导出入口
├─ scripts/                      构建、测试与打包
├─ runtime/                      Python 和微信运行资源
├─ assets/                       内置素材
├─ docs/                         使用、开发和结构说明
└─ CHANGELOG.md                  应用和文档共用更新日志
```

## 常见修改入口

| 要修改的内容 | 主要入口 |
| --- | --- |
| 页面与交互 | `frontend/pages/<功能>/`、`frontend/page-content.jsx` |
| 美术与主题 | `frontend/styles/tokens.mjs` 声明变量；`foundation.mjs` 定义控件，`layout.mjs` 定义导航与概览；`automation.mjs`、`content.mjs`、`settings.mjs` 各自负责模块；规范见 [视觉系统](VISUAL-SYSTEM.md) |
| 轮询、草稿和操作反馈 | `frontend/hooks/` |
| 新增管理操作 | 对应 `modules/<功能>/actions.mjs`、`backend/rpc/actions.mjs` 和 `backend/rpc/handler.mjs` |
| 回复触发、排队及发送 | `modules/conversation/{incoming,channel,reply}.mjs` |
| 每次工具执行前的微信提示与独立回执 | `modules/conversation/tool-notices.mjs`、`modules/tools/registry.mjs` |
| 聊天图片完整下载与 JPEG 图像流 | `backend/wechat/protocol/{backend,image-download,media-loader}`、`modules/media/wechat-image-stream.mjs` |
| 默认搜索接口与一次备用回退 | `modules/search/{service,fallback,errors}.mjs` |
| 聊天与工作共用的复杂事实检索规则 | `prompts/agent/factual-search.mjs` |
| 模型请求和正文提取 | `modules/agent/{runner,output}.mjs` |
| 工作模式模型工具列表与注册 | `modules/tools/{index,registry,work-sessions,work-execution}.mjs` |
| 提示词与人设 | `prompts/<功能>/`，默认助手入口为 `prompts/personas/catalog.mjs`，全局语言边界为 `prompts/reply/language.md` |
| 配置字段和保存 | `config.yaml`、`backend/config/repository.mjs` |
| 状态和目录迁移 | `backend/storage/` |
| 记忆和对应工具 | `modules/memory/<子功能>/` |
| 会话与生成图片记忆 | `modules/memory/images/{store,generated,tool}.mjs`、`shared/image-memory.mjs`、`frontend/pages/memory/{workspace,images-page}.jsx` |
| 微信引用消息 | `backend/wechat/protocol/reference.ts`、`shared/message-references.mjs`、`modules/memory/images/references.mjs`、`frontend/pages/records/references.jsx` |
| 提醒、素材、搜索 | `modules/{tasks,media,search}/` |
| 朋友圈素材与发布 | `modules/moments/{material-store,material-privacy,materials,publishing-content,publishing-review,publishing}.mjs`、`shared/moments-materials.mjs`、`frontend/pages/moments/materials-page.jsx` |
| 好友动态与点赞 | `backend/wechat/protocol/moments-user-page.ts`、`modules/moments/{likes,like-requests}.mjs`、`modules/tools/moments-likes.mjs`、`shared/moments-{likes,like-request}.mjs`、`frontend/pages/moments/friends-page.jsx` |
| 朋友圈读图工具 | `backend/wechat/protocol/moments-images.ts`、`modules/moments/image-context.mjs`、`modules/tools/moments-images.mjs`，以实际图片补充评论，纯点赞不读图 |
| 分轮点赞与评论 | `modules/moments/{interactions,interaction-read,interaction-content,image-context,post-content}.mjs`、`shared/moments-interactions.mjs`、`modules/tools/moments-interactions.mjs`、`frontend/pages/moments/{interactions-page.jsx,use-interactions.mjs}` |
| 自动互动设置与周期 | `modules/moments/{interaction-schedule,interaction-selection}.mjs`、`shared/moments-interaction-settings.mjs`、`frontend/pages/moments/interaction-automation.jsx` |
| 自己与好友朋友圈的定时接话 | `modules/moments/{automation,friend-replies}.mjs`、`shared/moments.mjs`、`modules/tools/moments-publishing.mjs`、`frontend/pages/moments/reply-schedule.jsx` |
| 管理员与远程状态 | `modules/remote/`、`frontend/components/admin-picker.jsx`、`frontend/pages/settings/administrators-page.jsx` |
| 微信协议、登录与回执 | `backend/wechat/protocol/` |

## 配置与提示词

定时抓取与回复统一由 `MomentsAutomation`、Owner `moments.configure` 和管理员工具 `wechat_moments_reply_schedule` 管理。`enabled` 控制本人动态评论，`friendRepliesEnabled` 控制好友动态接续，两者默认关闭、独立记录开启时间，共享间隔、天数、风格并各自限额；配置按字段合并。`storage/moments/automation.json` 的 `friendPosts` 保留已评论动态编号，`replies` 按账号、动态、对方评论持久防重。好友回复每轮复查真实详情和完整评论区，必须明确指向当前账号父评论；图文依据通过 `image-context.mjs` 读取，`prompts/moments/friend-reply.md` 接收分清主体的前文，只生成 JSON 文字或跳过理由。发送前再次复查，复用 `MomentsService.writeOwner` 的稳定请求编号和服务端回执；手动回复到达后保留其真实回执，已确认、未知、拒绝及结束话题的记录不会重新提交。清理移除显示文字与图片依据，但保留防重关系。回归入口为 `tests/moments-friend-replies.test.mjs` 与隔离界面测试 `scripts/test-moments-replies-ui.cjs`。

图片记忆共用 `ImageMemory`，通过 `collection: conversation | generated` 区分；未传时保持原会话图片行为，不占用记录已有的 `source` 字段。Owner RPC `memory.images.{list,content,import,configure,delete,clear}` 接受该字段，账号和会话仍由原授权入口校验。生成图另用 `storage/memory/generated-images/<账号哈希>/<生成图会话哈希>/`，在 YAML `imageMemory` 中使用独立键，保留期限、删除标记和清空代次均不混用。

`GeneratedImageMemory` 将经过摘要核验的任务图片复制到记忆库：登记生图或成果、结束扫描原生文件、更新投递回执时同步；打开生成图页和聊天读取前补入历史任务。优先读取 `imageArchives`，兼容 `result.artifacts` 和仍保留的原文件；索引只保存来源元数据。清空对已有任务来源写删除标记，防止再次补入；保存失败不改变任务执行和投递结果。群聊未确认图保留实际发起人边界，逐图回执匹配后才对本群其他成员可读。`wechat_generated_image_memory` 共用于聊天与原生工作，检索不调用模型，读图将实际字节送入隔离视觉请求并复核引用；生成要求不当作视觉描述。

分轮互动通过 Owner 专用 `moments.interactions.{list,preview,edit,generate,run,cancel}` 管理，管理员对话和原生工作共用 `wechat_moments_interact`。`storage/moments/interactions.json` 按 store、账号、实际发起人和请求编号固定选择，编辑与执行校验 revision。生成调用 `prompts/moments/interactions.md`，无工具，只接收本轮真实正文与图片数量；缺少正文不生成图片评价。执行前复查详情内容哈希，写操作复用 `MomentsService` 持久回执；未知结果阻止后续批次和同目标补发，重启仅恢复记录。Owner 的已接受执行属于插件生命周期，页面卸载不会中止或重建；账号变化、停止插件或明确取消仍可停止。清理仅隐藏记录，执行中及未知结果受保护。

自动互动通过同一列表中的 `automation`、Owner `moments.interactions.{configure,stop}` 及管理员工具 `configure_auto/stop_auto` 管理。`storage/moments/interaction-schedule.json` 按账号持久化规则、配置发起人、revision、下次检查和周期编号。保存仅安排未来周期；插件重启重新计时，不补跑。自动选择读取有界候选，按点赞和评论分别核实已操作状态，满足不同额度后固定名单；最多 20 个目标。整轮读取、生成与提交共享 `MomentsInteractions.active`，和手动执行互斥；不复制写入或回执逻辑。停用、修改、账号变化、离线、总开关或授权撤回均在后续读写前检查；已有确认和未知结果跨轮次防重。

好友定时点赞通过 Owner 专用 `moments.likes.{list,configure,run,cancel}` RPC 管理，`storage/moments/likes.json` 按账号保存名单、设置、额度和轮次记录。默认定时关闭、响应聊天请求开启；旧安装缺少文件时使用默认值。`wechat_moments_like_recent` 共用于聊天和工作，普通授权会话仅能给真实发起人自己的动态点赞；管理员可准确指定好友或机器人账号。`shared/moments-subject.mjs` 统一主体契约与协议角色上下文，模型根据语境选择 `speaker/account/contact`，服务拒绝含混代词、重名及角色与联系人混填；通用点赞提交前重新核对动态作者。`storage/moments/like-requests/<哈希>.json` 固定每条消息的目标与动态选择，底层复用原有持久化操作回执。模型不能改变已选目标或扩展条数；重启不重发未知结果，账号、会话授权和请求开关在读取及写入前后复核。

朋友圈素材通过 Owner 专用 `moments.materials.*` RPC 管理，跟随实际登录账号隔离。`storage/moments/materials.json` 保存取材设置、素材、来源时间、处理指纹和使用记录，图片在 `storage/moments/material-images/<账号哈希>/`；不复用聊天表情素材的授权或索引。自动整理与发布共用组件生命周期，各自限时、取消和持久化。原始聊天在遮去已知身份后仅进入整理及检查请求，发布请求只接收已保存的素材目录；压缩摘要不用于增量取材，以免重新整理已删除内容。提交前复核素材版本和来源授权，聊天素材触发成稿公开性检查；配图复制到发布记录目录并校验哈希，只有微信确认后才写使用记录。删除清除素材正文和来源，但保留请求／去重指纹；素材不会因重启或重试恢复。

仓库根部 `config.yaml` 是安装时使用的默认模板。每个实际工作目录有自己的 `config.yaml`，保存授权范围、连接意愿、模型参数、人设选择、会话设置、存储位置、记忆期限和素材开关。页面保存写入同一文件，状态 JSON 保存处理记录、消息确认、任务和索引，不再重复保存这些业务设置。DSH 的模型服务和凭据仍由宿主管理，微信登录资料仍属于运行状态。

自定义账号要求和人设正文写入工作目录的 `prompts/`，YAML 使用 `promptFile` 或人设字段的 `*File` 引用；内容文件先发布，配置最后提交。全局身份默认位于 `prompts/AGENT.md`，路径由 `prompts.identity` 配置。旧根部 `AGENT.md` 首次复制到新位置，原文件保留。

首次加载旧状态会先保存 `channel.before-yaml-<摘要>.backup.json`，再迁移配置；已有的人设备份和 v1 备份继续保留；单一助手迁移另存 `storage/backups/personas.before-single-*.json` 及原状态／YAML，之后的全局自定义内容不重复重置。多个配置／索引文件一起保存时使用事务记录，启动先恢复中断的事务，再载入账号。无效 YAML、账号归属错误、缺失配置或人设引用会明确报错，不静默重置授权。

外部修改 YAML 或它引用的人设正文后，需要重新启用插件加载配置；旧实例不会覆盖这些修改。全局身份 Markdown 沿用下一轮重新读取的行为，编辑页使用版本校验保留冲突草稿。不要在插件运行中删除配置或手工改动 `ownerStoreId`。

固定模板使用 Markdown／JSON，动态组合逻辑和浏览器需要的人设数据也集中在 `prompts/`。新增资源要同步 `package.json.files` 的明确路径；打包只复制这些文件，避免把工作目录中的自定义提示词带进发布包。

## 会话角色卡与分层记忆

`shared/role-card.mjs` 定义卡片字段，`backend/storage/role-cards.mjs` 负责账号／会话身份、原子写入与 revision 校验。角色卡保存在 `storage/memory/role-cards/<账号哈希>/<稳定角色ID>/card.json`；Owner RPC `memory.role.get`、`memory.role.save` 经 `modules/memory/actions.mjs` 校验会话，保存前取消旧回复。界面入口为 `frontend/pages/memory/role-cards-page.jsx`。

`modules/memory/roles/{people,context,retrieval,extraction,reflection}.mjs` 分别维护已观察人物、兼容旧事实、预算投影、逐字来源校验和条件复核。新事实在原 Markdown 元数据中增加 `roleId`、`subjectId`、`subjectName`、`rawClaim`、`reviewReason`；旧无归属事实保留原会话边界，不自动认领。自动预载与旧会话窗口共用 3000 字符，完整资料仍由 `wechat_memory` 查询。`prompts/memory/role-review.mjs` 仅在风险触发时进行一次无工具校对，超时或失败保留草稿。

## 依赖与构建

- `frontend/` 只依赖浏览器组件、共用契约和浏览器安全的人设数据，通过 RPC 调用业务。
- `backend/app/` 装配功能模块；模块不反向导入装配层、RPC 或页面。
- `backend/storage/` 与 `backend/config/` 只使用存储、平台和共用契约，不依赖微信协议或功能实例。
- `shared/` 保持无实例的契约和纯函数；允许使用纯提示常量及人设格式化数据。
- 功能之间显式使用接口，禁止运行时循环依赖；事务和发送流程由原协调对象持有。

构建入口为 `backend/index.mjs`、`backend/worker.mjs`、`frontend/index.jsx` 和 `tests/exports.mjs`。对外入口继续是 `lib/index.js`、`lib/client.js`、`lib/worker.cjs`；`lib/testing.js` 不进入发布包。资源通过 `resourcePath()` 定位，不依赖当前进程目录。

工作模式由 `modules/work/dialogue.mjs` 直接登记用户原话并排队，`runner.mjs` 提交到原生 DSH user 消息。没有前置工作对话模型、额外工作系统提示或微信历史注入；DSH 默认模型、原生预设、上下文和工具保留，执行目录为实际任务目录，并按原生 SDK 要求登记到相同目录的工作区。队列、授权、取消、文件校验和微信确认仍由原服务负责。

`workModelTools({ surface: 'native', ...context })` 统一补充微信工具：`work-sessions.mjs` 提供任务查询、历史、开始、并行、继续和取消，`work-execution.mjs` 提供文件、命令、SSH／VS Code、生图 API 和成果登记；同名工具优先使用实际执行版。`registerModelTools(..., { native: true, inherit: true })` 提供原生函数声明并复核授权，不调用 `restrict()` 屏蔽 DSH 原有工具。旧 dialogue／task surface、`modules/work/tools.mjs` 及结构化生图调用保留兼容用途。

生图参数由执行中的原生 DSH 模型选择，工具说明及 schema 来自当前接口目录，用户请求正文不改写成生图参数。生图解析优先使用非空 base64，空字段有 URL 时读取已有图片，失败只报告实际接口和安全响应摘要。一个任务内相同提示词、接口、模型和尺寸不能通过更换输出文件名重复请求；旧结构化生图任务仍固定已选参数，不自动切换接口或模型。

原生 DSH 按需调用工具取得当前发起人的微信工作历史和任务详情，列表仅返回摘要。继续任务保留原目录；未加载的原生会话可以续接，桌面已打开的会话或写入锁冲突只在提交消息前改开新会话，不取消或修改原 Agent。

`polish.mjs` 在原生执行完成后单独调用聊天 runner 的 `work-result` 模式，使用 `prompts/work/result-polish.md`，实际模型无工具、不继承聊天人设或历史，独立超时为 30 秒。数字顺序、代码块或链接变化、空结果和 API 错误均回退原文；原文、润色状态与最终文字一起留档。`artifacts.mjs` 同时支持显式登记成果和原生工具生成的最终文件快照，发送时重新核验哈希及逐项微信回执，文件字节不经过文字 API。

| 能力 | 原生工具名 | 上下文 |
| --- | --- | --- |
| 任务列表与详情 | `wechat_work_tasks`、`wechat_work_task` | 原生工作会话 |
| 按需读取已确认工作对话 | `wechat_work_history` | 原生工作会话 |
| 创建独立／并行 DSH 会话 | `wechat_work_start`、`wechat_work_parallel` | 原生工作会话 |
| 继续与取消任务 | `wechat_work_continue`、`wechat_work_cancel` | 原生工作会话 |
| 实际生图 API | `wechat_work_generate_image` | 原生工作会话 |
| 列出、读取与写入文件 | `wechat_work_list`、`wechat_work_read`、`wechat_work_write` | 原生工作会话 |
| 本机命令与成果登记 | `wechat_work_exec`、`wechat_work_output` | 原生工作会话 |
| SSH 连接、命令与 VS Code | `wechat_work_ssh_connect`、`wechat_work_ssh_exec`、`wechat_work_vscode_connect` | 管理员原生工作会话 |
| 本机／DSH 状态 | `wechat_work_status` | 管理员原生工作会话 |

共 17 种工具能力；同名工具在各自上下文中只注册一次。生图工具说明与参数来自当前配置目录，密钥继续由凭据服务保管。增加能力时在对应定义文件中添加工具并纳入列表，无需给消息入口增加关键词执行分支。

```powershell
npm run build
npm test
npm run test:structure
```

结构测试校验依赖方向、循环、浏览器边界和源码／构建／安装资源定位。配置专项测试覆盖迁移、外部修改冲突、写入失败与事务恢复。完整命令见 [开发说明](DEVELOPMENT.md)。更新记录统一写入根部 [CHANGELOG.md](../CHANGELOG.md) 的“未发布”，正式版本历史保留。

朋友圈图文读取兼容：`modules/moments/image-stream.mjs` 按 JPEG 标记解析图像边界，排除微信 CDN 的附加元数据；`image-context.mjs` 仍先校验完整下载字节及其 SHA，再将实际图像流交给视觉模型，其他图片入口保留原严格校验。
