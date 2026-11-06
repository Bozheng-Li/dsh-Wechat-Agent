# 开发、验证与发布

[产品首页](https://github.com/Bozheng-Li/dsh-Wechat-Agent#readme) · [使用指南](USER-GUIDE.md)

## 构建与验证

需要 Windows x64、Node.js **22.18 或更高版本**和 npm。先克隆本仓库，在根目录运行：

```powershell
git clone https://github.com/Bozheng-Li/dsh-Wechat-Agent.git
cd dsh-Wechat-Agent
npm ci
npm test
```

`npm test` 构建服务端、管理页面和协议子进程，并运行插件回归测试；单独构建使用 `npm run build`。这两项不需要登录微信、安装 DSH 或准备微信二进制组件。测试数据写入本仓库的临时目录，不使用个人会话。

本次验证结果及发布状态见 [0.2.0-preview.4 验证记录](VERIFICATION-PREVIEW-4-2026-11-06.md)，此前的 [0.2.0-preview.3 验证记录](VERIFICATION-PREVIEW-3-2026-11-06.md)和 [2026-11-06 验证记录](VERIFICATION-2026-11-06.md)继续保留。

可单独运行真实一分钟计时测试，使用本地模拟传输，不连接微信：

```powershell
node scripts/test-scheduler-clock.mjs
```

脚本通过聊天请求创建任务，使用实际时钟与调度循环等待一分钟，核对提醒仅执行一次并在回执后完成，结果保存到 `storage/logs/scheduler-clock.json`。本次隔离验证的实际触发用时为 60.569 秒，未发送真实微信消息。群维护通知保持关闭。

微信协议与登录代码位于 `src/wechat/` 和 `runtime/`；插件入口、页面与任务处理位于 `src/`，构建产物位于 `lib/`，测试位于 `tests/`。原项目来源为 [wechat-agent](https://github.com/2720480371/wechat-agent)，沿用 AGPL-3.0-or-later。

### 构建完整安装包

完整包额外需要可运行 pip 的 Python，以及自备的、与已验证清单匹配的微信 3.9.12.51 x64 组件目录。目录内应直接包含 `WeChat.exe`、`WeChatWin.dll` 等组件；脚本会校验核心文件的大小和 SHA-256。微信专有二进制文件不存入 Git，源码仓库不提供其下载地址。

```powershell
npm run engine:prepare -- 'D:\你的微信组件目录'
npm run pack:plugin
npm run audit:package
```

完整包输出到 `release/dsh-plugin-wechat-agent-0.2.0-preview.4.tgz`，同目录提供 `.sha256` 校验文件。打包脚本下载并校验 Python 3.13.9 嵌入版，安装 `runtime/requirements.txt` 中固定版本的依赖。只打包显式列出的运行文件、更新日志、说明和许可证，排除开发脚本、个人配置、登录资料、存储和测试入口。

若 Python 自动下载超时，可将从 [Python 官网](https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip) 取得的 `python-3.13.9-embed-amd64.zip` 放入 `storage/cache/` 后重试；脚本会验证相同的固定 SHA-256。

`lib/`、`release/`、`storage/`、`node_modules/`、本地 Python 和微信组件均被 Git 忽略。不要直接使用 `npm pack` 作为完整安装包；使用上面的 `pack:plugin` 命令准备全部运行资源。兼容命令 `dsh:build`、`dsh:test`、`dsh:pack` 仍可使用。

本地未发布构建可使用 `npm run pack:plugin -- --output-dir release/unreleased`，再用 `npm run audit:package -- release/unreleased/dsh-plugin-wechat-agent-0.2.0-preview.4.tgz` 审计指定文件。输出目录与已发布包分开，打包不会自动发布或升级正在运行的插件。维护者可用 `node scripts/download-builtin-stickers.mjs` 从固定上游版本重新取得原图；常规构建只校验本地图片，不联网下载表情。

发布时先完成测试、完整打包和包审计，再发布已验证的压缩包：

```powershell
npm publish ./release/dsh-plugin-wechat-agent-0.2.0-preview.4.tgz --access public --tag latest --registry=https://registry.npmjs.org/
npm run verify:npm -- --wait --download --write-index
```

源码 `package.json` 保留 `private: true`，防止误把不含完整运行环境的源码目录直接发布；完整打包阶段会去除此标记与开发依赖、脚本。`latest` 指向当前公开预览版，版本名仍明确标记 `preview`。

npm 返回接受上传后可能继续后台处理，版本元数据与下载节点也可能分批就绪。验证命令会等待正式版本、实际下载并比对完整压缩包，然后使用 npm 返回的真实发布时间更新 `market/index.json`；确认成功后再推送索引或升级正在运行的实例。

### 可选原生验证

安装 Python 测试依赖后，可离线验证登录边界；已有 DSH 0.2.1-rc.5 安装时，可验证真实 DSH Agent/Session 服务接入：

```powershell
python -m pip install -r runtime/requirements.txt
npm run test:python
npm run build
npm run test:native -- 'D:\你的DeepSeek-Harness安装目录'
```

原生测试使用隔离目录和本地测试模型，不登录微信、不发送真实消息。真实账号扫码后的接收、模型回复和微信服务端确认仍需在用户自己的授权会话中联调。

界面测试使用合成会话、真实存储/RPC 和隐藏的 Electron 浏览器，验证搜索、设置、记录分页及宽窄窗口。提供本机 Electron 可执行文件路径即可运行：

```powershell
npm run test:ui -- 'D:\你的Electron目录\electron.exe'
```

截图和结果保存在 `storage/logs/ui-preview/`，不访问真实微信账号。React 与 ReactDOM 是此测试的开发依赖，插件运行时仍使用 DSH 提供的 React。

只检查全局视觉、动效偏好、明暗对比度及 320–1024 像素响应式布局时，可设置 `WECHAT_UI_TEST_VISUALS_ONLY=1` 后运行同一命令。此模式仍使用隔离会话，截图与结果保存到 `storage/logs/visual-refresh-preview/`；完成后清除该环境变量，再运行完整交互验收。
