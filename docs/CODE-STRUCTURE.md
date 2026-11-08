# 代码结构与维护入口

源码按“插件装配 → 业务功能 → 存储及平台支持”划分；浏览器页面独立放在 `client/`，只通过 RPC 使用后端。目录对应实际维护职责，同一功能的实现放在一起，独立职责再拆成文件。

```text
src/
├─ index.mjs                 DSH 服务端稳定入口
├─ client.jsx                DSH 浏览器稳定入口
├─ worker.mjs                Worker 构建入口
├─ testing.mjs               测试使用的导出入口，不进入发布包
├─ app/
│  ├─ plugin.mjs             插件注册、启动、关闭与工作目录切换
│  ├─ runtime.mjs            创建、激活和释放一组运行服务
│  ├─ rpc.mjs                所有者权限、操作白名单、错误转换
│  ├─ service.mjs            状态查询、操作排队、取消和运行实例替换
│  └─ mutations/             按业务划分的写操作
│     ├─ index.mjs           操作名与处理函数的注册表
│     ├─ agent.mjs           身份、人设、模型、搜索凭据
│     ├─ connection.mjs      微信连接、登录、取消任务
│     ├─ settings.mjs        授权、会话设置、工作目录
│     ├─ memory.mjs          会话、长期及图片记忆
│     ├─ media.mjs           素材管理与上传
│     └─ tasks.mjs           定时任务管理
├─ client/
│  ├─ entry.jsx              注册 DSH 面板和侧栏
│  ├─ panel.jsx              外框、导航、状态提示
│  ├─ page-content.jsx       页面选择与页面参数连接
│  ├─ hooks/                 状态轮询、草稿生命周期、工作台操作
│  ├─ components/            按钮、表单、图标、会话选择器等复用组件
│  ├─ shared/                RPC 客户端、显示名称、表单转换、会话视图
│  ├─ styles/                基础样式、主题和工作台样式
│  └─ pages/
│     ├─ overview/           工作台概览、账号卡片
│     ├─ conversations/      授权、会话设置、自然陪聊配置
│     ├─ records/            处理记录
│     ├─ recovery/           发送恢复
│     ├─ memory/             会话窗口、长期记忆、图片记忆、维护
│     ├─ media/              表情与图片素材库
│     ├─ tasks/              定时任务、提醒对象、任务详情
│     ├─ digests/            群聊简报
│     ├─ diagnostics/        运行检查
│     └─ settings/           模型、身份、人设、存储、更新日志
├─ features/
│  ├─ agent/                 模型选择与执行、提示词、正文提取、身份、风格
│  ├─ conversation/          队列、消息接收、回复执行、自然陪聊、记忆维护
│  ├─ memory/                会话、长期和图片记忆及对应工具
│  ├─ media/                 素材库、格式检查、ZIP 读取、校验、内置素材
│  ├─ tasks/                 定时调度、对话中的任务与素材工具
│  ├─ search/                外部搜索服务
│  └─ workbench/             诊断、发送恢复、简报、工作台存储
├─ storage/
│  ├─ state-store.mjs        配置、会话状态、记录及事务协调
│  ├─ initialize.mjs         状态加载、旧数据与目录迁移
│  ├─ archive.mjs            会话归档校验、写入与源目录加锁
│  ├─ atomic-json.ts         原子 JSON 文件发布
│  ├─ json.mjs               状态文件读写及可理解的错误
│  ├─ keys.mjs               稳定标识、会话键和目录名称
│  ├─ locks.mjs              实例锁与归档写入锁
│  ├─ paths.mjs              路径校验
│  ├─ workspace.mjs          完整工作目录迁移与回滚
│  └─ helpers.mjs            状态默认值与内部小型纯函数
├─ platform/
│  └─ resources.mjs          源码、lib 和安装包共用的资源定位
├─ shared/                   前后端共用的契约、默认值、人设数据、文本处理
└─ wechat/                   微信 Worker、IPC 客户端、协议和传输适配
   ├─ worker.mjs             子进程消息与操作处理
   ├─ worker-client.mjs      主进程 IPC、状态快照与子进程生命周期
   ├─ protocol/              登录、会话凭据、同步、图片与消息传输
   └─ ai/                    微信文本及原有 AI 协议适配
```

## 常见修改从哪里开始

| 要修改的内容 | 主要入口 |
| --- | --- |
| 新增或修改页面 | `client/pages/<功能>/`，在 `client/page-content.jsx` 接入 |
| 页面轮询、未保存草稿、操作反馈 | `client/hooks/use-panel.mjs`、`client/hooks/use-workbench.mjs` |
| 新增管理操作 | `app/mutations/<功能>.mjs` 注册 `endpoints`，同步 `app/rpc.mjs` 白名单和调用方 |
| 什么消息触发回复 | `features/conversation/incoming.mjs` |
| 排队、暂停、取消、授权复核 | `features/conversation/channel.mjs` |
| 生成、发送及回执记录 | `features/conversation/reply.mjs` |
| 记忆压缩与重试调度 | `features/conversation/memory-maintenance.mjs` |
| 提示词及模型执行 | `features/agent/prompts.mjs`、`features/agent/runner.mjs` |
| 人设保存格式与字段原则 | `features/agent/persona-input.mjs` 无损识别编辑器标准正文；`prompts.mjs` 统一分块，自由正文保留原样 |
| 素材读取或格式校验 | `features/media/image-format.mjs`、`features/media/zip.mjs` |
| 定时提醒 | `features/tasks/scheduler.mjs`、`features/tasks/conversation-tools.mjs` |
| 发送恢复、简报、诊断 | `features/workbench/recovery.mjs`、`digests.mjs`、`diagnostics.mjs` |
| 状态保存及旧数据兼容 | `storage/state-store.mjs`、`initialize.mjs`、`archive.mjs` |
| Python、内置图片、更新日志路径 | `platform/resources.mjs` |

## 依赖约定

- `app/` 负责装配服务、权限入口和跨模块协调；业务模块不反向导入 `app/`。
- `client/` 只能依赖浏览器组件和 `shared/`；读取与修改业务数据使用 RPC，不导入后端实现或 Node API。
- `shared/` 保存无运行实例的共用契约、数据和纯函数，不依赖页面、服务或存储。
- `storage/` 依赖 `shared/` 和平台支持，不依赖微信协议解析。协议中旧的 `atomicJson` 导出继续兼容，实际实现位于存储层。
- `features/` 可以显式使用其他功能的接口以及存储、平台、微信适配；不通过大而全的汇总文件间接导入。模块之间禁止运行时循环依赖。
- 生命周期和共享可变状态仍由原来的协调对象持有；拆出的操作函数显式接收该对象。不要复制一份队列、授权、草稿或发送状态，也不要用修改原型的方式拼装类。
- 涉及发送的改动要保持授权复核、取消等待及服务端回执顺序。请求提交不等于已发送，结果不明不能自动重发。

不为了凑文件数量拆散同一个事务，也不把不相干的业务塞进通用 `utils`。新增功能优先进入对应目录；公共组件和纯函数至少有明确的复用需要。格式遵循根目录 `.prettierrc.json`。

## 构建、资源与兼容

`package.json` 的发布入口继续是 `lib/index.js`、`lib/client.js` 和 `lib/worker.cjs`，由四个根级源码入口构建；测试仍通过 `lib/testing.js` 或具体模块运行。旧的内部源码平铺路径已迁移，仓库内的脚本与测试同步使用新路径。

`runtime/`、`assets/`、`storage/`、`lib/` 和 `release/` 的用途保持稳定。业务文件通过 `resourcePath()` 找到所在包的资源，不能再假定自己的源码文件上一级就是项目根目录，也不能依赖进程工作目录。

根目录 `CHANGELOG.md` 是更新日志的唯一来源；应用内通过 `changelog` RPC 读取同一文件。源码结构调整记入“未发布”，不修改正式版本记录。

```powershell
npm run build
npm test
npm run test:structure
```

`tests/source-structure.test.mjs` 检查模块解析、依赖方向、运行时循环和资源定位；`npm test` 自动包含这项检查。消息、记忆、任务、真实 IPC 和工作目录切换仍由原有功能回归覆盖。界面和 DSH 原生接入命令见 [开发说明](DEVELOPMENT.md)。
