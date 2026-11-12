<div align="center">

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/hero.svg" alt="微信 Agent — 把人设、记忆与提醒带进微信" width="100%" />

**把 DSH 的模型、自然接话的助手和持久记忆，带进微信会话。**

[![npm](https://img.shields.io/npm/v/dsh-plugin-wechat-agent?style=flat-square&color=168b70&label=npm)](https://www.npmjs.com/package/dsh-plugin-wechat-agent)
[![Plugin checks](https://github.com/Bozheng-Li/dsh-Wechat-Agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Bozheng-Li/dsh-Wechat-Agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Bozheng-Li/dsh-Wechat-Agent?style=flat-square&color=536c63)](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/LICENSE)

[开始使用](#开始使用) · [使用指南](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/docs/USER-GUIDE.md) · [更新日志](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/CHANGELOG.md) · [反馈问题](https://github.com/Bozheng-Li/dsh-Wechat-Agent/issues)

</div>

<details>
<summary><strong>更新记录 · 0.2.0-preview.11 · 2026-11-12（点击展开）</strong></summary>

### 0.2.0-preview.11 · 2026-11-12

- 所有功能统一检查对象授权；取消授权后自动清理相关本机资料，启动时补齐历史清理，清理失败保留原因和重试。
- 人物卡仅在有实际资料时创建，按微信标签分组并优先显示资料较多的人；群授权不扩展为成员的私聊或人物资料授权。
- 新增“设置 → 自动功能”、统一时间设置、执行倒计时与任务轨迹，工作任务支持开工确认和阶段进度。
- 同步微信收藏与聊天表情；朋友圈多图分批识别，图片部分失败时依据可用图片或真实正文继续处理。
- 修复启动清理的配置错误、未处理异步异常和组件握手超时；优化会话定位与后台记忆巡检。

### 0.2.0-preview.10 · 2026-11-11

- 朋友圈生成与发布统一最多等待 1 小时，页面可主动停止；聊天触发发布也不再被普通聊天时限提前打断。
- 生图失败、图片丢失或联网取材失败时回退到可独立阅读的纯文字，保留原因；取消和未知回执不会触发重发。
- 修复主题名称必须逐字匹配导致正常选题被拒绝的问题。

### 0.2.0-preview.9 · 2026-11-11

- 统一默认助手，Agent 根据聊天自动维护每个人的角色卡；私聊、群聊和朋友圈共享称呼、喜好与有来源的长期信息，后台更新不阻塞聊天。
- 上下文和工具按需加载；会话图片与生成图片独立保存，可按普通文字追问最近已发图片。
- 工作模式支持独立任务、继续与取消、文件成果和多接口生图；复杂公开事实可主动检索并在接口失败时回退。
- 朋友圈整合素材、发布计划、点赞和定时回复，支持接续好友评论对话，并按真实回执核对发布与删除状态。
- 更新明暗工作台、窄窗口布局和按勾选批量授权；清理已结束的实验脚本，修复图片跨轮次时间限制。

### 0.2.0-preview.8 · 2026-11-08

- 修复保存的人设与恢复会话上下文，加入模型推理强度选择、相关记忆筛选和后台压缩。
- 更新工作台与记忆页面，移除知识库功能，保留已有本地资料。

[完整更新日志](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/CHANGELOG.md) · [GitHub 安装包](https://github.com/Bozheng-Li/dsh-Wechat-Agent/releases/tag/v0.2.0-preview.11) · [npm 版本](https://www.npmjs.com/package/dsh-plugin-wechat-agent/v/0.2.0-preview.11)

</details>

## 一个伙伴，多种相处方式

所有会话共用一位默认助手：日常自然接话，工作时把事情说清楚。保留一个全局自定义入口，各会话分别设置参与方式、保存记忆，也能在约定的时间提醒你。

| 能力 | 你可以这样用 |
| --- | --- |
| **默认助手** | 在全局设置中自定义名字、唤醒词和表达偏好，所有会话共用。 |
| **共同的身份与语言** | 全局身份保存共同约定；所有对外回复遵守同一份语言边界，减少机械开场、空泛夸奖和客服式收尾。 |
| **人物角色卡与记忆** | 按微信身份共享一张人物卡，后台 Agent 自动总结称呼、喜好与长期资料；有实际资料才建卡，按微信标签分组并按资料项数排序；仅使用已授权人物的资料。 |
| **按需上下文** | 近期对话接住上下文，旧事实、图片笔记和工具说明按需要查询与展开；保留管理员的明确约定。 |
| **自然加入群聊** | 保留 @、`/agent`、昵称与数量设置，结合时间、话题和互动反馈择机参与，逐群控制。 |
| **图片记忆** | 会话图片与生成图片独立保存，短句追问可接上最近已确认发出的图片。 |
| **看图与表情回复** | 普通图片按需查看；同步微信收藏、收集聊天表情，保存含义与使用情景，由模型自然选择原生表情回复。 |
| **把约定变成提醒** | 聊天中安排一次、每天或间隔任务，到期在授权会话发送消息，并真正 @ 群成员。 |
| **查资料，带上来源** | 复杂或有时效性的公开事实可主动检索；支持 Tavily 与 DeepSeek 原生搜索，默认接口失败时尝试已配置的备用接口。 |
| **工作模式** | 明确委托后使用独立 DSH 工作会话，支持并行任务、查询、继续、取消和文件成果；需要聊天依据时按当前会话范围查询，执行与送达状态分别记录。 |
| **生图 API** | 配置多家兼容 `/images/generations` 的接口、模型与独立密钥，按指定接口生成并回传图片；保存实际提示词、图片原件与送达回执。 |
| **管理员远程查询** | 添加全局或会话管理员，授权后通过聊天查看电脑与 DSH 任务状态，或连接已配置的远程环境。 |
| **朋友圈** | 查看动态与评论，安排发布、点赞和回复；可分别开启回复自己动态的评论与接续好友评论对话。发布、屏蔽范围和删除均可按真实回执核对。 |
| **朋友圈素材库** | 保存随手记、图片与聊天启发，支持取材、整理和更新想法；到发布时间再选择可用内容，检查隐私、停用、到期、已用和删除状态。详见[使用说明](docs/USER-GUIDE.md)。 |

## 开始使用

本页对应 **`0.2.0-preview.11`**，支持 **Windows x64 · DeepSeek Harness `0.2.1-rc.5`**。模型使用你在 DSH 中配置的服务。

当前源码整合全局人物角色卡、分层记忆、按需上下文、图片记忆、工作模式和朋友圈自动化。模型仍可能补写事实或未完整遵守人设，具体限制见[使用指南](docs/USER-GUIDE.md#当前版本与已知限制)，版本历史可展开上方更新记录。

在 DSH 插件管理页输入 `dsh-plugin-wechat-agent` 安装，或在 PowerShell 执行：

```powershell
dsh plugin --profile desktop add dsh-plugin-wechat-agent@0.2.0-preview.11
```

完整 npm 包包含微信认证组件、Python 与依赖，安装后即可打开侧栏 **微信 Agent**。[GitHub Releases](https://github.com/Bozheng-Li/dsh-Wechat-Agent/releases/tag/v0.2.0-preview.11) 提供相同安装包及 SHA-256 校验文件。

1. **扫码连接** — 用手机微信扫码并确认。
2. **设置助手与模型** — 选择 DSH 模型及其支持的推理强度，在“默认助手”中编辑所有会话共用的设定。
3. **授权会话** — 按微信名、备注或群名查找，选中会话，再到“设置 → 自动功能”开启自动回复。

首次安装的自动回复默认关闭，由你选择会话授权范围；表情库使用账号自己的微信收藏与聊天表情。

业务设置统一保存在工作目录的 `config.yaml`，人设和全局身份正文位于 `prompts/`。旧配置首次加载时备份并迁移，原授权和记录保留；统一为默认助手前会备份旧人设，之后的全局自定义内容不重复重置。外部修改 YAML 或它引用的人设文件后重新启用插件生效。源码维护入口见 [代码结构说明](docs/CODE-STRUCTURE.md)。

<details>
<summary>通过 DSH 自定义插件市场搜索安装</summary>

在“插件 → 实验性插件 → 更多 → 自定义插件市场”添加以下索引，搜索“微信”或 `wechat` 安装：

```text
https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/market/index.json
```

DSH `0.2.1-rc.5` 使用用户添加的自定义索引。索引提供版本目录，完整插件从 npm 下载。

发布新版后，需要重新加载插件市场中的版本列表，再选择新版本安装或升级。已安装的插件不会因 GitHub 更新而自动替换；npm 的 `latest` 标签与市场索引都在安装包发布并校验后更新。如果仍显示旧版，可使用上面的明确版本命令安装本版。

</details>

升级提醒：本版会按当前授权自动补清理历史未授权对象的本机资料。需要保留的人物请在升级前核对并补齐私聊授权；群聊授权不包含群成员的个人资料。取消授权会永久清理相关本机记忆、任务和记录，重新授权从新资料开始。

## 日常使用，在一个工作台里

连接、会话、记录、朋友圈、定时任务、工作、简报、记忆、素材和设置使用中性明暗主题。页面按内容组织：记录是连续数据行，记忆是文档，素材是图库，任务突出成果与执行过程，设置使用分组表单。颜色用于区分处理中、已完成、待核对与失败，状态保留文字。窄窗口通过可展开目录切换页面，支持键盘操作，动效跟随系统的“减少动态效果”设置。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-overview-light.png" alt="工作台：当前微信账号、回复状态、配置与常用工作区" width="100%" />

“设置 → 自动功能”集中管理自动回复、朋友圈自动操作、表情收集、人物整理与图片记忆保存；“设置 → 时间设置”统一调整周期和等待时限。任务与自动安排显示倒计时，执行轨迹用于核对模型、工具和回执。

## 全局共用助手，记忆各有归属

默认助手保留一个全局自定义编辑入口，恢复默认正文先修改草稿，保存后才生效。人物角色卡由独立后台 Agent 根据授权聊天自动填写，保存称呼、关系、喜好与逐字来源；同一微信身份跨私聊、群聊和朋友圈共用一份。新称呼、更正、累计新消息和定期检查会触发整理，也可通过工具安排更新。管理页面用于查看依据、手动触发整理和纠正资料。仅姓名或发言记录不单独建卡；有资料的人按微信真实标签分组，无标签的人进入“未标签”，默认资料较多的在前。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-persona-editor-light.png" alt="默认助手设置：全局正文、名字与唤醒词" width="100%" />

记忆库集中管理会话上下文、角色卡、全局备注、人物事实、会话图片和生成图片。默认保存窗口为 100000 字符，可按群自定义；普通接话优先使用近期对话，旧记忆按相关性筛选或按需查询。达到窗口后在后台整理，临时失败保留原文并自动重试。更正、转述和图片资料保留待确认状态；切换标签保留未保存草稿，文件无法安全读取时显示原因并暂停编辑。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-memory-light.png" alt="长期记忆工作区：共同备注、来源会话事实与记忆概况" width="100%" />

## 认真记下，也按时提醒

“微信助手，一分钟后提醒我吃饭。”保存成功后，约定进入当前任务列表。执行、取消与过期结果归入历史，每项一行，展开即可核对内容和真实回执。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-tasks-light.png" alt="定时任务历史，可展开查看执行结果和回执" width="100%" />

## 给聊天一点表情

同步自己的微信收藏，收集聊天里的表情，按账号保存原图、含义和适用情景。模型先读取表情库，再按语境决定是否发送，不需要每次明确要求。优先原生发送并保留动画；接口不可用时才用保存的图片替代。也可自行导入 ZIP、修改情景说明和设置发送间隔。

收藏同步与随机试发位于“素材 → 表情包”页；聊天收集与自动使用开关集中在“设置 → 自动功能”。试发目标固定为当前账号的文件传输助手。旧版网上内置表情已移除。

以上应用截图来自本版界面的真实渲染，使用隔离的合成账号与会话；截图验证没有连接真实微信或调用付费模型。[查看深色工作台](docs/images/workspace-dark.png)。

## 消息与数据，都能核对

回复取得微信服务端回执后才记为成功。部分确认或结果不明时保留已知回执，暂停相应任务；发送恢复位于“处理记录”，核对后可处理或整理记录。升级和重启保留授权、设置、记忆与历史。

新版处理记录还显示本轮记忆模式、近期对话条数、预载旧记忆字数及关联线索。按需模式的“预载 0 字”只表示开始回复前没有灌入旧历史，不冒充已完成的记忆查询。

数据默认保存在 `~/.dsh/wechat-agent`，也可指定一个全局工作目录，统一管理身份、会话、记忆、素材与任务。模型请求发往你配置的 DSH 模型服务，开启搜索后公开查询发往选中的 Tavily 或 DeepSeek 搜索服务。

普通图片以 PNG/JPEG 发送；微信原生表情优先保留动画，图片回退时使用静态帧。定时执行需要插件运行、微信在线与会话保持授权。插件读取同步到的新消息；语音、视频、一般文件解析和微信完整历史导入尚未包含。详细行为见使用指南。

## 文档与开发

| 文档 | 内容 |
| --- | --- |
| [使用指南](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/docs/USER-GUIDE.md) | 回复模式、人设、身份、记忆、素材、提醒与目录迁移。 |
| [开发与发布](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/docs/DEVELOPMENT.md) | 独立构建、测试、完整打包、包审计与 npm 发布。 |
| [代码结构](docs/CODE-STRUCTURE.md) | 模块职责、页面与业务入口、依赖边界及维护方式。 |
| [更新日志](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/CHANGELOG.md) | 与应用内共用的版本记录。 |
| [界面与动效](docs/USER-GUIDE.md#界面与动效) | 当前源码的明暗配色、动效偏好与窄窗口布局。 |
| [第三方说明](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/THIRD_PARTY_NOTICES.md) | 原项目、表情作品、运行环境与许可。 |

源码仓库可独立构建与测试。Node.js **22.18+**，执行 `npm ci`、`npm test`；完整安装包的准备方法见开发文档。

本项目源自 [Wechat Agent](https://github.com/2720480371/wechat-agent)，采用 **AGPL-3.0-or-later**。第三方素材与专有组件分别遵循原许可。项目与 DeepSeek、腾讯没有隶属关系。
