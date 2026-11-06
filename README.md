# 微信 Agent · DeepSeek Harness 插件

Windows x64 本地预览版，针对 DSH **0.2.1-rc.5** 验证。安装后在 DSH 侧栏显示“微信 Agent”，支持扫码登录、会话授权和使用 DSH 模型自动回复文本。

[源码仓库](https://github.com/Bozheng-Li/dsh-Wechat-Agent) · [更新日志](CHANGELOG.md) · [第三方说明](THIRD_PARTY_NOTICES.md)

本仓库独立维护 `0.1.0-preview.4` 插件源码。所需微信协议和登录代码已包含在仓库内，构建不依赖原 Wechat Agent 项目。源码提交不代表正式发布；目前没有 npm、插件市场或 GitHub Release 安装包。

## 安装

在 DSH 的插件管理页选择安装本地包，填入完整 `.tgz` 路径。也可以在 PowerShell 执行：

```powershell
dsh plugin --profile desktop add 'D:\下载\dsh-plugin-wechat-agent-0.1.0-preview.4.tgz'
```

包内包含微信认证组件、Python 及依赖，不需要运行 pip、手动配置 Python 或再启动独立的 Wechat Agent 应用。插件不附带个人登录资料或模型密钥。

安装后：

1. 打开 DSH 侧栏“微信 Agent”，扫码并在手机确认。
2. 在“回复模型”直接选择 DSH 已有模型，或保持“跟随 DSH 默认”。选择自动保存，无需另填地址或密钥，登录微信前也可选择。
3. 添加允许回复的私聊或群 ID，勾选“启用自动回复”，保存。
4. 私聊直接提问；群内 @ 已登录账号，或发送 `/agent 你的问题`。

插件默认不登录、不启用回复。登录资料、授权及处理记录保存在 `$DSH_HOME/wechat-agent`（默认 `~/.dsh/wechat-agent`），卸载保留数据，重新安装可继续使用。它使用独立登录资料，不自动迁移或接管独立应用正在运行的微信账号。同一 DSH 数据目录只允许一个插件实例运行。

## 当前范围

- 直接同步 DSH 的共享模型列表和已有认证，可在插件内自行选择，或跟随 DSH 默认模型；不修改 DSH 的全局默认选择。
- 模型选择从下一个任务开始生效，已运行任务继续使用原模型。选择持久保存；所选模型暂不可用时显示原因，不自动改用其他模型。
- 文本自动回复、每个私聊和每位群成员的独立上下文。
- 队列、持久化去重、取消、断线和撤销授权保护。
- 只在收到微信服务端回执后记录发送成功；部分确认或结果不明时不自动重发。
- 插件停止时取消并收尾任务，再关闭自己的微信组件；没有群维护通知。

此版不包含独立应用的知识库、定时任务、图片/语音/文件处理，也不向微信消息开放 DSH 的桌面、文件、终端或其他工具。只处理最近十分钟的新消息；启动同步中的旧消息不会补答。队列最多等待 100 条，超限原因在处理记录中显示。长回复可能分成多条微信消息，服务端回执不代表对方已经阅读。

修改授权或回复要求会取消旧任务；发送已经获得的回执会保留。取消、失败或未确认投递后，下次问题新建上下文，避免把未收到的答案当成已经发送。若 DSH 会话被外部删除，第一次继续会显示失败，下次问题重新建会话。

## 构建与验证

需要 Windows x64、Node.js **22.18 或更高版本**和 npm。先克隆本仓库，在根目录运行：

```powershell
git clone https://github.com/Bozheng-Li/dsh-Wechat-Agent.git
cd dsh-Wechat-Agent
npm ci
npm test
```

`npm test` 构建服务端、管理页面和协议子进程，并运行插件回归测试；单独构建使用 `npm run build`。这两项不需要登录微信、安装 DSH 或准备微信二进制组件。测试数据写入本仓库的临时目录，不使用个人会话。

微信协议与登录代码位于 `src/wechat/` 和 `runtime/`；插件入口、页面与任务处理位于 `src/`，构建产物位于 `lib/`，测试位于 `tests/`。原项目来源为 [wechat-agent](https://github.com/2720480371/wechat-agent)，沿用 AGPL-3.0-or-later。

### 构建完整安装包

完整包额外需要可运行 pip 的 Python，以及自备的、与已验证清单匹配的微信 3.9.12.51 x64 组件目录。目录内应直接包含 `WeChat.exe`、`WeChatWin.dll` 等组件；脚本会校验核心文件的大小和 SHA-256。微信专有二进制文件不存入 Git，源码仓库不提供其下载地址。

```powershell
npm run engine:prepare -- 'D:\你的微信组件目录'
npm run pack:plugin
npm run audit:package
```

完整包输出到 `release/dsh-plugin-wechat-agent-0.1.0-preview.4.tgz`，同目录提供 `.sha256` 校验文件。打包脚本下载并校验 Python 3.13.9 嵌入版，安装 `runtime/requirements.txt` 中固定版本的依赖。只打包显式列出的运行文件、更新日志和许可证，排除开发脚本、个人配置、登录资料、存储和测试入口。

若 Python 自动下载超时，可将从 [Python 官网](https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip) 取得的 `python-3.13.9-embed-amd64.zip` 放入 `storage/cache/` 后重试；脚本会验证相同的固定 SHA-256。

`lib/`、`release/`、`storage/`、`node_modules/`、本地 Python 和微信组件均被 Git 忽略。不要直接使用 `npm pack` 作为完整安装包；使用上面的 `pack:plugin` 命令准备全部运行资源。兼容命令 `dsh:build`、`dsh:test`、`dsh:pack` 仍可使用。

### 可选原生验证

安装 Python 测试依赖后，可离线验证登录边界；已有 DSH 0.2.1-rc.5 安装时，可验证真实 DSH Agent/Session 服务接入：

```powershell
python -m pip install -r runtime/requirements.txt
npm run test:python
npm run build
npm run test:native -- 'D:\你的DeepSeek-Harness安装目录'
```

原生测试使用隔离目录和本地测试模型，不登录微信、不发送真实消息。真实账号扫码后的接收、模型回复和微信服务端确认仍需在用户自己的授权会话中联调。
