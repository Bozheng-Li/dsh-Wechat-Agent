# 完整重构验证与本地加载 · 2026-11-07

用户确认目录重构已完成，授权一起验证并加载。本轮使用当前完整源码和正常构建／打包脚本，包含 `app/`、`client/`、`features/`、`storage/`、`platform/` 和 `shared/` 重构，以及此前图片、记忆、提醒和回复可靠性修复。保留未提交修改，不正式发布。

## 验证及发现

- 第一次完整回归 531 项中有一处旧提示词文案断言失败：普通聊天与到期任务测试仍检查旧表述。当前实现已经明确保留管理员指定语言、署名、固定开头和结尾；同步断言后，第二次完整回归 531 项全部通过，没有删除测试或削弱原有优先级检查。
- 模块解析、浏览器与存储依赖边界、运行时循环依赖和嵌套源码／构建／安装目录资源定位通过。`runtime/`、内置表情、更新日志与发布入口从包根目录定位，兼容入口与数据路径保持。
- DSH 原生接入 47 项通过，35 个隔离 provider 请求；检查实际 Agent/Session/工具路径、模型输出额度、提示隔离、图片选择与视觉子调用、配置快照、长回复及模拟服务端 ACK。收到图片只保存，接收时零视觉请求；选图时一次独立视觉请求，结果回存原会话。表情包不参加视觉处理。
- Python 28 项通过。主界面 46 组通过，72 张截图；工作台 22 组通过。两套界面均无浏览器错误，涵盖保存、草稿、删除确认、分群资料、窗口设置、提醒、知识库、发送恢复及宽窄布局。
- 打包时新增的两个界面脚本补跑通过：最终主界面仍为 46 组、72 张截图，报告带本次运行标识。核对由真实长期提取产生的群聊与私聊资料，选择任一来源仅展示对应事实，空来源为空，重新读取保留选择，切换筛选不改写 Markdown。最终源码哈希与加载前一致。
- 最大输出 Token 自动跟随模型，允许自定义；默认窗口 100000 字符，支持全局与逐会话自定义和自动压缩。共享备注保存后展示已保存内容，记忆默认 30 天；到期提醒恢复在线及授权后补发一次，结果不明不重复。

本轮验证使用合成会话、隔离 provider 和模拟微信服务端 ACK，没有发送真实测试微信消息或群通知。前次真实模型 `deepseek-account / deepseek-flash` 返回 `ACCOUNT_QUOTA / Insufficient Balance`；本轮未改生产模型或凭据，真实视觉回答效果仍未复验，不能用隔离检查代替真实模型验收。

## 证据

- `storage/logs/refactor-integrated-source-20261107.json`：整体验证时源码及测试的 219 个文件哈希。打包后检测到两个界面测试脚本补充了来源筛选与报告归属检查，应用源码没有变化；新脚本补跑结果及最终哈希另存。
- `storage/logs/refactor-integrated-node-20261107.log`：第一次完整回归及旧断言失败。
- `storage/logs/refactor-integrated-node-final-20261107.log`：最终 531 项通过。
- `storage/logs/refactor-integrated-native-final-20261107.json`：最终原生检查。
- `storage/logs/refactor-integrated-python-20261107.log`：Python 检查。
- `storage/logs/refactor-integrated-ui-20261107/report.json`：主界面结果。
- `storage/logs/refactor-integrated-ui-final-20261107/report.json`：补充来源筛选与运行标识后的最终主界面结果。
- `storage/logs/refactor-integrated-source-final-20261107.json`：最终源码与测试的 219 个文件哈希，加载前一致。
- `storage/logs/refactor-integrated-workbench-ui-20261107/report.json`：工作台结果。

## 加载范围

完整本地包：`release/unreleased-refactor-integrated/dsh-plugin-wechat-agent-0.2.0-preview.6.tgz`，SHA-256：`0113bc48e48327fe99c22a596d5a0a8e038b33f790e47af31566843d8372039e`。485 个文件、运行组件、素材及许可证审计通过，源码构建与包内更新日志一致，未打入用户资料或凭据。审计报告：`storage/logs/refactor-integrated-package-audit-20261107.json`。

已完成本地加载。优雅停用和恢复仅针对本插件，备份原有状态、记忆、任务、知识库、索引、工作台和素材；逐个核对 485 个安装文件与审计包一致。宿主进程保持，微信 Worker 正常更新，连续三次健康检查确认微信在线、运行组件正常、自动回复开启；账号及配置哈希在重启前后一致，全局备注及 30 天有效期保留。

最终只读健康检查确认最大输出 Token 仍为自动、图片能力开关开启、默认窗口仍为 100000 字符，三个会话均无压缩错误。应用内 `changelog` RPC 返回的内容与源码根目录 `CHANGELOG.md` 完全一致。

实际 DSH 页面 6 项核对通过：打开插件并显示微信连接；已保存备注在输入框外展示；编辑回填且取消不写入；默认 100000 字符且百万字符草稿可用；输出额度自动且没有固定输入上限；图片设置显示按需理解与表情包排除。未写设置或记忆。只出现此前已有的宿主账号刷新错误哈希，没有新增插件界面错误。

加载证据：

- `storage/logs/refactor-integrated-local-deployment-20261107.json`
- `storage/logs/refactor-integrated-installed-health-20261107.json`
- `storage/logs/refactor-integrated-installed-ui-20261107/report.json`

本轮没有发送真实测试微信消息或群通知，没有正式发布、提交或推送。真实模型视觉效果仍未复验，前次余额不足的限制保留。
