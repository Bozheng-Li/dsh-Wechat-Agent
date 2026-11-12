# 对话、记忆、模型与工具专项审计

> **证据截止与后续变更：** 本文涉及本地实现的“当前”“最新”“已关闭”“开放”，均指本轮各自留存的候选及截至 2026-11-11 11:09（北京时间）的专项复验。第二轮全量回归随后完成，其成绩仍归属于该轮实际执行阶段，不代表一个固定的 11:09 构建通过整套验收。12:26 恢复工作时，共享工作树又有源码重构；这些后续改动不由本报告认证，也不据旧证据宣称现工作树仍有相同缺陷。正文的源码路径、行号与状态按对应证据阶段保留，后续候选需要独立核验。

审计日期：2026-11-11。对象为当前工作树源码，包含用户尚未提交的修改；不是 npm 已发布包，也不是线上插件的完整验收。本文只提出优化方向，不修改业务实现。

**收尾状态更新：** 审计过程中另一路并行工作修改了图片时间过滤并新增入站文件/DOCX，随后又为文件缓存加入独立完整性记录。第 2 节保留初始基线证据；M-01 和后发现的 FILE-01/F13 当前复现均已修正，M-02 至 M-05 仍可复现。各阶段专项成绩和最新状态见第 9 节，尤其 9.4；不把初始失败或旧 bundle 成绩当作最终源码状态。

## 1. 结论与证据边界

当前实现已具备渐进工具加载、会话隔离、版本化记忆分页、按需看图、后台压缩、来源校验、发送回执关联、独立生成图片记忆与删除防恢复等机制。优先任务是补齐这些机制之间的边界，再建立整次任务的资源预算、可回放评估和规模化存储。

本专项初始阶段执行了直接导入当时工作树源码的离线实验：

```powershell
node storage/logs/harness-audit-2026-11-11/memory/audit-experiments.mjs
```

脚本与输出分别为：

- [audit-experiments.mjs](../../storage/logs/harness-audit-2026-11-11/memory/audit-experiments.mjs)
- [audit-experiments.json](../../storage/logs/harness-audit-2026-11-11/memory/audit-experiments.json)

执行环境为 Windows、Node.js `v24.16.0`；本节记录的初始实验输出时间为 `2026-11-11T02:13:46.953Z`，后续源码与探针见第 9 节。运行退出码为 0，表示所有描述当时现状的断言完成，**不表示发现的产品边界已经通过**。脚本调用真实 `ImageMemory.list`、工具执行器、复核函数、模型选择辅助函数和检索函数，数据及外部服务均为合成；没有访问真实凭据、调用付费模型或发送微信消息。存储/完整原生/UI 回归结果由主审计报告统一记录。

证据分为“已复现”“源码确认的边界”“待真实链路验证”。源码证据不能代替上线流量质量统计；人工构造的模型草稿也不能用于估算真实模型出错率。

基于主审计当时完成的初始构建，另执行以下专项回归；其结果不代表第 9 节更新后的源码与构建：

```powershell
node --test tests/image-memory.test.mjs tests/progressive-context.test.mjs tests/progressive-retrieval-v12.test.mjs tests/request-metrics-isolation.test.mjs tests/vision-routing.test.mjs tests/search-fallback.test.mjs tests/memory-tool-combined.test.mjs
```

实际结果：**83 tests，82 pass，1 fail，0 cancelled，0 skipped，0 todo；103.024 秒，退出码 1**。唯一失败为 `tests/image-memory.test.mjs:229` 的时间上界搜索，actual 为 1、expected 为 0，对应 M-01。该测试使用真实隔离目录、图片索引和合成图片，补强了内存内最小复现。日志见 [targeted-tests.log](../../storage/logs/harness-audit-2026-11-11/memory/targeted-tests.log)。耗时包含与主审计并发运行的环境负载，不能作为独立性能基线。

## 2. 已复现的问题

### M-01：接收图片绕过读取时间上界（初始 P0；收尾当前复现已关闭）

**触发条件：** 普通接收图片没有 `generation.jobId`，本轮也没有 `currentJobId`；查询 `before` 或工具 `maxTime` 早于图片时间。

**结果：** 放入 13 张同时间接收图片后，以 `before = 图片时间 - 1 ms` 搜索，仍返回 12 张、`total = 13`。以相同 `maxTime` 读取其中一张，工具返回 `ok = true`，合成视觉 runner 被调用一次。

**原因：** [images/store.mjs](../../modules/memory/images/store.mjs) 的 `list` 时间过滤含 `item.generation?.jobId === input.currentJobId`，普通接收图两侧均为 `undefined`，错误触发“当前工作任务”例外。[images/tool.mjs](../../modules/memory/images/tool.mjs) 的读取检查使用反向比较，同样被绕过。搜索从旧轮次带入未来图片的元数据；读取可进一步带入未来图片内容。此实验没有证明跨账号或跨会话泄漏。

**方向：** 将例外写成唯一共享的显式谓词：collection 必须为 generated、currentJobId 必须为非空合法 ID、图片 generation 必须合法且任务 ID 相等；搜索、原图读取、引用复核复用它。时间边界应保留在 reference 中，发送前仍可核对。

**验收：** 接收图时间 `T-1/T/T+1`，生成图同任务/异任务/无任务，owner/群发起人三组主体，以及 search/read/reference 三个入口的笛卡尔关键组合；旧轮次绝不调用未来图视觉。`tests/image-memory.test.mjs` 的“before 搜索 total 为 0”断言在初始专项中失败，修复后的第 9.1 节专项已通过；第 9.4 节独立探针再次确认直接 read 拒绝未来图片。后续仍应补齐上述组合矩阵，保留已修复边界的回归。

### M-02：独立图片记忆搜索绕过渐进结果预算（P1）

**触发条件：** 12 个命中，每项保存了允许范围内的 4,000 字图片描述与 4,000 字来源正文。

**结果：** 实际 `wechat_image_memory` search 返回 **98,328 个 UTF-16 字符**。生成图片还可带生成要求、模型和接口名称等信息，因此本数值不是全局最大值。`measureModelRequest` 能记录这部分体积，但不限制它。

**现状区分：** `wechat_read_image` 的渐进目录已有 80 字摘要和 6,000 字总目录限制，笔记读取已有 4,000 字版本化分页；本问题出在另一入口 `imageMemoryTool`，不是这些已完成优化失效。

**方向：** 搜索统一返回 ID、时间、来源短摘、80–160 字内容摘要、质量和已发送事实；完整 description/sourceText/generation.prompt 改为独立 `read_note` 分页。搜索结果总预算独立限制为建议 4,000–6,000 字，至少保留一项可展开结果，不静默丢掉命中尾部。已有视觉笔记可读取时无需重复调用视觉；仅“重新看图”使用 read。

**验收：** 对同一 12 项 fixture，结果正文不超过最终选定预算；每一条来源及原始描述均能按 revision 重建；省略标记和 hasMore 真实；三次视觉额度不被读笔记消耗。用模型实际 tokenizer/usage 再评估成本，不能把字符比率当 token 比率。

### M-03：图片搜索报告 hasMore，却没有可靠的下一页入口（P1）

工具参数只有 `action/query/imageId/question/after/before`，底层列表支持 offset，但未暴露给模型。13 张同时产生且可检索字段相同的图片，首轮始终返回相同 12 张；重复相同查询与时间范围无法枚举第 13 张。即使修复 M-01，仅靠时间切片仍不能区分相同时间的记录。不能让模型猜未公开的 imageId。

**方向：** 使用稳定排序键 `(score,time,id)` 和不透明、带账号/会话/collection/查询/revision 的 cursor，返回 nextCursor；删除、过期、查询变化明确使 cursor 失效。若采用快照游标，应约束快照生命周期，不能绕过删除与权限变更。

**验收：** 0/1/12/13/50/51 项、相同时间/相同词条、翻页中删除/过期/新增/改描述；每个当时可见 ID 恰好一次，错误游标不跨范围，搜索完整性不能只凭 hasMore 文本判定。

### M-04：事实复核失败时保留已检测为无依据的整句（P1）

**触发条件：** 问“我以前说过什么忌口？”，查询未找到资料，给定草稿“你之前没有提过花生过敏。”；复核 runner 抛出合成服务异常。

**结果：** `memoryReviewFlags` 正确发现 `empty-memory-result` 与 `unsupported-exclusion`；`reviewMemoryDraft` 的 fallback 仍返回原句。`removeUnsupportedExclusions` 删除全部内容后使用 `kept || text`，使完整不支持断言重新出现。

**方向：** 区分表达审阅失败与事实硬边界失败。普通风格审阅可以保留正文；明确无依据的排他断言若是全部正文，返回结构化 `needs-evidence/undeliverable`，由现有回复流程选择有依据的降级说明或保持待处理，不能“因为清洗后为空”恢复断言。保留用户逐字复述/翻译场景的精确输出边界；有明确负面事实来源时允许负面回答。

**验收：** 全句/部分子句、不支持/已支持、疑问/断言、用户要求照抄、复核超时/异常/空回复分别验证。降级不能新增所谓忌口、否认已发图片或伪称已保存记忆。真实模型上另统计发生率和误拦截率；本实验只证明故障路径。

### M-05：视觉模型元数据查询不能独立响应取消（P1）

`visionSelection` 直接 await `resolveModelInfo` 和候选 `listModels`，没有复用普通 `lookupModel` 的有限等待。合成 provider 忽略 AbortSignal 时，调用者 abort 后观察 50 ms，Promise 仍未结算；provider 最终返回后该 helper 正常 fulfilled。

**方向：** 共用有 deadline、abort race、返回后 `throwIfAborted` 和目录二次确认的查询层。不要让一个失效 provider 阻塞取消、插件关闭或后续排队请求。超时不代表下游调用已终止，迟到结果必须丢弃，保留计数用于诊断。

**验收：** provider 正常响应/忽略取消/永不返回/移除模型/抛错；取消必须在选定的短预算内结束等待且不建新 Agent；迟到数据不保存选择、不自动改用另一个 provider。`runner.run` 后续已有 signal 检查，因此本实验没有证明取消后真实模型请求被发出；确认的是 await 活性缺口。

## 3. 性能与上下文规模

词法检索微基准：每组预热一次、测量五次、固定合成文本与问题，直接运行当前 `relevantMemoryReference`，最大输出 3,000 字。

| 来源行数 | 来源字符 | 中位耗时 ms | 五次最大 ms |
|---:|---:|---:|---:|
| 100 | 5,889 | 1.172 | 1.438 |
| 1,000 | 59,889 | 5.685 | 7.056 |
| 10,000 | 608,889 | 62.043 | 73.054 |

这只测 CPU 内存内词法检索，不包含磁盘、模型、并发或杀毒软件，因此不是端到端 p95。其作用是确认随着原始资料增长，输出虽有界，扫描开销仍增长。不能据此直接决定引入向量数据库。

源码确认的规模边界：

- `ConversationMemory.load/append` 反复同步读取和写入整个会话 JSON；有保留期和压缩，不等于读取成本恒定。
- `ImageMemory.load` 读取并验证完整索引；`list` 对所有候选评分和排序；删除/过期 tombstone 必须保留，长期运行仍会累积索引负担。
- `LongTermMemory.document` 对 Markdown 有 2,000,000 字符限制，而提取 `extract` 只限制当前来源 batch（约 24,000 字/60 条）；同会话所有 active/pending `existing` 仍整体附给模型，且首条超大来源允许独立进入 batch。这是预算不闭合的源码证据，尚未在超大真实会话压测。
- `measureModelRequest` 记录 system/user/assistant/tool/schema 字符及可用 usage，按 session 归因；当前是观察器，不是统一预算器。视觉子请求与复核子请求需要归入业务父任务，才能计算“回答一次到底花了多少”。
- `atomicBytes` 有 fsync，`atomicJson` 和长期记忆的独立文本写入路径不完全采用同一持久化契约。原子替换防止部分文件，不自动证明断电后 durable，也不等于跨文件事务。

## 4. 按实际功能映射优化方向

下表中的“现有证据”指已读实现与测试案例，不能把列出的测试文件视为本专项全部通过。具体回归结果应与主报告的命令输出交叉核对。

| 功能 | 当前已存在的能力与测试入口 | 后续方向、优先级与验收 |
|---|---|---|
| 普通聊天、自然群聊 | `conversation/incoming.mjs`、`reply.mjs`、`natural-chat.mjs`；natural-chat/reply-modes/reply-style 测试 | P1：按群/发起人测误参与、漏响应、取消后的交付；同时报告任务成功率与无故追问率。合成用例外另准备多轮匿名语料。 |
| 人设、角色卡、聊天偏好 | owner-authored role card、revision 防覆盖；偏好仅取同发言人近期消息，不从摘要/助手回复导出 | P1：统一人设/事实/偏好优先级契约，覆盖同名/改名/亲属/引用/否定/多人和明确纠正。角色卡损坏继续全局表达时必须可见诊断。 |
| 渐进提示与工具发现 | `progressive.mjs`、`registry.mjs`；关键词只预加载授权工具，漏匹配仍有目录；群加载不授权 | P1：能力注册声明式元数据代替名称分组+多处 regex；工具增删时自动验证“已授权工具全部可发现、未授权工具不可见/不可执行”。新增中英文语义漏触发评估。 |
| 完整请求上下文 | 近期历史 progressive 6,000 字/12 条、旧参考/人物投影 3,000 字、按需模式与已知来源 | P1：把系统提示、历史、工具 schema、全部工具返回、图片、复核输入纳入父任务预算。不得截断管理员硬规则；预算不足优先降级目录/分页，记录原因。 |
| 记忆查询 | 双分区共享 progressive 4,000 字；revision、generation、覆盖状态和来源；memory-tool-combined/progressive-context | P1：统一图片/文本/工作资料的分页契约，M-02/M-03；评估“检索未中”与“没有事实”的措辞。P2：建立多关键词和语义改写召回集，再决定 BM25/向量混合。 |
| 会话窗口压缩 | 16,000 字分批、最多并行 2、冻结模型、缓存已验证分块、原文归档、失败保留/重试 | P1：用结构化事实守恒检查保护人、时间、否定、来源和未完成事项；压缩前后同题作答比较。P2：按压力和前台延迟动态调度，测长期繁忙时维护饥饿。 |
| 长期事实提取 | 引文必须来自来源、scope 固定、人物区分、冲突 pending、时区/有效期、删除后不恢复 | P1：给 `existing` 做相关项索引+按需冲突展开；给超大单条来源分片。保持来源不可伪造，单条异常可进入隔离队列，避免坏批次无限占用后台。 |
| 事实复核 | 最多一次无工具复核、12 秒截止、明确 flags 与 audit | P1：修 M-04；把事实阻断与风格建议分开。只对有风险样本复核，用额外延迟/成本换得的错误减少量判断是否保留。 |
| 接收图保存、看图 | 独立原图、哈希、缩略图失败保原图、质量标签、最多 3 次视觉、表情跳过视觉 | 初始 P0 的 M-01 已关闭当前复现，保留边界回归。P1：短索引和无视觉 read_note；相同原字节+问题+模型+来源边界缓存视觉结果，删除/权限变化立即失效。 |
| 生成图记忆 | 独立 collection；真实 artifact bytes/sha256；群内未发送图仅发起人可见；ACK 后扩大到本会话 | P1：生成事实/发送事实/画面事实继续分开；覆盖多图部分 ACK、任务重试、同名文件换字节、消息引用关联。图像来源显示保持可追踪。 |
| 图片引用及追问 | type-57/精确编号、消息引用关联、已发送图片上下文、读取后复核 reference | P1：跨消息顺序、同毫秒、缺原图/有笔记/删除中读取的端到端矩阵；不能凭“最近一张”假定明确引用目标。 |
| 模型选择、推理强度、视觉路由 | 通过 DSH live registry、固定本轮配置、默认输出预算交给宿主；model-info/model-reasoning/vision-routing | P1：M-05；统一目录查询超时与取消。显式视觉模型不可静默切换；隐式同家族回退在诊断中显示真正 provider/model。 |
| 搜索与双 provider 回退 | 独立凭据、1 MiB 响应上限、5 个来源、来源截断、相同 query 最多一替代；empty/failed 区分 | P1：父任务统一 deadline（两个 45 秒尝试不应无感占满聊天时间）；按 provider/错误类型统计熔断与成功率。来源正文展开应有引用与字节限额，不把 snippet 说成读过全文。 |
| 搜索隐私与不可信内容 | public query 提示与凭据分离；结果只作为资料；未见自动外传的硬拦截 | P1：可控私有标记/身份字段外发检测与注入测试；用合成密钥、聊天片段、伪系统指令验证实际出站 query。不能仅凭 prompt 声明“绝不外传”，也不能宣称本轮已发现真实泄漏。 |
| 素材库、ZIP、媒体转换 | 扩展名/格式、ZIP 路径、膨胀/条数/账户大小上限、分块上传；media-library/media-conversion | P1：压缩包/图片解码 fuzz，截断、CRC、重叠、重复名、超大像素、并发导入；后台线程做昂贵解码，保持错误时原素材可用。 |
| 工作工具读写、内存查询 | 文本 read 已为 6,000 Unicode 字符+路径/版本 cursor；写 revision；stdout/stderr 分别限 8,000 字；按需读取工作来源聊天 | P1：每工具结果还受父任务预算，错误输出同样限额；工作原生工具可能另有宿主策略，不能以插件分页证明宿主全部工具有界。 |
| 存储、编辑、迁移 | ownerStoreId、scope、revision、原子替换、归档、迁移；storage-v2/memory-integrity/workspace-root | P1：统一 durable-write 与跨文件恢复契约、crash 注入；P2：先测 100/1,000/10,000 会话/图片和 30/90 天数据，再采用每会话索引、SQLite WAL 或增量日志。避免直接换库破坏可读 Markdown。 |
| 删除、过期、清理 | generation/tombstone、晚到写入拒绝、实际像素删除失败可重试；memory-retention/owner-cleanup | P1：明确各层数据保留含义，覆盖 DSH session、日志、缩略图、任务 artifact、原始归档；“不再用于记忆”与“全部物理删除”分开。P2：tombstone 压缩必须保有防恢复边界。 |
| 诊断与质量评估 | 按请求字符、usage、state、elapsed；style/review flags；历史 A/B 原始结果 | P1：统一父任务 traceId、版本/模型/策略/权限快照、检索命中及分页、tool 成败/重试原因。只记数值和 ID 的脱敏诊断，不默认复制聊天正文；能从失败样本生成隔离 replay。 |

## 5. 建议实施顺序

以下保留初始基线的处理排序；收尾 M-01 已经由并行源码更新修正并通过专项，当前后续工作应按第 9 节状态调整。

1. **先关闭已复现边界：** M-01 时间不变量的当前复现已由并行工作修复，后续保留回归并扩展组合矩阵；仍需处理 M-04 明确不支持的整句回退与 M-05 取消等待。保持当前用户工作树，独立补回归，不在本轮调研中混入业务改造。
2. **统一上下文和工具结果：** M-02/M-03、事实提取 existing 的预算、主请求/视觉/复核/搜索父任务归因。先保持现有精确来源、游标和权限契约，再压缩表现层。
3. **建立质量门禁：** 冻结旧版/候选、配置和样本；结果对齐任务完成率、事实正确率、越界率、自然度、输入/输出用量和端到端分位延迟。分组报告普通聊天、复杂事实、图片、多人记忆和失败恢复，不能只报总平均。
4. **规模化验证再换存储：** 前台回复与后台维护混合负载、故障恢复、持续增量和删除，测 event-loop delay、RSS、磁盘写入量、p50/p95/p99。优先消除重复解析、重复排序和全量扫描，达到瓶颈证据后选数据库方案。

可采用的初始门禁是“已知隔离与事实边界用例 0 回归，所有确认成功均有真实结果依据，取消迟到结果 0 提交”；延迟和费用目标应从该用户实际机器与 provider 的基线制定。本文 4,000–6,000 字等数值是待实验的建议预算，不是普遍最优值。

## 6. 既有实验的正确用法与尚未验证范围

[渐进上下文 v1.2](../PROMPT-PROGRESSIVE-V12-2026-11-10.md) 已记录冻结候选、108 次正式任务、共同完整集合和全任务分母、独立 AI 评审与原始服务失败。它是有价值的历史基线，应复用方法与保留失败样本，不应把 18 个场景上的局部优势外推到所有模型或长期群聊。当前角色记忆、朋友圈及回复复核又有变化，必须重新冻结当前候选后再比较，不能把历史成绩标成当前源码已验证成绩。

尚未通过本专项证明：真实微信的全部收发/引用路径，真实模型的工具发现成功率与长期自然度，真实搜索服务的可用率，真实视觉输出正确率，连续数日的维护饥饿/资源泄漏，断电级持久化恢复，全部隐私出口的动态污点追踪。完整源码单测与合成 provider 测试也不能替代这些证据；可使用专用测试账号和隔离环境补充，避免对正常会话进行实验性发消息。

## 7. 可独立保留的最小复现

`storage/` 被 Git 忽略。除本机完整脚本和 JSON 外，下面保留核心复现，未来工作树可以把片段保存为仓库根目录的临时 `.mjs` 后用 Node 运行；不需要真实账号、图片、凭据或模型。以下断言刻画审计时发现的问题；修复后应翻转相应断言。

```javascript
import assert from 'node:assert/strict';
import { ImageMemory } from './modules/memory/images/store.mjs';
import { imageMemoryTool } from './modules/memory/images/tool.mjs';
const scope = { accountId: 'audit', chatType: 'private', peerId: 'peer' };
const time = 1794362400000;
const items = Object.fromEntries(Array.from({ length: 13 }, (_, i) => {
  const id = (i + 1).toString(16).padStart(64, '0');
  return [id, { id, type: 'image', time, capturedAt: time, bytes: 8,
    senderName: '合成人物', quality: 'original', expiresAt: null,
    sourceText: '共同来源。'.repeat(800), description: '共同描述。'.repeat(800) }];
}));
const images = { load: () => ({ settings: { enabled: true }, items }),
  selector: () => scope, directory: () => '<synthetic>', errors: new Map() };
images.list = (s, options) => ImageMemory.prototype.list.call(images, s, options);
const tool = imageMemoryTool(images, {}, scope, () => {});
const raw = await tool.execute({ action: 'search', before: time - 1 },
  { signal: new AbortController().signal });
assert.equal(JSON.parse(raw).total, 13); // 期望产品行为为 0。
assert(raw.length > 98000);             // 确认工具结果绕过短目录预算。
assert(!('cursor' in tool.parameters.properties));
```

事实复核的最小复现：

```javascript
import assert from 'node:assert/strict';
import { reviewMemoryDraft } from './modules/memory/roles/reflection.mjs';
const draft = '你之前没有提过花生过敏。';
const result = await reviewMemoryDraft({ run: async () => { throw Error('合成失败'); } },
  { text: '我以前说过什么忌口？', memory: '', history: [],
    extraReadResults: ['{"found":false}'] }, draft,
  { signal: new AbortController().signal });
assert(result.audit.flags.includes('unsupported-exclusion'));
assert.equal(result.audit.outcome, 'fallback');
assert.equal(result.text, draft); // 明确被标记的整句仍被保留。
```

## 8. 默认界面全流程的夹具修复验证

主审计的原始默认 UI 流程退出码为 1，已完成 34 组断言并生成 33 张截图；失败位置为 `scripts/test-ui-driver.cjs:470` 的记忆标签键盘切换。原始报告保留在 [ui/report.json](../../storage/logs/harness-audit-2026-11-11/ui/report.json)，未覆盖。

**原因已核对：** 实际 [MemoryWorkspace](../../frontend/pages/memory/workspace.jsx) 的顺序为 `conversation → global → roles → images → generated-images → review` 六项。[WorkspaceTabs](../../frontend/components/workspace-tabs.jsx) 按当前数组处理左右键及 Home/End；原测试在 End 选中 review 后，仍期望 Left 到 images，而实际应为 generated-images。旧 `assertPanel` 也只列出 conversation/global/images/review 四项。这是夹具未同步新增角色卡和生成图片页，不能据此认定产品键盘切换失效。

为跑完后续真实 UI/RPC 行为，在 `storage/` 制作隔离副本，**没有修改原业务源码或原测试脚本**：

- [prepare-ui-adaptation.mjs](../../storage/logs/harness-audit-2026-11-11/memory/prepare-ui-adaptation.mjs)：复制并做逐项精确替换。
- [adaptation.json](../../storage/logs/harness-audit-2026-11-11/memory/ui-adaptation/adaptation.json)：记录原 launcher/driver/两个 React 组件、testing bundle 和适配副本 SHA-256，以及完整替换清单。
- 副本 driver 断言全部六个 panel，并逐个按 Right 经过 global/roles/images/generated-images/review/conversation，按 Left 验证反向和首尾循环，再验证 End/Home。其余功能断言保留。
- launcher/driver 的 root、相对 import、package 与辅助 require 仅改为原仓库绝对路径，以确保副本仍加载同一业务构建；默认 child driver 指向隔离副本。

执行命令（首次需先生成副本；以下环境变量仅针对本次 shell，其他 `WECHAT_UI_TEST_*` 专项选择变量保持未设置）：

```powershell
node storage/logs/harness-audit-2026-11-11/memory/prepare-ui-adaptation.mjs
$env:WECHAT_UI_TEST_OUTPUT = 'D:/Learn-data/github-Project/wechat-agent/dsh-Wechat-Agent/storage/logs/harness-audit-2026-11-11/ui-adapted'
node storage/logs/harness-audit-2026-11-11/memory/ui-adaptation/test-ui.mjs 'D:/Learn-data/github-Project/wechat-agent/dsh-Wechat-Agent/storage/cache/electron-40.9.3/electron.exe'
```

**实际结果：退出码 0，55 组断言、77 张截图、0 个浏览器错误。** [适配报告](../../storage/logs/harness-audit-2026-11-11/ui-adapted/report.json) 与 [fixture-summary](../../storage/logs/harness-audit-2026-11-11/ui-adapted/fixture-summary.json) 均为 `ok: true`，真实微信消息与真实模型调用均为 0。日志见 [ui-adapted-run.log](../../storage/logs/harness-audit-2026-11-11/memory/ui-adapted-run.log)。完成后重新计算四个原文件哈希，全部与适配清单一致。

完整适配流程涵盖记忆编辑/失败重试/迁移/来源、图片库、任务、素材 ZIP 分块上传与预览、内置分组、宽窄主题布局、会话取消、切换账号后记录/授权/图片/备注隔离。通过的是**隔离适配后的默认全流程**，不是原始命令已修复，也不是所有新增专项页面均由这个流程验收；专项覆盖由主审计另外统计。

**优化方向 UI-M-01（P1）：** 将导航/键盘顺序的固定夹具更新为六项契约，分别断言产品期望清单与 DOM 实际清单，再遍历列表验证行为；不能只从 DOM 自发现后自证，否则遗漏产品要求的新页也会通过。把“测试夹具漂移”与“产品交互故障”分开记录，默认全流程必须重新作为 CI 门禁；不应靠缩短流程或跳过失败标签取得绿色。

## 9. 收尾新增文件能力与当前源码复核

### 9.1 两次证据对应的源码不同

最后核验发现另一路并行工作已给图片例外补上 `collection === generated` 和非空 `currentJobId`，同时新增 `modules/files/`、`modules/tools/files.mjs`、`shared/received-files.mjs`、协议 file-message/file-download/file-loader 及两组文件测试。本审计没有实施这些业务改动。

本次在独立 `memory-final/` 目录复核，原 `memory/` 脚本、结果和失败日志原样保留。启动快照时间为 `2026-11-11T02:40:28.729Z`；[source-manifest.json](../../storage/logs/harness-audit-2026-11-11/memory-final/source-manifest.json) 捕获 14 个相关源码、测试和 testing bundle 的 SHA-256，结束后 [source-verification.json](../../storage/logs/harness-audit-2026-11-11/memory-final/source-verification.json) 全部 `unchanged: true`。

```powershell
node storage/logs/harness-audit-2026-11-11/memory-final/audit-experiments.mjs
node storage/logs/harness-audit-2026-11-11/memory-final/file-experiments.mjs
node --test tests/image-memory.test.mjs tests/inbound-files.test.mjs tests/received-files.test.mjs
```

三文件专项实际结果：**46 tests，46 pass，0 fail/cancelled/skipped/todo；127.130 秒，退出码 0**，见 [targeted-tests.log](../../storage/logs/harness-audit-2026-11-11/memory-final/targeted-tests.log)。测试明确包含收尾才新增的 `received-files.test.mjs`，不是依赖较早启动的主回归是否自动发现新文件。

当前状态如下：

| 编号 | 当前复核 |
|---|---|
| M-01 | 已关闭已知当前复现：13 张未来接收图片的 before 搜索返回 0；未来图片 read 返回 `IMAGE_MEMORY_UNAVAILABLE`、视觉调用 0；此前失败的真实图片 fixture 单测也通过。尚不能因此声明第 2 节建议的全部组合矩阵都已新增执行。 |
| M-02 | 仍复现：合法 12 项图片搜索返回 98,328 字符。 |
| M-03 | 仍存在：图片工具 schema 仍无 offset/cursor；重复查询仍返回同一批 ID。 |
| M-04 | 仍复现：检测为 unsupported-exclusion 的整句在复核失败后原样保留。 |
| M-05 | 仍复现：不响应 signal 的视觉 metadata provider 在 abort 后继续占住等待，最终正常 fulfilled。 |

最新原始结果见 [audit-experiments.json](../../storage/logs/harness-audit-2026-11-11/memory-final/audit-experiments.json)。复跑的词法微基准受同期任务负载影响，不能与第 3 节做版本性能比较。

### 9.2 新入站文件的实际覆盖与限制

`inbound-files.test.mjs` 通过实际 protocol 模块与合成加密响应验证：type-6 文件识别、精确 uint64 原消息编号、私有下载 locator 不进入消息正文/桥接公共元数据、引用不凭空生成原附件、来源会话/方向/接收时间边界、64 KiB 分片组装、长度/offset/MD5 检查、断开/换账号/取消拒绝晚到缓存以及 CGI 221 响应账号和加密完整性。

`received-files.test.mjs` 通过实际模块、临时文件与合成通道验证：DOCX 中文/实体/emoji/表格顺序；忽略删除修订及域指令；损坏/加密/重复成员/目录穿越/超限 XML 拒绝；同名文件不擅选；模型不能指定其他账号/会话/URL/路径；下载字节和 SHA-256 核验；取消与撤权；原生工作目录只读策略；输入不自动当成果回传；渐进发现；单独发文件只记元数据，引用文件后实际调用工作工具读取预算。

这些是可执行的合成协议和业务链路测试，**没有本次真实微信附件下载成功的证据**。当前只支持普通 attachId 路由；CDN-only/@cdn_ 明确不支持，超过 20 MiB 或缺少明确长度不能下载。正文读取支持 `.docx`，不等于 `.doc`/PDF/OCR/任意压缩包或保真 Office 渲染；正文、表格文字以外的范围要单独说明。独立 DOCX 实验确认 `w:numPr` 自动列表编号不会生成可见编号文字，不能把“文字已读取”解释为“编号和版式完整还原”。

### 9.3 新文件的优化方向及可复现问题

本表记录 02:40–02:43 UTC 收尾版本的发现。FILE-01/F13 随后由并行工作修复，最新探针已经拒绝同长度损坏，参见 9.4；其余优化方向保留。

| 方向 | 证据与建议 | 验收 |
|---|---|---|
| **FILE-01 / 主报告 F13：缓存完整性（初始 P1；最新当前复现已关闭）** | 当时的 `file-loader.mjs` 允许来源无 MD5，缓存复用只校验长度和可选 MD5。隔离实验首下载 `ABCD` 后，把 `.file` 等长改为 `WXYZ`，再次读取仍 `cached:true`，返回重算的新 SHA-256。首次可信下载的 SHA 未被独立固定，fresh read 无法发现同长度本地损坏。由此提出首次下载持久化源消息绑定 SHA-256，复用时比较；该方向已在后续源码实现并复核。 | 有/无 MD5，等长/异长损坏、掉电只写一份元数据、缓存旧版本、两个并发下载；任何损坏都不被作为原附件成功返回。旧实验仅证明当时的本地缓存损坏路径，不证明真实网络攻击或用户文件已损坏。 |
| **FILE-02：整任务预算（P1）** | 合法 100 项长文件名列表实际返回 **33,277 字符**。列表需要摘要总预算和可继续发现的分页，不能仅限制每个文件名/总条数。 | 0/100/101 项、长 Unicode 文件名、多同名；结果有界且所有可见文件都能定位。messageId 定向读仍应绕开列表截断，不靠猜 ID。 |
| **FILE-03：解析缓存与 IPC（P2）** | 18,000 Unicode 字符 DOCX 准确重建为 3 页，但出现 **3 次 list + 3 次整文件 download access**，每页重新解压和解析。当前 worker 可命中磁盘缓存，因此这不是重复网络下载证据。建议按源消息+sha256+解析器版本缓存提取结果，分页只传短文本；缓存命中仍检查账号/会话/时间/撤权/原字节版本。 | 大文件 1/10/100 页的 CPU、RSS、IPC 字节与端到端耗时；解析一次、准确重建、内容变化与撤权立即失效。不得用跨账号全局缓存直接复用授权结果。 |
| **FILE-04：持久文件清单与清理（P1/P2）** | `receivedFiles` 查询依赖 protocol 最近 5,000 条消息，缓存描述与原文件却单独存放；大量新消息后可能仍有原文件但无法发现，另有磁盘累计。建议独立按消息键索引、范围游标和明确保留期/清理状态。 | 超过 5,000 条消息、重启、清理中读取、过期引用；可读/已删除/过期/从未观察必须不同，不能把磁盘还在说成一定可读，也不能自动恢复用户已清理附件。 |
| **FILE-05：DOCX 语义完整性（P1）** | 当前正确限定为正文/表格文字；自动编号、脚注尾注、公式、文本框、修订/批注、图片和扫描件需更细粒度 coverage。先明确不支持和遗漏，再按需求逐项扩展，而不是套通用“读取成功”。 | 用普通 Office 生成、WPS/LibreOffice、不同 OOXML namespace 的独立固定语料；同时核对文字、表格顺序、编号和遗漏标记。parser goldens 不仅由同一 `wordFixture` 生成器提供。 |
| **FILE-06：解析资源与不可信输入（P1）** | 已有 20 MiB 包、64 MiB声明展开、2,048 entries、16 MiB XML、2M字符及128层 render限制。下一步关注限制前 XML 校验/解析的 CPU、内存与取消响应，扩展 ZIP/XML fuzz。 | 深嵌套、压缩比、重叠数据区、CRC损坏、实体声明、未知part；worker/隔离线程资源受限，超时不冻结聊天线程；文档文字中的工具指令不扩大权限。 |
| **FILE-07：真实协议兼容性（P1）** | CGI 请求/加密的合成测试证明代码按当前契约工作，尚未覆盖真实 PC/移动端、群/私聊、重发/转发/过期、不同大小及 CDN-only 来源。 | 使用专用测试账号逐项记录来源客户端、实收ID、实际字节hash与支持状态；未支持路由给可执行恢复建议，不把普通URL/attachId/CDN密钥互换。 |

新实验详情见 [file-experiments.json](../../storage/logs/harness-audit-2026-11-11/memory-final/file-experiments.json) 和同目录 `.mjs`。实验全部使用本目录内的合成缓存、DOCX 和固定假数据，真实微信消息、模型调用与网络下载均为 0；缓存损坏 fixture 保留便于复核。

FILE-01 的核心复现契约为：写入 `version:1`、正确 `resourceId = sha256(peerId + ':' + messageId)`、`direction:'incoming'`、`bytes:4`、`md5:''` 的描述；调用实际 `loadObservedFile` 下载 `ABCD`；将同一缓存文件改为 `WXYZ`；第二次调用让 download 回调直接失败以保证只走缓存，结果仍成功且 SHA 改变。修复后的验收应拒绝第二次读取，而不是接受新 SHA 作为原始附件依据。

### 9.4 最后一轮完整性修复复核

02:48 UTC 左右另一路并行工作修改了 `file-loader.mjs`：首次下载写入 `.integrity.json`，固定 `source = sha256(原描述字节)`、长度和首次文件 SHA-256；缓存复用验证三者及当前文件摘要，没有完整性记录的旧缓存重新下载；下载期间描述变化也拒绝发布。`wechat_file read` 同时新增明确的 `contentRead: true`。

再次使用独立目录 [memory-latest](../../storage/logs/harness-audit-2026-11-11/memory-latest/) 运行关键差异探针，保留前两阶段所有证据。最新 [file-experiments.json](../../storage/logs/harness-audit-2026-11-11/memory-latest/file-experiments.json)（`2026-11-11T02:57:12.752Z`）确认：缺 MD5 的 `ABCD → WXYZ` 等长修改抛出 `FILE_INTEGRITY_FAILED`，`mutationAcceptedAsCached: false`，完整性文件中的 SHA 仍与首次 `ABCD` 一致。FILE-01/F13 的已知当前复现因此关闭；这不等于断电与所有并发故障矩阵已全部覆盖。

同目录 [audit-experiments.json](../../storage/logs/harness-audit-2026-11-11/memory-latest/audit-experiments.json)（02:57:13 UTC）再次确认 M-01 仍闭合：before 查询 0、未来图片读取拒绝、视觉调用 0。M-02/M-03/M-04/M-05 在这一版本仍成立。文件 read 每页的 `contentRead:true` 也通过断言；100 项列表仍为 33,277 字符，18,000 Unicode 正文仍以 3 页准确重建且产生 3 次整包 access，FILE-02/03 的优化方向未改变。

本阶段专项命令为：

```powershell
node --test tests/inbound-files.test.mjs tests/received-files.test.mjs tests/outbound-media.test.mjs
```

**实际结果：98 tests，98 pass，0 fail/cancelled/skipped/todo；344.856 秒，退出码 0。** 按日志中的用例边界统计：入站文件 21 项、出站媒体 66 项、接收文件 11 项。日志见 [targeted-tests.log](../../storage/logs/harness-audit-2026-11-11/memory-latest/targeted-tests.log)。耗时受同期工作负载影响，不能作为端到端性能基准。

本轮启动快照为 `2026-11-11T02:56:54.444Z`，见 [source-manifest.json](../../storage/logs/harness-audit-2026-11-11/memory-latest/source-manifest.json)。结束后于 `03:03:42.922Z` 核对 16 项，**13 项一致，3 项被外部工作再次更新**，见 [source-verification.json](../../storage/logs/harness-audit-2026-11-11/memory-latest/source-verification.json)。因此 98/98 记录为本次启动阶段的成绩，不能标成最后文件快照已冻结验收。F13 的 `file-loader.mjs` 及 M-01 的两个图片源文件仍与启动时一致，已知复现保持关闭。前后阶段完整摘要另见 [source-stage-comparison.json](../../storage/logs/harness-audit-2026-11-11/memory-latest/source-stage-comparison.json)；表内为 SHA-256 前 12 位，完整值保存在上述 JSON：

| 文件 | 02:40 阶段 | 02:56 启动 | 03:03 结束核对 |
|---|---|---|---|
| `backend/wechat/protocol/file-loader.mjs` | `863373c52f36` | `8690fa22ffad` | `8690fa22ffad` |
| `backend/wechat/protocol/file-download.ts` | `c3b154d5e28b` | `79431c646b85` | `79431c646b85` |
| `modules/tools/files.mjs` | `93f41b5c599a` | `6957a679037d` | `e6f033e4ec60` |
| `tests/inbound-files.test.mjs` | `101178996485` | `9eb6976f2fc9` | `9eb6976f2fc9` |
| `tests/received-files.test.mjs` | `3b947d178be5` | `2f0208ca53b9` | `0d538c23ce5f` |
| `tests/outbound-media.test.mjs` | 未纳入该次清单 | `8462ce80f788` | `8462ce80f788` |
| `lib/testing.js` | `2ecfc7d11c17` | `53a23153b5f0` | `d2d053595c78` |

测试构建完整 SHA-256：本轮启动为 `53a23153b5f015ccb1337be58fa2159d72a1f7c39f0f13438c244ded59c89e00`，结束核对为 `d2d053595c78702a86857a60c0716741c5557f00762730fbe379d5bf4366455e`。不继续无限追逐外部重建，也不覆盖先前日志。

最后对这三项变动仅做只读核对：当前文件工具把选择条件及分页参数（`messageId/name/offset/limit/revision`，含 read 的默认 offset/limit）写入 `onOperation`；当前 bundle 的 `sameAttempt` 对 `wechat_file` 逐项比较 action 与这些参数，只有同一次读取成功才能恢复此前失败，单独 list 也不算有用的工作成果。当前 `received-files.test.mjs` 新增第 12 项测试，以合成操作验证成功 list、另一附件、另一页或 download 均不能覆盖失败 read，相同 read 重试成功可以恢复；**这项新增用例不在本轮 98 项日志中，尚未由本专项执行验证**。

该最新变化后续仍需冻结版本再验证：真实文件工具产生的 selection 是否完整进入操作记录和持久化；name/limit/revision 变化与默认参数归一；失败后取消/撤权与重试；旧任务操作记录兼容。这里只记录优化方向和证据边界，不把静态阅读等同于这些链路已经通过。

**11:06（北京时间）后续状态：** 运行时专项确认另一路更新已把 `wechat_file` 加入 `WorkStore` 操作白名单。因此文件工具触发 F02 重载失败属于 10:40 阶段的历史证据，不能继续作为当前文件分支的断言；另外四个既有工具缺失的问题仍需分别处理。文件分支的最终最小复验及 F02 整体状态以[运行时审计附录](HARNESS-RUNTIME-AUDIT-2026-11-11.md)为准，本专项不扩测，也不把这次更新追记为此前 98 项已经验证。
