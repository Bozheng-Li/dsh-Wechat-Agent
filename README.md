<div align="center">

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/hero.svg" alt="微信 Agent — 把人设、记忆与提醒带进微信" width="100%" />

**把 DSH 的模型、自然接话的助手和持久记忆，带进微信会话。**

[![npm](https://img.shields.io/npm/v/dsh-plugin-wechat-agent?style=flat-square&color=168b70&label=npm)](https://www.npmjs.com/package/dsh-plugin-wechat-agent)
[![Plugin checks](https://github.com/Bozheng-Li/dsh-Wechat-Agent/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Bozheng-Li/dsh-Wechat-Agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Bozheng-Li/dsh-Wechat-Agent?style=flat-square&color=536c63)](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/LICENSE)

[开始使用](#开始使用) · [使用指南](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/docs/USER-GUIDE.md) · [更新日志](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/CHANGELOG.md) · [反馈问题](https://github.com/Bozheng-Li/dsh-Wechat-Agent/issues)

</div>

<details>
<summary><strong>更新记录 · 0.2.0-preview.9 · 2026-11-11（点击展开）</strong></summary>

### 0.2.0-preview.9 · 2026-11-11

- 统一默认助手，新增每个群聊／私聊独立的会话角色卡；人物事实保留归属、来源与更正记录。
- 上下文和工具按需加载；微信引用、最近已发图片、会话图片与生成图片分别保存并准确关联。
- 工作模式支持独立任务、继续与取消、文件成果和多接口生图；复杂公开事实可主动检索并在接口失败时回退。
- 朋友圈整合素材、发布计划、点赞和定时回复，支持接续好友评论对话，并按真实回执核对发布与删除状态。
- 更新明暗工作台、窄窗口布局和按勾选批量授权；清理已结束的实验脚本，修复图片跨轮次时间限制及工作记录重启读取。

### 0.2.0-preview.8 · 2026-11-08

- 修复保存的人设与恢复会话上下文，加入模型推理强度选择、相关记忆筛选和后台压缩。
- 更新工作台与记忆页面，移除知识库功能，保留已有本地资料。

[完整更新日志](https://github.com/Bozheng-Li/dsh-Wechat-Agent/blob/main/CHANGELOG.md) · [GitHub 安装包](https://github.com/Bozheng-Li/dsh-Wechat-Agent/releases/tag/v0.2.0-preview.9) · [npm 版本](https://www.npmjs.com/package/dsh-plugin-wechat-agent/v/0.2.0-preview.9)

</details>

## 一个伙伴，多种相处方式

所有会话共用一位默认助手：日常自然接话，工作时把事情说清楚。保留一个全局自定义入口，各会话分别设置参与方式、保存记忆，也能在约定的时间提醒你。

| 能力 | 你可以这样用 |
| --- | --- |
| **默认助手** | 在全局设置中自定义名字、唤醒词和表达偏好，所有会话共用。 |
| **共同的身份与语言** | 全局身份保存共同约定；所有对外回复遵守同一份语言边界，减少机械开场、空泛夸奖和客服式收尾。 |
| **会话角色卡与人物记忆** | 每个群聊或私聊分别设置称呼、关系与表达方式；人物事实区分本人和亲友，保留来源、更正链与待确认状态。 |
| **按需上下文** | 近期对话接住上下文，旧事实、图片笔记和工具说明按需要查询与展开；保留管理员的明确约定。 |
| **自然加入群聊** | 保留 @、`/agent`、昵称与数量设置，结合时间、话题和互动反馈择机参与，逐群控制。 |
| **引用与图片记忆** | 按原消息关联引用文字和图片；会话图片与生成图片独立保存，短句追问可接上最近已确认发出的图片。 |
| **看图与表情回复** | 普通图片先保存原图，按当前问题查看；表情包跳过图像理解，可用内置或自备素材回复。 |
| **把约定变成提醒** | 聊天中安排一次、每天或间隔任务，到期在授权会话发送消息，并真正 @ 群成员。 |
| **查资料，带上来源** | 复杂或有时效性的公开事实可主动检索；支持 Tavily 与 DeepSeek 原生搜索，默认接口失败时尝试已配置的备用接口。 |
| **工作模式** | 明确委托后使用独立 DSH 工作会话，支持并行任务、查询、继续、取消和文件成果；需要聊天依据时按当前会话范围查询，执行与送达状态分别记录。 |
| **生图 API** | 配置多家兼容 `/images/generations` 的接口、模型与独立密钥，按指定接口生成并回传图片；保存实际提示词、图片原件与送达回执。 |
| **管理员远程查询** | 添加全局或会话管理员，授权后通过聊天查看电脑与 DSH 任务状态，或连接已配置的远程环境。 |
| **朋友圈** | 查看动态与评论，安排发布、点赞和回复；可分别开启回复自己动态的评论与接续好友评论对话。发布、屏蔽范围和删除均可按真实回执核对。 |
| **朋友圈素材库** | 保存随手记、图片与聊天启发，支持取材、整理和更新想法；到发布时间再选择可用内容，检查隐私、停用、到期、已用和删除状态。详见[使用说明](docs/USER-GUIDE.md)。 |

## 开始使用

本页对应 **`0.2.0-preview.9`**，支持 **Windows x64 · DeepSeek Harness `0.2.1-rc.5`**。模型使用你在 DSH 中配置的服务。

本版整合会话角色卡、分层记忆、按需上下文、图片引用、工作模式和朋友圈自动化。模型仍可能补写事实或未完整遵守人设，具体限制见[使用指南](docs/USER-GUIDE.md#当前版本与已知限制)，版本历史可展开上方更新记录。

在 DSH 插件管理页输入 `dsh-plugin-wechat-agent` 安装，或在 PowerShell 执行：

```powershell
dsh plugin --profile desktop add dsh-plugin-wechat-agent@0.2.0-preview.9
```

完整 npm 包包含微信认证组件、Python 与依赖，安装后即可打开侧栏 **微信 Agent**。[GitHub Releases](https://github.com/Bozheng-Li/dsh-Wechat-Agent/releases/tag/v0.2.0-preview.9) 提供相同安装包及 SHA-256 校验文件。

1. **扫码连接** — 用手机微信扫码并确认。
2. **设置助手与模型** — 选择 DSH 模型及其支持的推理强度，在“默认助手”中编辑所有会话共用的设定。
3. **授权会话** — 按微信名、备注或群名查找，选中会话，再开启自动回复。

首次安装的自动回复和内置表情分组默认关闭，由你选择启用范围。

业务设置统一保存在工作目录的 `config.yaml`，人设和全局身份正文位于 `prompts/`。旧配置首次加载时备份并迁移，原授权和记录保留；统一为默认助手前会备份旧人设，之后的全局自定义内容不重复重置。外部修改 YAML 或它引用的人设文件后重新启用插件生效。源码维护入口见 [代码结构说明](docs/CODE-STRUCTURE.md)。

<details>
<summary>通过 DSH 自定义插件市场搜索安装</summary>

在“插件 → 实验性插件 → 更多 → 自定义插件市场”添加以下索引，搜索“微信”或 `wechat` 安装：

```text
https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/market/index.json
```

DSH `0.2.1-rc.5` 使用用户添加的自定义索引。索引提供版本目录，完整插件从 npm 下载。

</details>

## 日常使用，在一个工作台里

连接、会话、记录、朋友圈、定时任务、工作、简报、记忆、素材和设置使用中性明暗主题。页面按内容组织：记录是连续数据行，记忆是文档，素材是图库，任务突出成果与执行过程，设置使用分组表单。颜色用于区分处理中、已完成、待核对与失败，状态保留文字。窄窗口通过可展开目录切换页面，支持键盘操作，动效跟随系统的“减少动态效果”设置。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-overview-light.png" alt="工作台：当前微信账号、回复状态、配置与常用工作区" width="100%" />

## 全局共用助手，记忆各有归属

默认助手保留一个全局自定义编辑入口，恢复默认正文先修改草稿，保存后才生效。会话角色卡可分别设置每个群聊或私聊的称呼、关系与表达方式；人物事实保留发言者与逐字来源，跨会话共同约定可写入全局备注。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-persona-editor-light.png" alt="默认助手设置：全局正文、名字与唤醒词" width="100%" />

记忆库集中管理会话上下文、角色卡、全局备注、人物事实、会话图片和生成图片。默认保存窗口为 100000 字符，可按群自定义；普通接话优先使用近期对话，旧记忆按相关性筛选或按需查询。达到窗口后在后台整理，临时失败保留原文并自动重试。更正、转述和图片资料保留待确认状态；切换标签保留未保存草稿，文件无法安全读取时显示原因并暂停编辑。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-memory-light.png" alt="长期记忆工作区：共同备注、来源会话事实与记忆概况" width="100%" />

## 认真记下，也按时提醒

“微信助手，一分钟后提醒我吃饭。”保存成功后，约定进入当前任务列表。执行、取消与过期结果归入历史，每项一行，展开即可核对内容和真实回执。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-tasks-light.png" alt="定时任务历史，可展开查看执行结果和回执" width="100%" />

## 给聊天一点表情

**猫咪心情 · 软萌动物 · 元气心情**，三组共 30 张 Microsoft Fluent Emoji 原图，随包提供来源和 MIT 许可证。可以整组启用、单张编辑，也能导入 ZIP 或自己的图片，调整使用概率与间隔。

<img src="https://raw.githubusercontent.com/Bozheng-Li/dsh-Wechat-Agent/main/docs/images/studio-stickers-light.png" alt="素材库：猫咪心情、软萌动物与元气心情三组内置表情" width="100%" />

以上应用截图来自本版界面的真实渲染，使用隔离的合成账号与会话；截图验证没有连接真实微信或调用付费模型。[查看深色工作台](docs/images/workspace-dark.png)。

## 消息与数据，都能核对

回复取得微信服务端回执后才记为成功。部分确认或结果不明时保留已知回执，暂停相应任务；发送恢复位于“处理记录”，核对后可处理或整理记录。升级和重启保留授权、设置、记忆与历史。

新版处理记录还显示本轮记忆模式、近期对话条数、预载旧记忆字数及关联线索。按需模式的“预载 0 字”只表示开始回复前没有灌入旧历史，不冒充已完成的记忆查询。

数据默认保存在 `~/.dsh/wechat-agent`，也可指定一个全局工作目录，统一管理身份、会话、记忆、素材与任务。模型请求发往你配置的 DSH 模型服务，开启搜索后公开查询发往选中的 Tavily 或 DeepSeek 搜索服务。

图片当前发送 PNG/JPEG 静态内容，GIF/WebP 转为第一帧并保留原文件。定时执行需要插件运行、微信在线与会话保持授权。插件读取同步到的新消息；语音、视频、一般文件解析和微信完整历史导入尚未包含。详细行为见使用指南。

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
