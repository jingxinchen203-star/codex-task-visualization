# Codex Projectboard 设计规格

状态：对抗性审查修订版
日期：2026-08-08
目标平台：Windows 版 Codex 桌面应用 `26.730.8199.0` 起
目标用户：在单机上同时管理多个 Codex 项目和任务的个人用户

## 1. 问题定义

Codex 当前以对话为主要入口。对话适合执行，却不适合表达长期工作的结构。随着项目和历史对话增多，用户难以快速回答以下问题：

1. 我有哪些项目？
2. 每个项目下一步该做什么？
3. 哪些任务正在运行、被阻塞或等待我验收？
4. 某个结果来自哪条对话、哪个分支、哪次验证？

产品的核心工作不是“把对话整理进看板”，而是让用户：

- 在 15 秒内找到当前最值得继续或最需要处理的工作。
- 在 30 秒内恢复上次目标、结果、阻塞点和明确下一步。
- 无需重新阅读长对话即可判断继续、暂停、验收或归档。

本产品不把聊天列表换一种皮肤重新展示。它建立一个更稳定的工作模型：

```text
项目 Project
  └─ 任务 Task
       └─ 执行 Run
            ├─ 主 Codex 线程
            ├─ 辅助 Codex 线程
            └─ 验收证据
```

对话是执行记录，不是项目管理的主对象。Project、Task 和 Run 是对原始线程与事件的可重建投影，不是另一份不可回溯的事实源；其中 Task 是用户面对的工作单元，Run 默认只在详情和故障诊断中出现。

## 2. 第一性原则

### 2.1 降低认知负担

默认视图只展示用户主动恢复的项目和任务。历史导入不能把原有的对话噪声搬到新界面。

### 2.2 原始记录可恢复

自动聚类、去重和归档只改变 Projectboard 的本地索引，不自动归档、改写或删除 Codex 原始线程。

### 2.3 状态必须代表事实

卡片进入“待验收”必须有完成摘要、改动范围、验证结果和风险说明。卡片进入“完成”必须由用户确认。

### 2.4 自动化不能扩大损害

并行写代码必须隔离。任何自动执行、Git 操作和故障恢复都必须避免重复运行、覆盖工作区或静默丢失数据。

### 2.5 易碎边界必须最薄

CDP 只负责向 Codex 左侧导航增加入口并挂载本地界面。线程、任务、事件和审批尽量通过官方 Codex App Server 与本地服务完成。

### 2.6 投影可重建，用户决策可带走

自动分组、摘要和建议可从原始线程重新计算；用户做出的命名、拆分、恢复、固定、排序和状态覆盖作为独立事件保存。系统必须支持 JSON 导出/导入与从零重建，不把用户的整理劳动锁在某个模型版本或数据库 schema 中。

### 2.7 先证明风险，再扩大权限

读取历史、展示看板、驱动 Codex、写 Git worktree 是四个逐级扩大的权限层。后一层只有在兼容性、安全性和用户价值指标通过后才启用；失败时保留前一层可用能力，而不是让整个产品不可用。

## 3. 目标与非目标

### 3.1 产品目标形态

- 注入用户日常使用的 Codex 窗口，不创建第二套用户配置。
- 自动扫描全部 Codex 历史线程。
- 把历史线程聚类成项目，再在项目内聚类成任务。
- 所有导入项目和任务默认进入归档，由用户手动恢复。
- 折叠高置信重复线程，保留最新记录作为主记录，其他记录可展开和恢复。
- 提供“项目看板 → 项目内任务板 → 任务详情”三个界面层级。
- 项目内使用五条等宽、全高纵向泳道：收集箱、已规划、执行中、待验收、完成。
- 从任务板创建、恢复、中断 Codex 执行。
- 全局最多并行执行 3 个 Run。
- 写代码任务默认使用独立 Git worktree。
- 展示分支、worktree、diff、测试结果和风险说明。
- 任务需要处理或等待验收时发送 Windows 通知。
- 注入失效时保留独立浏览器看板作为降级入口。

### 3.2 分阶段交付与放权

完整目标不一次性上线，而按以下闸门交付：

#### Phase 0：兼容性与安全试验

- 只做测试夹具，不承载真实项目管理数据。
- 验证 Codex 启动与注入、App Server 账户/数据根一致性、本地 API 防护、审批、双写和命令关联能力。
- 输出机器可读兼容矩阵、失败证据和明确的 Go/No-Go 结论。

#### Phase 1：只读整理与恢复

- 渐进扫描全部历史，全部结果仍按用户决定进入归档。
- 提供项目视图、五列任务板、归档整理、搜索、去重建议、跨项目“需要我处理”和恢复包。
- 只允许打开或继续原生 Codex 线程，不自动创建 turn，不写 Git。
- CDP 注入通过 Phase 0 时作为日常入口；未通过时由独立本地窗口提供相同 UI。

#### Phase 2：辅助聚类与手动执行

- 在固定基准、许可证和资源预算通过后启用本地语义聚类。
- 在 App Server 身份与协议闸门通过后，允许从任务详情手动创建/恢复/中断 Run。
- 仍不自动执行，仍不自动写 Git worktree。

#### Phase 3：受控自动执行

- 在幂等关联、审批、双写控制、崩溃恢复和 Git 隔离均通过独立安全评审后，启用最多 3 个并发 Run、5 秒撤销与可选项目级自动运行。
- 自动执行和 worktree 可被全局立即关闭；降级不影响看板与历史索引。

### 3.3 当前产品范围明确不做

- 团队账号、角色与云同步。
- 手机端。
- 公共插件商店发布。
- 自动合并代码。
- 自动删除分支或 worktree。
- 自动归档、改写或删除 Codex 原始线程。
- 复制完整 Codex 对话正文到 Projectboard 数据库。
- 从 dashi-taskboard 或其 Launcher 复制源代码、资源或未授权实现。

## 4. 用户体验

### 4.1 Codex 内入口

伴随程序通过 CDP 在 Codex 左侧原生导航中增加“任务面板”。它不替换原生项目、对话、插件、站点或设置入口。

选择“任务面板”后，Projectboard 占据 Codex 的完整主工作区。切回任意原生页面时，原页面和上下文恢复。

### 4.2 页面层级

#### 需要我处理

Codex 侧栏入口显示待处理计数。进入后先看到一个紧凑的跨项目注意力条，而不是被迫逐个项目寻找异常。它按以下顺序汇总：

1. 等待审批。
2. 待验收。
3. 阻塞或控制权冲突。
4. 执行失败或状态未知。
5. 长时间没有进展但仍为活跃的任务。

每项必须直接显示项目、任务、等待原因、年龄、建议下一步和来源；点击后定位到对应任务详情。Windows 通知深链到同一个条目。注意力条是辅助入口，不取代用户确认的项目看板和五列任务板。

#### 项目看板

顶层项目状态为：

- 活跃
- 暂停
- 已归档

首次导入的所有项目进入“已归档”。用户将需要继续的项目拖入“活跃”或“暂停”。项目卡层级为“项目名 → 唯一最高优先注意项/下一步 → 辅助计数与最后活动时间”。活跃项目按“等待用户操作 → unknown/blocked → 待验收 → 活动 Run → 最近活动”排序。

为避免“归档墓地”把整理工作重新推给用户，归档页提供一个按最近活动和可恢复价值排序的“建议恢复”队列。每次最多展示 5 个候选及理由、置信度和最近结果；系统绝不自动把候选移到活跃区，最终仍由用户拖动或点击恢复。

#### 项目内任务板

主工作区由五条等宽纵向泳道铺满。每条泳道从固定标题延伸到窗口底部：

1. 收集箱
2. 已规划
3. 执行中
4. 待验收
5. 完成

每列独立纵向滚动。空列仍保留全高的结构边界，因此五块始终填满工作区；顶部只放紧凑说明和一个主操作，剩余区域不画夸张空卡片，只有拖动时才显露完整落点。

可用内容宽度不小于 1440px 时，五列等分并完整铺满主工作区；这就是产品的标准形态。低于 1440px 或在高倍缩放下，切换为单列状态视图：顶部固定显示五个状态标签、数量和注意项数量，正文一次展示一列。五种状态始终可达，但不强迫用户同时处理页面横向滚动和五列独立纵向滚动。列标题保持粘性，始终显示当前项目名称和“第 N/5 列”。

任务卡固定为：两行内标题、一句下一步或注意信息、最多三个与当前决策相关的元数据。泳道只表达 Task 状态；Run 状态使用文字加图标的独立标签，例如“执行中 · Run 已完成，验证失败”。分支、diff 和测试徽章只在与当前决策相关时出现。

历史任务保存在独立的“归档抽屉”中。用户可以把归档任务拖入“收集箱”或“已规划”。

完成列默认只展示最近一个可配置周期，旧完成项通过“查看全部完成”访问；这只是视图折叠，不自动改变 `archived`。

#### 任务详情

任务详情是决策界面，而不是日志仓库。信息顺序固定为：

1. 固定标题区：目标、Task/Run 状态和唯一主操作。
2. 当前注意事项与恢复包。
3. 当前状态专属主体。
4. 次级诊断信息与完整时间线。

其中待验收默认展示验收清单、改动摘要、验证结果、风险，再展示原始命令、线程和时间线；“通过/驳回”固定在底部。宽屏使用侧面板保留看板上下文，窄屏使用整页；返回时恢复项目、列滚动位置、选中卡片和焦点。

任务详情包含：

- 目标、验收标准和优先级。
- 当前状态与 Run 状态。
- 主线程和辅助线程。
- 分支、worktree 和 diff 摘要。
- 验证命令、退出码和结果。
- 风险、遗留项和阻塞原因。
- 恢复包：目标、上次结果、下一步、为何现在处理、阻塞点和证据引用。
- 活动时间线。
- 打开原 Codex 对话、驳回并反馈、通过验收等操作。

### 4.3 视觉与交互

- 采用 Codex 原生紧凑风格，弱品牌、低干扰。
- 自动跟随 Codex 浅色/深色主题。
- 五列平均使用主工作区宽度，不使用漂浮的大型列容器。
- 列之间使用细分隔线；任务卡只承担内容边界。
- 支持鼠标拖放与完整键盘操作。
- 所有拖放操作提供可见落点；自动执行前提供 5 秒撤销窗口。
- 只在“需要用户处理”和“待验收”时发送系统通知。
- 拖放不是唯一操作方式：每张卡提供“移动到…、上移、下移”菜单。可选键盘拖放模式为 Ctrl+Space 拾取、方向键选择位置、Enter 放下、Escape 取消，并通过 aria-live 宣告“已移动到待验收，第 2/7 项”。移动后焦点跟随卡片，DOM 顺序与视觉顺序一致，虚拟列表不得卸载聚焦项。
- 每列是有名称的 region，卡片是有位置和状态描述的列表项；焦点不因重排、归档或异步刷新而丢失。
- 颜色不单独承载状态；所有图标配文字或辅助文本。200% 缩放时保留主要操作且不出现双向内容裁切。
- 实时更新不得抢焦点、改变用户正在操作的排序，或把卡片从指针下移走；冲突时恢复权威状态，并在原位置解释原因。
- 视觉 token 不依赖宿主私有 CSS；正文与控件满足至少 4.5:1 对比度、可见焦点和减少动画偏好。

### 4.4 界面状态矩阵

| 状态 | 界面行为 |
|---|---|
| `loading` | 保留导航和已有本地数据，原位显示进度，不使用阻塞全屏 spinner。 |
| `empty` | 明确空的是哪个范围，只给一个主操作；首次导入后的空活跃区主操作是“整理已导入内容”。 |
| `partial` | 显示“已处理 X/Y”，已有内容可用，后台结果不让当前列表跳位。 |
| `offline/read-only` | 显示最后同步时间、受影响能力和恢复入口，只禁用依赖失效服务的操作。 |
| `error` | 在出错组件内展示原因、重试和诊断入口，不拖垮无关区域。 |
| `blocked/failed/unknown` | 展示原因、证据和唯一下一步，不仅使用颜色。 |
| `success` | 安静原位确认；可逆的安全操作提供撤销。 |

状态变化使用 `aria-live="polite"` 宣告。系统通知按任务去重合并并深链；“已读”不等于“已解决”，注意事项会持续保留到事实状态变化。

## 5. 领域模型

### 5.1 Project

关键字段：

- `id`
- `name`
- `status`: `active | paused | archived`
- `repository_identity`
- `workspace_paths[]`
- `auto_run_enabled`
- `created_at`, `updated_at`

`repository_identity` 不能只依赖工作目录字符串。对于 Git 仓库，应优先使用规范化的 Git common directory、远端标识和文件系统大小写规则，避免同一仓库的不同 worktree 被误判为不同项目。

### 5.2 Task

关键字段：

- `id`, `project_id`
- `title`, `objective`, `acceptance_criteria`
- `state`: `inbox | planned | running | review | done`
- `archived`
- `priority`, `sort_order`
- `task_kind`: `code_write | code_read | non_code`
- `verification_profile_id`
- `branch_ref`, `worktree_path`
- `next_action`, `next_action_owner`
- `next_action_confidence`, `next_action_source`, `next_action_updated_at`
- `state_source`: `user | run | reconciliation | import`
- `last_reconciled_at`, `manual_override_reason`
- 乐观版本号与时间戳

`state` 与 `archived` 正交。归档任务不出现在五列中，但保留原状态，恢复时由用户选择落入收集箱或已规划。

`next_action` 在 turn 完成、Run 结束、用户反馈或相关线程外部更新后刷新。低置信建议必须标明“待确认”；超过失效阈值后显示 stale，不得把旧建议静默伪装成当前事实。

### 5.3 ResumePacket

每个活跃 Task 保存一个可追溯的恢复包：

- `goal`
- `last_outcome`
- `next_action`
- `why_now`
- `blocker`
- `evidence_refs[]`
- `source_thread_revisions[]`
- `generated_at`, `confirmed_at`

恢复包是有限摘要，不是完整对话副本。每个字段可以回到来源线程和修订点；用户修正后的值作为人工决策事件保存，自动刷新不能静默覆盖。

### 5.4 ThreadLink

关键字段：

- `task_id`, `thread_id`
- `relation`: `primary | supporting | imported`
- `source_cwd`, `source_title`
- `created_at`, `updated_at`

Projectboard 保存线程引用和有限摘要，不复制完整线程内容。

### 5.5 Run

关键字段：

- `id`, `task_id`, `thread_id`
- `status`: `queued | countdown | starting | running | approval_pending | blocked | failed | completed | interrupted | unknown`
- `attempt_number`
- `started_at`, `finished_at`, `heartbeat_at`
- `app_server_instance_id`
- `error_code`, `error_summary`

Task 状态和 Run 状态分离。例如 Task 可以留在“执行中”，同时 Run 标记为 `blocked`。

### 5.6 Evidence

关键字段：

- `run_id`
- `kind`: `summary | diff | command | test | risk | manual_check`
- `label`, `payload`, `exit_code`
- `recorded_at`
- `source`: `agent | system | user`

Agent 提交的证据是声明，不能单独满足验收门槛。要求执行的验证命令必须由 Core verifier 在绑定的 worktree、base/commit 和任务身份上运行，并生成不可变的 `source: system` 证据。Agent 可以请求推进到待验收，但没有权限把任务推进到完成。

### 5.7 ApprovalRequest

关键字段：

- `id`, `app_server_instance_id`, `session_id`
- `thread_id`, `turn_id`, `item_id`
- `request_digest`, `scope`, `cwd`, `command_preview`
- `status`: `pending | approved | denied | expired | invalidated`
- `expires_at`, `responded_at`, `responded_by`

审批永不自动通过，只有 `human-ui` 主体能响应。实例、摘要或权限范围变化后旧审批立即失效；重复响应幂等，断线或重启后先向 App Server 对账。审批界面展示完整命令、工作目录、网络/文件权限与风险。

### 5.8 DuplicateSet

关键字段：

- `id`
- `canonical_thread_id`
- `confidence`
- `reasons[]`
- `created_at`

成员通过 `DuplicateSetMember(duplicate_set_id, thread_id)` 关联表保存，不在单列中存数组。重复折叠是视图关系，不合并或删除线程记录。用户可以拆分错误分组。

### 5.9 UserDecisionEvent

用户命名、固定、恢复、归档、排序、拆分、合并建议和状态覆盖都记录为追加式事件。自动投影可重算，但不得覆盖这些决策；JSON 导出包含事件、稳定 ID 和 schema 版本，不包含完整原始对话正文。

## 6. 历史导入与聚类

### 6.1 输入范围

通过 Codex App Server 的 `thread/list` 分页读取活动和已归档线程。对每条线程只提取：

- ID、标题、时间。
- `cwd`、Git 信息和来源类型。
- 已有摘要。
- 必要时少量首尾内容，用于本地分类。

全历史最终都会被扫描，但采用渐进顺序：最近活动、待审批/待验收和用户固定的线程优先，旧历史随后在后台补齐。首次导入提供“待整理”派生视图，展示进度、数量、推荐恢复项和聚类理由；底层记录仍全部保持 `archived`，不会因推荐而自动进入活跃区。

### 6.2 两阶段导入

#### 快速确定阶段

先用低成本、可解释的规则生成首屏结果：

1. 规范化 cwd 和仓库身份。
2. 按仓库或明确目录形成 Project。
3. 使用标题规范化、时间和内容指纹识别完全重复或近似重复。
4. 所有结果写入归档区。

每次扫描具有 `scan_generation` 和高水位 `(updated_at, thread_id)`。主扫描结束后执行 catch-up pass，吸收扫描期间发生的更新。`thread/read` 只用于歧义候选并有总量与并发预算；分页失败使用有上限的指数退避。

#### 后台语义阶段

对没有明确项目目录的线程和项目内任务意图进行本地语义聚类：

- 语义模型是可选模型包，不是启动依赖；使用可离线运行、允许重新分发的紧凑型多语言 ONNX 编码器。
- 只处理标题、摘要和有限首尾片段。
- 不为聚类额外把正文上传到远端模型。
- 模型按准确率、内存、包体积和许可证基准选型；必须固定名称、版本、许可证、SHA-256、下载/离线策略和 CPU/RSS 上限，并通过仓库内固定中文/英文样本集。
- 模型不可用时，产品仍可使用规则聚类和手动整理。
- 向量按内容 hash 与模型版本增量缓存，候选生成必须有界，不能全量 O(n²) 比较。
- 语义阶段只产生待确认建议，不移动用户已恢复、重命名、拆分或手工归类的对象；当前会话不自动重排可见列表。模型升级只显示“发现 N 条整理建议”，并提供理由、接受和拒绝。

### 6.3 去重规则

只有高置信匹配才自动加入 DuplicateSet。判断信号包括：

- 相同仓库或目录身份。
- 规范化目标高度相似。
- 摘要/片段指纹高度相似。
- 时间关系与执行结果一致。

每组保留最近更新的线程作为主记录。界面展示置信度和原因，并允许一键拆分。

### 6.4 可恢复性

- 导入使用 `thread_id` 作为幂等键，重复扫描不产生重复行。
- 分页游标和阶段检查点持久化，导入可中断续跑。
- 自动操作写入活动日志。
- 扫描失败不会影响已完成的导入结果。
- 用户决策事件可独立导出；删除自动投影并重新导入后，应能重放这些事件得到等价的人工整理结果。

## 7. 任务状态机与执行

### 7.0 状态所有权与转换交互

- 用户负责 `inbox`、`planned`、显式归档/恢复和最终 `done`。
- `running`、阻塞、失败、状态未知和待验收资格由 Run、Core verifier 与 reconciliation 事件派生。
- 外部 Codex 更新会刷新 `last_reconciled_at`；无法对账时显示“状态可能过期”，不伪装成实时事实。
- 用户可显式覆盖派生状态，但必须记录 `manual_override_reason`；新事实到来时系统提示冲突，不静默覆盖人工决定。

状态菜单和快捷操作是主路径，拖放只是快捷方式。同列排序可直接生效；跨状态放下后先显示转换确认面板，服务端状态在确认前不改变。若缺少前置字段，在原位置打开补全表单；非法落点显示原因，不先移动再弹回。

| 目标状态 | 前置条件 | 副作用 | 确认与失败恢复 |
|---|---|---|---|
| 收集箱 | 所属项目 | 无 | 直接确认；保留原排序锚点以供撤销。 |
| 已规划 | 目标、验收标准、工作目录、任务类型；写任务需验证命令 | 无 | 缺失字段原位补全。 |
| 执行中 | 已规划条件 | Phase 1 无；Phase 2 可手动启动；Phase 3 可按项目设置倒计时启动 | 明确展示本次是否会创建 Run，失败时任务留在执行中并显示原因。 |
| 待验收 | 正常 Run、system 验证证据、摘要与风险 | 无 | 仅由 Core 事实门禁进入。 |
| 完成 | 当前为待验收 | 锁定本次验收记录 | 仅 human-ui 明确通过；支持重新打开但保留历史。 |

### 7.1 状态进入条件

#### 收集箱

只要求标题和所属项目。不会启动 Codex。

#### 已规划

必须有：

- 非空目标。
- 可判断的验收标准。
- 有效工作目录。
- 任务类型。
- 对代码写入任务，至少一个已确认验证命令。

#### 执行中

任务可以先被拖入执行中而尚未启动。卡片显示“尚未启动”和“启动 Codex”。

`auto_run_enabled` 默认 `false`。首次启用或首次高风险执行必须明确说明“拖入执行中会启动 Codex”并由用户确认。启用后，拖入执行中先进入 5 秒倒计时；倒计时结束才创建 Run 和线程。倒计时同时常驻卡片和全局运行栏，提供可聚焦的“取消启动”；撤销不会产生线程，短暂 toast 不能作为唯一保护。

#### 待验收

必须满足：

- Codex Run 正常完成。
- 任务要求的验证命令全部运行并通过。
- 已记录完成摘要、改动范围、验证证据和风险说明。

非代码任务必须提供显式的人工检查证据，不能伪造“测试通过”。

#### 完成

只有人类 UI 会话能执行。Agent Skill 或 MCP 工具无法调用这一转换。

### 7.2 调度

- 全局最多 3 个活动 Run。
- 手动启动优先于自动队列。
- 同优先级按入队时间排序。
- 每个 Task 同一时刻最多一个活动 Run。
- `starting | running` 占用执行槽；`queued | countdown | blocked | approval_pending | unknown` 不占执行槽。等待审批超过有效期后转为 blocked 并释放槽位；unknown 必须在全局注意力入口持续显示，直到人工对账。
- 手动启动可越过尚未产生副作用的自动 `queued/countdown` 项，但不得自动 interrupt 已运行 turn。
- 调度器对每个 Run 使用租约、心跳和 fencing token。
- 产生外部副作用前，必须在 durable command journal 中持久化 `dispatch_intent`、client request ID、fencing token 和请求摘要；确认后再记录远端 thread/turn ID。状态变化和 outbox 在同一事务提交。
- 重启后先按关联 ID 对账，不直接重放。无法证明“尚未执行”的命令标记为 `unknown`；若协议没有幂等键或可检索关联元数据，保证降级为 at-most-once + 人工恢复，而不是承诺 exactly-once。
- 无法确认的旧 Run 标记为 `unknown`，等待用户处理。

### 7.3 线程策略

- 首次执行创建主线程。
- 验收驳回时，把用户反馈发送到原主线程并重新排队。
- 用户明确选择“新尝试”时才 fork 新线程。
- 辅助分析或审查线程作为 supporting link 保存。
- 只有协议提供原子线程 lease 或 conditional start 时，Projectboard 才能直接恢复可能在原生 Codex 中写入的线程。
- 若协议不提供原子控制，Projectboard 驱动的线程必须为专用线程；原生 Codex 可查看，但用户需要显式转移控制权后才能在另一端开始下一次 turn。
- 检测到未知作者的并发 turn 时暂停自动操作，不自动 interrupt 任一方，并要求用户选择控制权。

### 7.4 Worktree 策略

- `code_write` 任务默认创建独立 worktree。
- 分支使用 `taskboard/<task-id>-<ascii-slug>`，slug 经过长度和字符限制。
- 默认 worktree 根目录使用短路径、可配置的本地目录，避免 Windows 路径长度问题。
- 任务入队时冻结 `base_oid` 和 base ref；真正创建前再次校验，不能从排队后变化的隐式 HEAD 建分支。
- 每个仓库的 Git 写操作串行化；使用 `git check-ref-format`、`git worktree list --porcelain` 与数据库唯一约束防止 ref/path 重复。
- 仓库正在 merge、rebase、bisect 或存在 Git 锁时，阻止自动创建。
- worktree 只能位于专用根目录；路径规范化后必须仍被该根包含，拒绝 junction/symlink 越界，并记录 owner task、base OID、branch 和 path。
- 非 Git 项目或 `code_read` 任务可以使用原目录，但界面明确显示没有隔离。
- 不自动 stash、reset、merge、删除分支或删除 worktree。

## 8. 技术架构

```text
Windows 登录
  └─ Companion
      ├─ 启动 Taskboard Core
      ├─ 以同一用户配置启动 Codex + 调试 pipe（端口仅作显式风险降级）
      ├─ 识别目标 Codex 进程与主 renderer
      └─ 注入侧栏入口 + 本地 UI 容器

Codex renderer
  └─ Projectboard UI
      └─ Local HTTP API + Event Stream
          └─ Taskboard Core
              ├─ SQLite Repository
              ├─ Import & Clustering Engine
              ├─ Scheduler
              ├─ Git Adapter
              ├─ Notification Adapter
              └─ Codex App Server Adapter
                  └─ child process over stdio

Codex Plugin
  ├─ manage-projectboard Skill
  └─ taskboard MCP stdio shim
      └─ authenticated loopback call to Taskboard Core
```

### 8.1 Companion

- Windows 登录自启动必须由用户在安装时选择。
- Companion 复用原 Codex 账户、项目和数据目录。
- 如果 Codex 已经以无 CDP 模式运行，不强制结束进程；显示“一键重启并启用任务面板”。
- 通过 Windows 应用身份/AppUserModelID 与受支持的启动 API 发现应用；不得硬编码版本化 `WindowsApps` 路径或假定可执行文件名始终为 Codex。当前观察到的包身份为 `OpenAI.Codex`，实际主程序为 `app/ChatGPT.exe`，这只作为兼容性样本，不作为永久契约。
- 显式记录启动请求、包族、启动 PID、用户数据根和端口/pipe 发现结果；校验连接目标属于本次启动的预期包与 renderer。
- 优先验证 `remote-debugging-pipe`；只有 pipe 不可行且用户明确接受本机进程可连接风险时，才使用随机 loopback CDP 端口。随机端口不是认证机制。
- renderer 替换后重新挂载；重复注入必须无副作用。

### 8.2 CDP 注入器

CDP 注入器只做以下操作：

1. 定位稳定的原生导航语义标记。
2. 增加“任务面板”入口。
3. 选择入口时隐藏原主内容并挂载本地 UI。
4. 切回原生页面时恢复原状态。

它不修改 Codex 安装文件、`app.asar`、React 私有模块、网络请求或 Codex 数据库。

注入内容必须在原有 CSP 下运行，不允许调用 `Page.setBypassCSP`。若无法在不削弱宿主 CSP 的前提下挂载界面，则停止注入并打开独立本地 UI；不得为了保留侧栏形态扩大整个 renderer 的脚本权限。

### 8.3 Taskboard Core

- 单机权威业务服务。
- 负责数据库、状态转换、调度、导入、聚类、Git 查询、通知和审计日志。
- 所有状态转换在服务端验证，不能依赖前端或 Skill 自觉。
- UI 通过本地 API 读写，通过事件流接收更新。
- Companion 和 Core 都使用当前 Windows 用户范围的命名 mutex 保证单实例；第二实例只把“打开面板”请求转交给现有实例。
- SQLite 启用 WAL、`busy_timeout`、`foreign_keys=ON`，所有写入经过单写入队列；竞争性转换使用 `BEGIN IMMEDIATE` 和 `UPDATE ... WHERE version=?`。
- 数据库用 partial unique index 保证每个 Task 至多一个活动 Run，并为启动请求建立幂等键；状态事件和 outbox 在同一事务写入。
- 备份使用 SQLite backup API 或等价一致性快照，不直接复制带活动 WAL 的数据库文件。

### 8.4 Codex App Server Adapter

- 禁止裸调用 PATH 中的 `codex app-server`。优先复用官方公开的 daemon/control 通道；如果不可用，只能选择与桌面包匹配且经验证的 helper，并记录 binary hash、协议版本、账户主体和数据根。
- 使用匹配的 App Server stdio transport，不暴露 WebSocket 端口。当前全局 CLI 与桌面包 helper 版本可能不同，版本或身份不一致时只读降级。
- 启动时执行 initialize/initialized 握手。
- 使用安装版本生成或校验协议 schema，并按能力探测启用功能。
- 支持 thread/list、thread/read、thread/start、thread/resume、thread/fork、turn/start、turn/interrupt 和流式事件。
- 处理工具审批并把请求展示到任务详情。
- 不直接读取或写入 Codex 内部 SQLite 与 rollout 文件。

### 8.5 Plugin 与 MCP

- Plugin 只包含流程 Skill 和本地 MCP shim，不再提供第二套 UI。
- Skill 要求 Codex 在开始时认领任务、在结束时提交证据，并最多推进到待验收。
- MCP 工具按主体与能力矩阵分级，至少区分 `human-ui`、`scheduler`、`importer`、`app-server`、`mcp-agent`。Agent token 不能执行完成、删除、原生线程归档、审批响应、Git 合并或写入 system evidence。
- 所有路径参数先规范化，再通过仓库 allowlist 与根目录 containment 校验。MCP 凭据不得放在 argv、日志或可被无关子进程继承的环境变量中。
- Core 是状态转换的唯一裁决者。

## 9. 安全与隐私

- Core 仅监听 `127.0.0.1` 随机端口。
- 随机 CDP 端口不能抵御同一 Windows 用户下的恶意本地进程。优先使用 debugging pipe；如果目标应用只能使用端口，安装与启用界面必须明确披露风险，用户可随时关闭注入而继续使用独立 UI。
- UI bootstrap nonce 可以放在 iframe URL fragment 中，但只能单次使用、短时有效，并绑定 renderer、Companion instance 与 session；UI 用它交换只存在内存中的短期 bearer credential。CDP 客户端仍可能读取 renderer 内存，因此 fragment 不是 CDP 认证方案。
- 凭据在 Companion 重启、renderer 变化、超时或权限变化后失效。
- API 严格校验 `Host` 和精确 `Origin` allowlist，禁止 wildcard CORS；所有请求都要求 `Authorization: Bearer`。
- 写操作只接受 JSON、自定义版本/CSRF 头与乐观版本号；GET 永无副作用。
- 事件流使用带 Authorization 的 `fetch` streaming，不在 query string、cookie 或原生 EventSource 中携带凭据。
- MCP shim 使用独立的最低权限令牌。
- App Server 使用 stdio 子进程，不开放网络监听器。
- CDP pipe/端口只在 Companion 生命周期内存在；端口模式仅监听 loopback。
- UI 不加载远程脚本、字体或图片。
- SQLite 不保存完整对话正文。
- 导入使用的有限首尾片段默认只在内存中处理；如需缓存，必须按内容 hash 去重、标注来源和过期策略，并提供“清除派生内容”操作。
- 活动日志记录自动状态变化、去重、恢复和敏感操作，但不记录密钥或完整提示内容。
- 安装包公开分发前必须签名；第一版个人开发构建不提供不安全的自动更新机制。

## 10. 故障与降级

| 故障 | 用户看到什么 | 系统行为 | 恢复方式 |
|---|---|---|---|
| Codex 未启用 CDP | “需要重启以启用任务面板” | 不结束现有进程 | 用户点击一键重启 |
| 安全调试 pipe 不可用且用户拒绝端口风险 | Codex 内入口禁用 | 不开放 CDP 端口 | 使用独立本地 UI |
| 注入挂载点失效 | 任务面板入口不可用通知 | 停止注入，不猜测 DOM | 打开独立浏览器看板，更新适配器 |
| Core 崩溃 | 面板显示重连 | Companion 限速重启 | 自动恢复 SQLite 与事件订阅 |
| App Server 不可用 | 看板只读，运行按钮禁用 | 不读取内部数据库 | 修复 Codex CLI 后重新连接 |
| App Server 版本/账户/数据根不一致 | “执行连接不一致” | 禁止创建或恢复 Run | 选择匹配 helper，重新登录或继续只读 |
| 协议缺少所需能力 | 明确列出缺失能力 | 禁用对应功能 | 升级 Codex 或使用降级路径 |
| 导入中断 | 显示已完成数量与断点 | 保留已导入数据 | 从游标继续 |
| 聚类模型不可用 | 仅显示规则聚类结果 | 不上传正文替代 | 安装/修复本地模型或手动整理 |
| Run 心跳丢失 | 卡片标记“状态未知” | 不自动重复启动 | 对账线程后由用户恢复或终止 |
| 外部并发修改线程 | 卡片标记“控制权冲突” | 暂停自动 turn | 用户选择由谁继续 |
| 审批过期或实例变化 | 审批标记“已失效” | 拒绝旧响应并释放执行槽 | 从当前实例重新发起审批 |
| Worktree 创建失败 | 显示 Git 原因和修复建议 | 不回退到不隔离写入 | 用户修复后重试 |
| 验证失败 | 任务留在执行中 | 保存失败证据 | 恢复原线程修复 |
| SQLite 迁移失败 | 使用旧版本只读打开 | 恢复迁移前备份 | 修复迁移或回滚程序版本 |

数据库迁移前自动备份，保留最近 7 份。重启后调度器先对账 Run、线程和 worktree，再接受新任务。

## 11. 分发与生命周期

- 使用每用户安装方式，不要求管理员权限；登录自启动必须由用户显式选择，并通过受支持的 StartupTask/注册机制管理。
- Companion 使用命名 mutex 保证单实例；更新、启动和卸载流程不能同时运行 Core 或调度器。
- 维护“Codex/ChatGPT 桌面版本 × 注入适配器 × App Server 协议 × 数据库 schema”兼容矩阵。未知桌面版本默认禁用注入，独立 UI 与可读取的本地数据继续可用。
- 更新采用签名包与 staged/atomic replacement；先验证程序兼容性，再迁移数据库。数据库迁移完成后如果旧程序无法读取，必须明确标记回滚边界，不能假装支持降级。
- 卸载默认保留 Projectboard 数据库、导出文件和 worktree。删除这些数据必须单独列出精确路径并由用户再次确认；绝不删除 Codex 原始线程。
- 语义模型作为独立可选组件管理版本和完整性；模型损坏、缺失或许可证不满足时只禁用建议，不影响看板。

## 12. 性能与规模

- 首屏不等待全部历史索引完成。
- 先导入元数据和确定性项目，再后台执行语义聚类。
- thread/list、thread/read 和 UI 列表必须分页。
- 看板列使用虚拟列表或等效策略，避免大量归档任务进入 DOM。
- 本地语义模型延迟加载；模型不可用不阻塞主要功能。
- SQLite 为线程 ID、Project 状态、Task 状态/排序和更新时间建立索引。
- Phase 1 目标预算：冷启动已有本地数据首屏 ≤ 1.5 秒；后台扫描时 UI 操作 p95 ≤ 100ms；峰值额外 RSS ≤ 300MB（不含可选语义模型）。
- 10,000 线程、1,000 任务、100 项目的合成测试中：首批最近数据 ≤ 5 秒可整理；全量元数据索引在基准机 ≤ 10 分钟；扫描期间更新经 catch-up pass 后无漏项；语义阶段有独立 CPU/RSS 与耗时报告。
- 规模目标是容量门槛，不要求首屏等待全量完成；没有通过压测前不得默认安装语义模型或启用全量近似去重。

## 13. 测试策略

### 13.1 数据与算法

- 仓库身份规范化，包括大小写、junction、symlink 和多个 worktree。
- 导入幂等与断点续跑。
- 中文/英文/混合标题聚类基准。
- 重复检测的精确率、误折叠恢复和主记录选择。
- 数据库迁移、备份和恢复。
- scan generation、高水位和 catch-up pass 在扫描期间持续更新时不漏项。
- 删除自动投影后重放 UserDecisionEvent，恢复等价的用户命名、拆分、排序和归档结果。
- 合成 10k 线程压测记录首屏、全量索引、峰值 RSS 与 API 调用预算。

### 13.2 状态与调度

- 每个合法和非法状态转换。
- Agent 无法把任务推进到完成。
- 自动执行 5 秒撤销不产生线程。
- 3 个活动 Run 时第 4 个必须排队。
- Companion/Core 崩溃后不重复启动 Run。
- 在“远端已接受、本地未确认”和“本地已记录、远端未接受”两个时点故障注入，验证 unknown/at-most-once 行为。
- 倒计时到期与“立即启动”并发时，partial unique index 和幂等键只允许一个活动 Run。
- blocked、approval_pending、unknown 的占槽、释放与注意力排序符合约定，不发生永久饥饿。
- 外部并发 turn 触发控制权冲突。
- 验收驳回恢复原线程；新尝试才 fork。

### 13.3 Codex 协议契约

- 对安装版本生成 schema 并做契约测试。
- thread 分页、活动/归档读取和有限内容读取。
- start/resume/fork/interrupt。
- turn 与 item 流式事件乱序、重复和断线重连。
- 审批请求与用户响应。
- 审批期间崩溃、断线、重复响应、摘要变化、实例变化与过期响应。
- 桌面内 helper、全局 CLI 和不匹配数据根/账户的探测与只读降级。
- 使用同步屏障同时从原生 Codex 与 Projectboard 发起 turn，验证原子 lease；无该能力时必须拒绝双写。
- 缺失能力和版本不匹配的只读降级。

### 13.4 Git

- 新仓库、非 Git 目录、detached HEAD、无 remote、脏工作区。
- merge/rebase/bisect/锁文件状态。
- 分支冲突、Windows 路径长度和非法字符。
- 多任务同仓库的独立 worktree。
- 入队后 HEAD 变化、同名 ref 竞争、junction 越界、submodule、LFS、sparse checkout、bare repo 与杀毒软件锁。
- 永不自动 merge、reset、stash 或删除。

### 13.5 Windows 与注入

- 当前目标 Codex 版本 `26.730.8199.0`。
- 正常启动、首次重启、登录自启动和已有无 CDP 进程。
- 多个 Codex 窗口、renderer reload 和应用升级。
- 重复注入不增加重复入口。
- 挂载点不匹配时安全降级。
- CDP 仅监听 loopback，且只连接目标 PID。
- 冷启动、已有进程、默认 profile 锁、多窗口、桌面应用升级、登出/登录和两个实例并存。
- 第二个同用户低权限进程尝试发现并接管 CDP；pipe 不可用时验证风险披露与一键关闭。
- iframe/独立 UI/事件流分别验证 Host、Origin、Bearer、自定义头、无副作用 GET、DNS rebinding 与 CSRF 拒绝。
- 每用户安装、自启动、签名更新、数据库迁移、跨两个桌面版本回滚与卸载保留数据。

### 13.6 界面与无障碍

- ≥1440px 五列铺满工作区高度与宽度；窄窗切换单列状态视图且无双向裁切。
- 空列、多任务、长标题和大量归档。
- 浅色、深色、125%/150%/200% 缩放。
- 窄窗口/高倍缩放切换单列状态视图，不同时产生页面横向滚动与列内纵向滚动。
- 全键盘拖放等效操作、焦点顺序、可见焦点和屏幕阅读器名称。
- loading、empty、partial、offline、blocked、failed、unknown 和 success 状态。
- 实时更新不抢焦点、不移动指针下卡片；虚拟列表保留聚焦项；aria-live 准确宣告。
- 首次归档导入可搜索、筛选、多选恢复，并能在 30 秒内从建议项定位并恢复一个真实线程。

## 14. 实施前兼容性 Go/No-Go 闸门

首先只实现 Phase 0 compatibility harness。它不写真实用户项目数据，必须输出机器可读矩阵、版本/身份/hash、测试日志和明确结论。以下六项全部通过，才允许进入 Phase 2/3 的执行能力：

1. **安全注入**：Windows 应用身份启动、同一用户数据根、冷/热启动、多窗口和升级均可发现 renderer；注入在原 CSP 下工作，优先使用 debugging pipe。若只能使用裸端口或必须 bypass CSP，结论为 No-Go，日常入口切换到独立 UI。
2. **App Server 一致性**：所选 binary 与桌面应用账户主体、数据根和协议兼容；创建线程会进入同一历史并能从桌面端按 ID 打开。PATH 版本与桌面 helper 不一致时必须被识别并只读降级。
3. **审批闭环**：turn/item/approval 事件可重连、对账；崩溃、重复、过期、实例或摘要变化都不会误批，只有 human-ui 可以响应。
4. **双写控制**：协议提供原子 lease/conditional start，或验证专用线程 + 显式控制权转移方案。仅在事后检测冲突不算通过。
5. **命令关联与崩溃恢复**：能用幂等键或可检索关联元数据对账“请求已接受但本地未确认”。不能证明未执行时保持 unknown，绝不自动重放。
6. **本地接口防护**：iframe、独立 UI、事件流和 MCP 的 Host/Origin/Bearer/能力矩阵能拒绝 CSRF、DNS rebinding、过期 nonce、越权证据和路径越界。

Phase 1 的只读索引、项目/五列视图和打开原线程不依赖上述执行能力全部通过；但任何注入项 No-Go 都会让独立 UI 成为主入口。Git worktree 还必须单独通过 Windows 并发、base OID、长路径、junction、submodule/LFS/sparse checkout 与锁文件矩阵后，才能进入 Phase 3。

## 15. 产品验证指标与停止条件

在 dogfood 前记录基线，连续两周评估：

- 找到当前最重要事项的中位时间 `< 10s`。
- 从卡片恢复指定工作的中位时间 `< 30s`。
- 系统生成的下一步无需修改率 `≥ 70%`。
- 日均手工整理时间 `< 60s`。
- `≥ 60%` 的活跃工作会话从“需要我处理”、项目板或恢复包重新进入原线程。
- 高置信重复集合的误折叠率 `< 2%`；全部错误都能在 2 次操作内拆分恢复。

若两周后通过 Projectboard 恢复的活跃工作 `< 25%`，或系统建议/聚类需要人工纠正的比例 `> 20%`，停止扩大自动聚类与调度范围，先修正核心恢复体验。该停止条件不删除现有本地索引或用户决策。

## 16. 验收标准

### 16.1 Phase 1

- 注入闸门通过时，用户完成一次授权重启后，日常 Codex 窗口出现“任务面板”；未通过时一键打开功能等价的独立本地 UI。
- Projectboard 不创建第二套 Codex 登录或改写 Codex 项目数据。
- 首次打开立即可用，历史按最近价值优先、最终覆盖全部线程，并在后台推进。
- 所有导入项目和任务底层状态默认归档；“待整理”和“建议恢复”不擅自激活任何内容。
- 重复线程可折叠、解释、拆分和恢复，不删除原数据。
- 标准宽屏项目任务板使用五条等宽、全高纵向泳道；窄屏/高倍缩放使用五状态单列视图。
- 每个活跃任务具有可追溯的恢复包；跨项目注意力入口能直接定位审批、待验收、阻塞、失败和 unknown。
- 注入或 App Server 失败时，看板数据不丢失，并提供明确降级入口。
- 用户决策可以 JSON 导出/导入，并能在重建投影后恢复。

### 16.2 Phase 2/3 附加门槛

- 全局最多 3 个实际执行中的 Run；崩溃恢复不会自动重放无法确认的请求。
- 代码写入任务默认隔离到绑定 base OID 的独立 worktree。
- 测试失败或仅有 Agent 声明证据的任务不能进入待验收。
- Agent 不能响应审批或把任务推进到完成。
- 版本、账户、数据根、审批、双写或幂等能力不满足时，执行功能只读降级。
- 不自动 merge、reset、stash、删除分支/worktree 或删除/归档 Codex 原始线程。

## 17. 外部参考与复用边界

- dashi-taskboard 用于理解问题与交互方向，但其仓库目前没有明确许可证。本项目采用干净重做，不复制其代码或资源。
- Codex App Server 是线程历史、执行、审批和事件的首选接口。
- 官方 Plugin 负责安装 Skill 与 MCP 能力，但不承担永久侧栏 UI。
