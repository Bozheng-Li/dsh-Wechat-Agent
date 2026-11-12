# 开发、验证与发布

[产品首页](https://github.com/Bozheng-Li/dsh-Wechat-Agent#readme) · [使用指南](USER-GUIDE.md)

## 构建与验证

需要 Windows x64、Node.js **22.18 或更高版本**和 npm。先克隆本仓库，在根目录运行：

```powershell
git clone https://github.com/Bozheng-Li/dsh-Wechat-Agent.git
cd dsh-Wechat-Agent
npm ci
python -m pip install -r runtime/requirements.txt
npm test
```

`npm test` 构建服务端、管理页面和协议子进程，并运行插件回归测试；单独构建使用 `npm run build`。完整回归需要 Python 3.13 与上述依赖，未安装 Pillow 会跳过三项实际图片转换检查；CI 在 Node 回归前安装依赖。这两项不需要登录微信、安装 DSH 或准备微信二进制组件。测试数据写入本仓库的临时目录，不使用个人会话。

版本变更与历史验证摘要见 [更新日志](../CHANGELOG.md)，当前产品限制见 [使用指南](USER-GUIDE.md#当前版本与已知限制)。历史报告通过更新日志中的固定 Git 提交链接查阅，不在当前文档目录重复保存。

2026-11-11 各次留存候选的全功能测试、原版门禁失败、隔离夹具适配结果及后续优化验收，见[全功能测试与 Harness 优化方向](架构文档/HARNESS-OPTIMIZATION-2026-11-11.md)。该报告交付审计与30项优化方向，按时间和哈希区分版本，不认证12:26之后的工作树；模拟模型/微信回执和真实外部链路的证据分开记录。

DSH 配置覆盖使用扁平条目（例如 `- id: wechat-agent` 与 `disabled: true`），不使用未被识别的 `override` 包装。插件重载优先使用宿主的正式启停入口；调用 HMR 协调时遵守其 `runExclusive` 事务要求，临时维护命令不留在启动配置里。

维护诊断使用公开的 `loader.entries()` 查看入口状态，磁盘文件通过 SHA-256 校验；磁盘字节与运行中的模块状态分别记录。不要读取 `loader.internal.loadCache` 后调用内部模块的 `createCachedData()`：已执行模块会触发 Node 原生断言并终止整个 DSH 宿主，`try/catch` 无法保护进程。临时入口应在检查结束后从 profile 移除；发生此类崩溃时先备份并停用确切入口，保留账号配置、授权及会话，再验证宿主与微信恢复，不批量禁用其他插件。2026-11-09 的触发与恢复证据见[更新日志](../CHANGELOG.md)。

可单独运行真实一分钟计时测试，使用本地模拟传输，不连接微信：

```powershell
node scripts/test-scheduler-clock.mjs
```

脚本通过聊天请求创建任务，使用实际时钟与调度循环等待一分钟，核对提醒仅执行一次并在回执后完成，默认结果保存到 `storage/logs/scheduler-clock.json`。2026-11-11 本轮隔离验证实际用时为 61.202 秒，晚到 1.199 秒，报告保留在 [runtime/scheduler-clock.json](../storage/logs/harness-audit-2026-11-11/runtime/scheduler-clock.json)；这是初始候选的实际时钟与模拟传输验证，未发送真实微信消息，群维护通知保持关闭。

源码按 `frontend/`（页面）、`backend/`（运行、配置、存储、RPC 和微信支持）、`modules/`（各功能及子功能）、`prompts/`（提示词和人设）与 `shared/`（共用契约）组织。业务配置集中在工作目录的 `config.yaml`，仓库根部提供默认模板。详细职责、迁移机制与维护入口见 [代码结构说明](CODE-STRUCTURE.md)。Python 与登录资源位于 `runtime/`，构建产物位于 `lib/`，测试位于 `tests/`。原项目来源为 [wechat-agent](https://github.com/2720480371/wechat-agent)，沿用 AGPL-3.0-or-later。

工作模式的隔离原生验证：先构建，再运行 `npm run test:work-native -- D:\deepseek-harness`。work-native、work-parallel-native 和 work-tools-native 三个兼容入口共用 `scripts/test-native-handoff.cjs`，加载已安装 DSH SDK、隔离模型与临时目录，不加载用户 profile 或真实凭据。验证原话提交、DSH 默认模型与预设、原生上下文和工具保留、实际任务 cwd、父任务创建并行子会话、真实 PowerShell 命令同时运行、未登记的原生文件自动收集、已有 Word 副本和图片字节与逐项模拟微信 ACK。还验证生图默认及指定接口参数、空响应不重试、纯文字 API 润色与回退、桌面写入锁冲突不影响原 Agent、权限变化隔离及非零退出、超时和取消。不登录微信，不调用真实模型或付费生图服务。

管理员远程查询的隔离原生验证为 `npm run test:remote-native -- D:\deepseek-harness`：在临时 SDK Context 中保留一个等待中的合成 Agent，读取真实电脑与 Agent 状态，并校验原实例、会话和事件序号保持；明确命令不增加模型调用，自然文字仅新增一次隔离意图判断。意图 Agent 无执行工具，严格 JSON 只允许 computer、tasks、task，指定编号必须来自当前输入；查询事实始终由后台读取。权限在判断前、判断后、每次读取和发送前检查，远程记录不进入普通聊天历史或记忆。专项界面检查可设 `WECHAT_UI_TEST_ADMIN_ONLY=1` 后运行 `test:ui`，验证多管理员搜索、群成员来源、会话隔离、开关提示、自然文字示例、移除和失败重试。测试不加载用户的 DSH profile，不发送真实微信消息。

### 构建完整安装包

完整包额外需要可运行 pip 的 Python，以及自备的、与已验证清单匹配的微信 3.9.12.51 x64 组件目录。目录内应直接包含 `WeChat.exe`、`WeChatWin.dll` 等组件；脚本会校验核心文件的大小和 SHA-256。微信专有二进制文件不存入 Git，源码仓库不提供其下载地址。

```powershell
npm run engine:prepare -- 'D:\你的微信组件目录'
npm run pack:plugin
npm run audit:package
```

完整包按 `package.json` 的版本输出到 `release/dsh-plugin-wechat-agent-<版本>.tgz`，本版为 `release/dsh-plugin-wechat-agent-0.2.0-preview.11.tgz`，同目录提供 `.sha256` 校验文件。打包脚本下载并校验 Python 3.13.9 嵌入版，安装 `runtime/requirements.txt` 中固定版本的依赖。只打包显式列出的运行文件、默认 `config.yaml`、`package.json.files` 声明的提示模板、更新日志、说明和许可证，排除开发脚本、实际账号配置、登录资料、存储和测试入口。默认 YAML 必须没有工作目录归属、授权账号或密钥，存储路径必须为相对路径；包审计核对每个提示资源与本地审阅文件的哈希。新增 Markdown／JSON 提示时同步资源清单。

若 Python 自动下载超时，可将从 [Python 官网](https://www.python.org/ftp/python/3.13.9/python-3.13.9-embed-amd64.zip) 取得的 `python-3.13.9-embed-amd64.zip` 放入 `storage/cache/` 后重试；脚本会验证相同的固定 SHA-256。

`lib/`、`release/`、`storage/`、`node_modules/`、本地 Python 和微信组件均被 Git 忽略。不要直接使用 `npm pack` 作为完整安装包；使用上面的 `pack:plugin` 命令准备全部运行资源。兼容命令 `dsh:build`、`dsh:test`、`dsh:pack` 仍可使用。

本地未发布构建可使用 `npm run pack:plugin -- --output-dir release/unreleased`，再用 `npm run audit:package -- release/unreleased/dsh-plugin-wechat-agent-0.2.0-preview.11.tgz` 审计指定文件；版本号随 `package.json` 调整。输出目录与已发布包分开，打包不会自动发布或升级正在运行的插件。表情素材来自运行账号的微信收藏、已授权聊天或自行导入，不再随包下载网上图片；包审计拒绝旧版内置图片混入。

发布时先完成测试、完整打包和包审计，再发布已验证的压缩包：

```powershell
npm publish ./release/dsh-plugin-wechat-agent-0.2.0-preview.11.tgz --access public --tag next --registry=https://registry.npmjs.org/
npm run verify:npm -- --wait --download
npm dist-tag add dsh-plugin-wechat-agent@0.2.0-preview.11 latest --registry=https://registry.npmjs.org/
npm run verify:npm -- --write-index
```

上方为本版发布命令示例；先确认更新日志中的发布阶段和 npm 的实际状态，已发布版本不可覆盖，后续发布必须更新版本号并使用对应的新包。先通过暂存标签发布，完整下载校验通过后才调整 `latest`；先核对标签现值，不覆盖其他维护者正在使用的标签。源码 `package.json` 保留 `private: true`，防止误把不含完整运行环境的源码目录直接发布；完整打包阶段会去除此标记与开发依赖、脚本。`latest` 指向当前公开预览版，版本名仍明确标记 `preview`。

### 仓库文件维护

`docs/` 长期维护使用指南、开发说明和代码结构；图片只保留当前文档实际引用的版本。完成阶段的临时报告可从 Git 历史查阅，必要的功能结论与限制合并进指南或更新日志。尚未提交的文档在核对并处理前保留。

`release/` 是可清理的本地输出目录，打包脚本会重新创建它。包审计和 npm 下载比对需要对应压缩包，清空后先重新打包再运行这些检查；已发布版本的原包需要比对时从 npm 取得，不将后续源码重新构建的包当作当年原包。临时预览包在完成使用后清理，避免持续积累版本副本。清理产物不涉及 `storage/`、登录资料、微信组件、素材或许可证。

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

自动功能集中设置专项可设置 `WECHAT_UI_TEST_AUTOMATION_ONLY=1` 后运行 `test:ui`，核验所有迁移开关、原配置保留、保存失败重试、原页面快捷入口、会话／账号隔离及 1280／430／320 像素布局。报告与截图保存在 `storage/logs/automation-settings-preview/`，测试只使用合成账号和真实存储／RPC，不发送微信消息；完成后清除该环境变量。

会话批量授权专项可设置 `WECHAT_UI_TEST_AUTHORIZATION_ONLY=1` 后运行 `test:ui`。使用合成账号和真实存储/RPC，检查全部授权、全部取消、跨类型勾选取消、筛选范围、保存失败、重复提交与账号切换隔离，并检查 1280、430、320 像素布局；报告和截图保存在 `storage/logs/authorization-preview/`。完成后清除该环境变量再运行其他界面检查。

人物角色卡在构建后运行 `node --test tests/person-role-cards.test.mjs tests/role-memory-production.test.mjs`，验证跨群聊与私聊共用、自动纠正、并发消息、来源验证、重启与取消。`node scripts/test-role-cards-native.cjs D:\deepseek-harness` 使用安装版 DSH SDK 验证独立人物 Agent、聊天不等待后台和朋友圈渐进工具读取；模型与微信回执为合成数据。页面专项设置 `WECHAT_UI_TEST_ROLE_CARDS_ONLY=1`、`WECHAT_UI_TEST_OUTPUT=storage/logs/person-role-ui` 后运行 `test:ui`，核验自动卡、保存失败、账号切换和 1280／430／320 像素布局；完成后清除这两个环境变量。检查保存必须等待服务端确认，编辑框显示草稿不能作为已经保存的依据。

生成图片记忆专项在构建后运行 `node --test tests/generated-image-memory.test.mjs tests/image-memory.test.mjs tests/work-image-storage.test.mjs tests/on-demand-image-understanding.test.mjs`，覆盖任务自动保存、历史补入、两类隔离、删除／到期防恢复、群聊发起人边界、真实字节看图、引用缺图的完整聊天及 Owner RPC。页面专项设置 `WECHAT_UI_TEST_GENERATED_IMAGES_ONLY=1` 后运行 `test:ui`，检查两个图片入口、实际原图预览、检索、独立设置、保存／删除失败和账号切换，报告与 1280／430／320 像素截图保存在 `storage/logs/generated-images-preview/`。测试只使用合成图片、模型和微信回执；完成后清除该变量。

引用停用和回复节奏专项运行 `node --test tests/ignored-references.test.mjs tests/quiet-replies.test.mjs tests/work-observation.test.mjs tests/work-progress.test.mjs tests/inbound-images.test.mjs`：覆盖引用不注入聊天或工作、引用图片不触发下载或后台理解、不支持占位只记录、正常原图描述仍回写、工具重试不刷屏、工作只确认一次并约每 3 分钟汇报真实进展、必要提问和独立最终回执、慢进度不阻塞结果、取消后不发送旧进度或结果。type-57 仅保留基本协议解析和当前文字，历史处理记录仍可展示旧引用。

`test:native` 同时验证 `wechat_generated_image_memory` 的实际 DSH 工具声明、检索、隔离视觉请求与结果返回：不提供微信引用附件，读取独立保存的 2400×1600 合成原图。

微信附件读取功能已按用户要求停用。构建后运行 `node --test tests/received-files.test.mjs tests/worker-send-account.test.mjs tests/work-artifacts.test.mjs tests/quiet-replies.test.mjs`，核对聊天和工作均不注册附件工具、旧 IPC 拒绝下载、文件消息保持安静，以及本机成果发送和旧记录仍可用。安装版 SDK 的 `test:work-native` 同时检查收到附件的请求没有读取工具，原有本机 Word 回传照常验证。保留的底层原型测试与以下历史实验记录不代表功能仍对外开放，不再继续收件兼容实验。

历史附件实验不代表当前对外能力；本版不进行自动附件收件或占位消息恢复，相关底层原型只保留离线回归。

好友点赞专项在构建后运行 `node --test tests/moments-recency.test.mjs tests/moments-subject.test.mjs tests/moments-likes.test.mjs tests/moments-like-requests.test.mjs tests/moments-likes-rpc.test.mjs tests/moments-automation.test.mjs tests/moments-tools.test.mjs`，覆盖主页遗漏新帖、双来源分页与未覆盖范围、主体角色区分、错作者拒绝、真实发起人绑定、聊天／工作工具注册、冻结最新动态、重入与重启、失败／未知回执、名单额度和 Owner RPC。界面专项设置 `WECHAT_UI_TEST_LIKES_ONLY=1` 后运行 `test:ui`，报告与宽窄屏截图保存到 `storage/logs/moments-likes-preview/`。两组测试均使用合成账号、传输和回执，不对真实好友点赞。

2026-11-10 好友点赞最终候选通过 15 个文件、244 项相关回归，另通过 55 次 DSH 原生请求和 8 项界面检查。额外的 `test-native-handoff.cjs` 在稳定基底和候选均于第 310 行的旧工作分流夹具失败，尚未执行到朋友圈；此脚本不计入通过项，由工作分流更新维护。详细范围和证据见 `storage/tmp/moments-likes-install-20261110/deployment-checks.json`。

全页视觉检查使用 `npm run test:visual -- 'D:\你的Electron目录\electron.exe'`，默认覆盖 1280、768、430、375、320 像素的明暗主题，包括全部导航、设置子页、记忆分类与预览、朋友圈编辑、任务历史、新增任务、素材弹窗、发送恢复、登录和读取失败。检查布局溢出、控件名称、标签关联、键盘操作、纯色背景文字对比度及系统减少动效。图片、渐变背景与复杂裁切仍需人工审阅截图。截图和报告保存到 `storage/logs/visual-system-preview/`，测试只访问本机合成会话，不调用真实模型或发送微信消息。

可用 `WECHAT_UI_VISUAL_PAGES` 指定逗号分隔的导航 ID，或用 `WECHAT_UI_VISUAL_WIDTHS` 指定宽度，复验发生变化的页面。含空格的 Electron 路径也可通过 `ELECTRON_PATH` 环境变量传入；需要通用 Electron 可执行文件，不能用打包后的 DSH 应用代替。美术维护入口与各模块范围见 [视觉系统](VISUAL-SYSTEM.md)。

检查 320–1024 像素响应式布局与文字对比度时，仍可设置 `WECHAT_UI_TEST_VISUALS_ONLY=1` 后运行 `test:ui`。结果保存在 `storage/logs/visual-refresh-preview/`；完成后清除环境变量，再运行完整交互验收。
