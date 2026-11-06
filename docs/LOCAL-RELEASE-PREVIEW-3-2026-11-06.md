# 本机正式版升级 · 2026-11-06

本机已从本地预览构建切换至 npm 正式发布的 `dsh-plugin-wechat-agent@0.2.0-preview.3`。安装前完整下载并校验公开包，安装后逐一核对全部 419 个文件。

| 项目 | 核验结果 |
| --- | --- |
| npm 实际发布时间 | 2026-11-06 17:43:37，北京时间 |
| npm `latest` | `0.2.0-preview.3` |
| 完整包大小 | 191,705,315 字节 |
| 公开下载校验 | SHA-512 与审计包一致，17:44:41 完成 |
| 本机升级完成 | 17:46:32，北京时间 |
| 微信状态 | 在线、连接健康、运行组件就绪，自动回复开启 |
| 当前搜索 | 已启用公益 Tavily，DeepSeek 原生搜索可切换 |

完整包 SHA-256：

```text
1672cac06f1f89205ceade420d5484496684f98031e65ae66479633e8d858aec
```

升级前等待当前回复和扫码空闲，优雅停止微信组件，通过 DSH 原生插件安装命令更新，再恢复组件。DSH 宿主持续运行；原配置补丁恢复，其他插件依赖与加载顺序保留。

全局目录仍为 `E:\微信机器人`。本次保留当前账号、扫码授权材料、图片上传参数、全局身份、人设、自动回复和其他设置；升级前已有的 3 个会话、10 条记录及已确认发送回执均通过核对，已有任务也保留。维护备份位于该目录的 `storage/maintenance/preview3-*`，对应旧本地构建的回滚包保留在项目 `release/unreleased-workspace-images-20261106/`。

## “还是上不了网”的原因与恢复

接口单独验证成功后，运行实例的搜索总开关仍为关闭，Tavily 地址仍为官方默认地址，用户提供的公益服务配置尚未应用到回复流程。读取当前所有者状态后，在运行实例开启搜索，并将地址设置为公开文档规定的 `https://tavily.fuhuagoogle.top/api/tavily`。

按当前配置执行 `site:arxiv.org LIRA`，取得 5 条真实公开来源。随后使用当前 DSH 聊天模型进行隔离对话，提供“上一轮说 arXiv 翻不了”的合成上下文；模型实际调用 Tavily 搜索，返回可核对的 arXiv 链接。两种搜索密钥保存在 DSH 凭据服务，源码与完整公开包均通过凭据扫描。

正式安装后的原生界面核验确认：搜索已开启、选中 Tavily、公益 API 地址正确，两种密钥显示已保存且输入框为空；应用内读取的是正式 `.3` 更新日志。4 项界面检查通过，浏览器错误为 0。界面截图仅保存在本机私有验证目录。

当前扫码会话已有完整图片上传参数。图片发送回归使用隔离传输和服务端回执，未向真实微信投递测试消息。群维护通知保持关闭。

本机报告：`storage/logs/npm-release.json`、`storage/logs/enable-tavily-live.json`、`storage/logs/live-tavily-reply-verification.json`、`storage/logs/desktop-preview3-update.json` 和 `storage/logs/installed-preview3-ui/native-ui.json`。
