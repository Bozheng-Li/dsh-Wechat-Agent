# RPC 服务与页面通信

[返回总架构](01-总架构.md)

## 边界与参与者

前端通过 `frontend/shared/rpc.mjs` 连接宿主的 `/wechat-agent` 通道；`backend/rpc/handler.mjs` 是唯一对外操作入口。`shared/contracts.mjs` 定义 `CHANNEL`、`ChannelError` 和公共配置校验。页面不能直接导入服务器实例或微信协议；所有参数是可验证的结构化 payload。

## 请求路径

```text
React 页面 → frontend/shared/rpc.mjs → DSH Connection
 → rpcHandler(service) → service.call(endpoint,payload,signal)
 → 模块 actions / 工作台 / 朋友圈 / Store / Worker
 → {ok:true,value} 或 {ok:false,error}
```

`rpcHandler` 首先确认 `peer.principal.kind === 'owner'`，拒绝其他调用者；接着检查插件是否停止、AbortSignal 和 endpoint 白名单，最后将错误统一转换为公开的错误对象。这个 Owner 是 **DSH 本机所有者**，不同于微信会话管理员；管理员通过聊天入口受另外的授权策略约束。

`backend/app/service.mjs` 提供 `status()` 聚合连接、模型、会话、队列、搜索、朋友圈与存储状态；`currentAccount(payload)` 绑定真实扫码账号；`conversation(payload)` 校验账号、私聊/群聊与 ID 结构。读取状态、联系人、记忆、记录、任务等按各自分支处理；通用更改通过 `mutations` Promise 链依次执行，由 `backend/rpc/actions.mjs` 把 `modules/*/actions.mjs` 注册的 endpoint 映射到对应 mutation。工作台操作及需要长时间等待的能力用 `featureOperations` 追踪，以便插件关闭时 drain。

## 安全与一致性

- 先检查 Owner，再按实际账号与会话范围验证 payload；不能以页面当前选择代替服务端账号检查。
- 变更会话配置前可调用 `paused(...)`，暂停并取消在途回复，待空闲后提交变更，避免旧配置继续发送。
- 长操作同时接收插件生命周期和调用方的取消信号；某些已接受的朋友圈写入/生成轮次归插件生命周期管理，离开页面不应导致重复提交。
- `rpcHandler` 白名单和 `service.call` 分发必须同步增加；通用写操作还要在 `backend/rpc/actions.mjs` 注册模块处理器。未知 endpoint 返回 `UNKNOWN_OPERATION`。

## 修改与测试

新增页面 API：在 `shared/` 定义跨端数据契约，在相关 `modules/.../actions.mjs` 实现操作，更新 RPC 白名单和注册/分发，在页面通过 `call(...)` 消费。保持返回值可序列化，不把密钥、子进程对象和未授权会话详情返回页面。覆盖 `tests/plugin-service.test.mjs`、`tests/module-acceptance.test.mjs`；界面联动可运行 `npm run test:ui`。
