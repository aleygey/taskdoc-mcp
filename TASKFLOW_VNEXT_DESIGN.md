> 历史设计资料；不代表 0.2.0 的功能契约。当前实现见 [0.2.0 设计](docs/DESIGN-0.2.0.md) 和 [中文说明](README.zh-CN.md)。

# TaskDoc MCP vNext 设计

> 状态：需求重整稿（第二轮修订）；日期：2026-08-02。现状盘点见 [`TASKFLOW_CURRENT_DESIGN.md`](./TASKFLOW_CURRENT_DESIGN.md)。本稿设计独立 Obsidian 插件、Kanban 项目入口、关键节点型任务文档、强约束 MCP 工具和 section → PHA comment 同步。

## 1. 设计结论

本轮建议直接确定以下边界：

1. 新建独立、单 Vault、桌面端 Obsidian 插件，工作名 `TaskDoc MCP`；本轮不删除 `win-console` 旧实现，由用户切换后关闭旧 Taskflow。
2. Obsidian Kanban 是项目与统计的主入口：一个 board 是一个大项目，一个 column 是该项目的一种任务类型，一个 card 是一个链接任务文档的具体任务。
3. 插件内嵌 Streamable HTTP MCP 服务；任务文档和受管 board 只由 Obsidian Vault API 访问。新旧实现不得同时写同一 board/文档/PHA。
4. 任务文档是“可持续修正的关键结果记录”，不是会话摘要、日志或完整 agent 轨迹。
5. 一个 section 是一个可独立验收的子任务/checkpoint，不是一段对话、一次提问、一次会话或一次尝试。
6. 永久正文统一使用“目标与验收 → 关键判断 → 结果与证据”；active 任务另有一个覆盖式接续卡，富内容以有类型、有用途的 supporting block 附着到 section。
7. agent 不能自由改写整个 section 布局；它分别提交结构化核心、接续状态和富内容 block，由插件校验后统一渲染。表格、Mermaid 和大型 CP 清单继续支持。
8. 任务类型来自当前 board 的 column/type catalog，agent 只能选择已有稳定 ID，不能自由发明；用户可在设置页自由配置显示名称和映射。
9. PHA v1 为单向镜像：一个任务文档对应一个 PHA task，一个稳定 section ID 对应一个由插件管理的 comment。
10. “实时同步”指 checkpoint 成功提交后数秒内 upsert PHA comment，不是同步每次敲字、每条消息或每个临时状态。

## 2. 产品目标与非目标

### 2.1 目标

- 数月后打开任务文档，能在一两分钟内理解：为什么做、最终怎么做、实际结果如何、还有什么风险。
- 从项目 Kanban 能创建、分类、打开和统计任务；card 始终链接唯一任务文档。
- bug、需求、调研、迁移、配置、维护任务使用相同外观和语气。
- 临时提问、失败尝试、会话状态和无关对话默认不会进入永久文档。
- 同一子任务不断更新同一个 section，使正文始终是当前有效事实，而不是追加历史。
- 新 session 无需读取聊天历史，即可从任务顶部接续卡和 `task_resume` 找到当前 section、最后验证点和唯一下一动作。
- 允许在核心摘要之外保存有长期阅读价值的表格、Mermaid、验收矩阵和大型 CP 清单。
- 多 agent、网络重试和人工编辑不会产生重复 section、覆盖新内容或重复 PHA comment。
- 配置、运行状态、连接测试和同步诊断集中在 Obsidian 的 TaskDoc MCP 设置页。

### 2.2 非目标

- 不保存完整聊天记录、chain-of-thought、工具调用时间线或原始命令输出。
- 不把任务文档当作 agent 的临时 todo list。
- 不在 v1 中承担 opencode 会话创建、会话监控或模型选择。
- Kanban 集成不依赖 Kanban fork 的非公开运行时对象；核心只依赖受管 board 的 Markdown 格式和 Obsidian API。
- 不做 PHA 普通讨论 comment → 本地文档的自动灌入。
- 不承诺 Obsidian 关闭后的 24×7 MCP 或同步服务。
- 本轮不删除或重构 `win-console` 旧 Taskflow，但迁移期间不允许新旧两个 MCP 同时写同一任务集合。

## 3. 先澄清“追溯”的含义

需要同时保留四种不同信息，并为它们设置不同的读取、保留和同步规则：

| 信息 | 用途 | 存放位置 |
| --- | --- | --- |
| 关键节点 core | 给人长期阅读，解释目标、决定、结果和风险 | 任务 Markdown 的固定 section |
| 富成果 block | 保存表格、Mermaid、大型 CP 清单、规格和证据 | section 内联或同名 assets；按需读取 |
| 接续卡 | 让新 session 知道停点、下一动作和工作文件 | 文档顶部的覆盖式受管 callout；不进 PHA |
| 技术审计信息 | 排查谁在何时写了哪个 revision、同步是否成功 | 插件数据、Git/File Recovery、脱敏诊断 |

任务文档追溯的是“关键决策和结果的顺序”，不是重放 agent 的全部思考过程。接续卡只保存当前快照并持续覆盖；revision、session ID、content hash、PHA comment ID 等机器信息隐藏保存，不占用长期正文。

## 4. 为什么现有工具会诱导出无用内容

| 当前设计 | 直接后果 |
| --- | --- |
| `task_write_section.content` 用同一个 24,000 字自由 Markdown 字段同时承载核心结论、表格、Mermaid 和大型 CP 清单 | 24k 容量本身有价值；问题是工具无法区分“长期核心”“富成果”和“上下文倾倒”，读取时也无法分层 |
| `mode=append` | 鼓励持续累加，不鼓励覆盖、压缩和纠错 |
| `task_log` | 即使文案要求少写，它仍给 agent 一个合法的过程记录入口 |
| `task_todo` | 把会话期执行计划永久化，并与 session todo 形成两套进度 |
| `task_issue` | 每个排查插曲都能自动升级为顶级章节 |
| `task_get` 默认全文，任务启动又注入完整文档 | 旧内容反复回到上下文，agent 更容易复述并扩写 |
| section 以 `1 / 1.2` 为身份 | 序号变化后无法稳定更新，也无法稳定映射 PHA comment |
| 质量检查大多只是提示或软提醒 | 无证据、重复、过程化内容仍会写入 |
| 手动 PHA prompt | 只有任务级人工触发，没有 section/comment 映射、幂等或失败恢复 |

当前实现证据：[自由 Markdown 与 24,000 字上限](https://github.com/aleygey/win-console/blob/a4a2e040c28f4d2b16b70a63e6ac11eb8d0d4fe8/src/host/capabilities/taskflow.ts#L1308-L1378)、[`task_log` / `task_issue`](https://github.com/aleygey/win-console/blob/a4a2e040c28f4d2b16b70a63e6ac11eb8d0d4fe8/src/host/capabilities/taskflow.ts#L1381-L1458)、[当前 PHA prompt](https://github.com/aleygey/win-console/blob/a4a2e040c28f4d2b16b70a63e6ac11eb8d0d4fe8/src/host/capabilities/taskflow.ts#L1059-L1075)。vNext 保留大内容能力，但将它从默认 core 和 resume 读取路径中分离。

## 5. 任务文档信息模型

### 5.1 任务级数据

```yaml
Task:
  schema: checkpoint/v1
  id: stable-uuid
  board_id: stable-uuid
  column_id: stable-uuid
  title: string
  state: active | done | archived
  created_at: datetime
  closed_at: datetime?
  objective: string
  acceptance: string[]
  final_outcome: string?
  pha_task_id: string?
```

任务文件不再持久化：

- `sessions[]`；
- agent 临时 todo；
- 日志表；
- PHA 同步 revision/comment ID。

`board_id/column_id` 是稳定绑定；card 身份直接使用其链接文档中的 `task_id`，不再维护另一套 card ID。项目由 board 派生，任务类型由 column 派生，完成状态由 card checkbox 与文档 `state` 同步；agent 不再直接写自由字符串 `project/type/status`。PHA comment ID、remote revision 和 hash 保存在插件 BindingStore，不占用正文。

### 5.2 Section 是否只需要“分析、方案、实施、结论”

这些语义基本够用，但直接做成四个固定标题仍有问题：

- “分析”容易变成推理过程、临时假设和聊天复述；
- “实施结果”和“结果/结论”重复；
- 调研、决策任务不一定有代码实施，强制填写会诱导编造；
- 缺少完成条件和证据，agent 容易只写“已处理、测试通过”。

推荐统一为以下三个长期正文块：

1. **目标与验收**：要解决什么，以及怎样算完成。
2. **关键判断**：只保留已确认事实/约束/根因和最终决定。
3. **结果与证据**：实际产出、验证证据和剩余风险。

这三块足够覆盖一个 checkpoint 的长期结论，但**不足以单独承担跨 session 恢复**。active 任务另有一张覆盖式“接续卡”，只保存当前焦点、最后已验证点、唯一下一动作、阻塞和工作文件；它不是追加历史，任务完成后自动移除，也不进入 PHA。

### 5.3 Section 数据结构

```yaml
Checkpoint:
  id: stable-uuid
  revision: integer
  title: string
  kind: analysis | decision | implementation | incident | operation
  status: active | blocked | done | cancelled | superseded
  objective:
    statement: string
    acceptance:
      - id: AC-1
        statement: string
        status: pending | verified | waived
        evidence_refs: [E-1]
  judgment:
    facts:
      - fact: string
        relevance: string
    decisions: string[]?
    constraints:
      - rejected_option: string
        verified_reason: string
        scope: string
        impact: string
        evidence_refs: [E-1]?
        reconsider_when: string?
  outcome:
    summary: string?
    evidence:
      - id: E-1
        type: test | artifact | observation | source | user_acceptance
        statement: string
        ref: string?
    residual_risks: string[]?
  cancellation:
    reason: string
    disposition: string
  superseded_by: stable-uuid?
  blocks:
    - id: stable-uuid
      kind: data_table | mermaid | domain_checklist | code_or_config | test_evidence | technical_spec | source_reference
      title: string
      summary: string
      supports: objective | judgment | outcome
      size: integer
      revision: integer
```

`kind` 是插件用于选择校验 profile 的小型内置枚举，不是看板上的任务类型；它不改变可见文档结构，通常可由操作和已有内容推导。人可见的任务类型来自 board column catalog，可自由配置，但 agent 只能引用已有 `column_id`。

### 5.4 接续卡

```yaml
ResumeCapsule:
  focus_checkpoint_id: stable-uuid
  based_on_revision: integer
  last_verified: string?
  next_action: string              # active/blocked 必须且只能一项
  blockers:
    - statement: string
      unblock_when: string
  open_questions: string[]         # 最多 3 项
  working_artifacts:
    - path: string
      purpose: string
      state: editing | changed | verified
  workspace_ref:
    repo: string?
    branch: string?
    commit: string?
```

接续卡由 `task_handoff` 完整覆盖，建议最多 800 个展示字符。它禁止聊天原文、命令日志、完整计划和试错时间线。插件把它渲染在任务文档顶部的受管 callout 中，因此人直接打开文档也能接手；`task_resume` 返回同一内容与长期 checkpoint 的合并视图。checkpoint/任务关闭后，接续卡自动移除。

边界必须说清：正常 handoff 后，新 session 可以直接接手；如果旧 session 在提交 core/handoff 前突然中断，只能恢复到最后一次持久 checkpoint，无法从文档重建尚未落盘的临时思路或改动。未来可通过 MCP 客户端的 session-end/context-compaction hook 自动调用 handoff，但独立 Obsidian 插件本身无法观察所有客户端生命周期。

### 5.5 富内容块

24,000 字级输入是合法需求，但它属于“可寻址的任务成果”，不应成为默认恢复上下文。每个 block 必须声明 `kind/title/summary/supports`，单块默认上限保留为 24,576 个 Unicode 字符；可在 Obsidian 设置页提高。典型内容包括：

- 数据表与方案比较表；
- Mermaid 最终架构、流程或状态机；
- CP、兼容性、验收、部署和测试矩阵；
- 必要的配置/代码片段、测试证据和技术规格。

block 只允许完整 replace，不允许 append。`domain_checklist` 必须声明 `acceptance/compatibility/deployment/test_matrix/production_check` 之一，不能用来保存 session plan。自动存储模式下，小 block 原位渲染，大 block 保存到任务同名 assets 目录并在主文档嵌入；Obsidian 阅读体验不变，但 `task_resume` 只返回 manifest，正文需用 `task_block_read` 按需分页读取。

### 5.6 推荐 Markdown

```markdown
---
task_schema: checkpoint/v1
task_id: 01K...
board_id: 01KBOARD...
column_id: 01KCOLUMN...
state: active
created_at: 2026-08-02T12:00:00+08:00
pha_task_id: PHA-123
---
# 将 Taskflow 拆成独立插件

> 目标：将任务文档能力与 win-console 解耦，并保证 section 能稳定同步到 PHA。
> 最终结果：仅在任务关闭后出现。

> [!taskdoc-resume] 当前接续点
> 当前：CP-02 · PHA comment upsert
> 最后验证：本地 revision 与 section ID 已稳定写入。
> 下一步：验证远端 comment 条件更新接口。
> 工作文件：`src/pha/adapter.ts`（已修改，未验证）。

## CP-01 · 确定独立插件边界
<!-- task-checkpoint {"id":"01KSECTION...","status":"done","revision":2} -->

### 目标与验收
- 问题：Taskflow 当前同时依赖 win-console、Kanban 和会话编排。
- 完成条件：任务文档 MCP 可随 Obsidian 插件独立启停和配置。

### 关键判断
- 已确认事实：Obsidian 桌面插件可以运行 Node HTTP 服务并直接访问当前 Vault。
- 决定：MCP 内嵌插件；文件操作只使用 Vault API。

### 结果与证据
- 产出：独立插件组件和生命周期边界已确定。
- 证据（设计检查）：文档、MCP、PHA 和 Obsidian adapter 间不再循环依赖。

### 详细资料
- ![[TaskDoc MCP.assets/CP-01/architecture.md]] — 最终组件关系图
- ![[TaskDoc MCP.assets/CP-01/cp-matrix.md]] — CP 验收矩阵，186/220
```

稳定 ID 和 revision 在隐藏 marker 中；章节显示序号可以重排，不参与身份或同步映射。`pha_comment_id`、remote revision 和 hash 不进入正文。没有内容的长期块不渲染，避免 agent 为填模板而编造文本。

## 6. 不同任务使用同一格式

统一的是 section 的可见结构与语气，不是把业务类型写死。类型分为两层：

- **看板任务类型**：由每个 board 的 column catalog 定义，具有稳定 `column_id/type_id` 和用户自定显示名；用于项目分类和统计。agent 必须先读取 catalog，只能选择已有 ID，不能自由填写新类型。
- **校验 profile**：插件内置 `bug/feature/research/migration/configuration/maintenance/other` 等少量语义规则；设置页可把自定义 column 映射到某个 profile。profile 只影响“done 时要检查什么”，不改变 Markdown 标题。

例如用户可以创建“CP 整理”“硬件验证”“外部协作”等任意列，再分别映射到最接近的校验 profile。不能匹配时使用 `other`，而不是让 agent 猜测或自动新增类型。

| 任务类型 | 目标 | 关键判断 | 结果与证据 |
| --- | --- | --- | --- |
| Bug | 现象、期望行为、复现边界 | 已确认根因、最终修复方式 | 行为变化、回归测试 |
| 需求 | 用户价值、范围、验收条件 | 约束、最终设计选择 | 已交付行为、验收结果 |
| 调研 | 要回答的问题、评价标准 | 来源、已确认发现、建议 | 被采纳的结论及依据 |
| 迁移 | 起点、终点、兼容标准 | 数据约束、迁移/回滚决定 | 已迁移范围、完整性验证 |
| 配置 | 目标环境和预期行为 | 当前限制、最终配置位置和值 | 生效现象、检查结果 |
| 维护 | 要降低的风险或成本 | 当前事实、整理决定 | 简化结果、无回退证据 |

不为不同类型生成不同 Markdown 模板，否则风格会再次分裂。

## 7. 内容准入规则

### 7.1 允许进入正文

- 明确的目标、边界和验收条件；
- 已证实的根因、约束和关键事实；
- 最终采用的方案，以及影响理解所必需的简短理由；
- 实际改变的行为、配置、接口、文件或交付物；
- 测试、观察、用户验收、文档或产物链接等证据；
- 仍存在的风险、blocker 和必须继续处理的事项；
- 失败方案形成的永久约束，例如“方案 X 不支持离线恢复，因此不采用”。

### 7.2 禁止进入正文

- 对话转录、用户原话、agent 自述；
- 永久 section 中的“接下来准备做……”等计划和状态播报；接续卡只允许一个明确的 `next_action`；
- 临时提问、猜测、未经确认的根因；
- 按时间排列的尝试过程、失败命令和中间方案；
- 无筛选的完整日志、diff、代码和工具原始输出；确属交付物/证据的内容必须进入有类型的 rich block，并在 core 中有一句结论；
- 与当前 section 验收条件无关的讨论；
- 多个字段重复同一结论；
- 没有具体对象和证据的“已完成、已解决、测试通过”；
- token、密码等敏感信息。

一句话只有同时满足以下三项才允许写入：

1. 它会改变未来读者对目标、决定、结果或风险的理解；
2. 它已经确认或正式选定；
3. 它直接属于当前 section。

失败尝试通常不记录。它只有同时满足以下条件，才能通过 `constraint_confirmed` trigger 晋升为永久约束：

1. 被否定的选择和原因已经有证据，不是猜测；
2. 结论会改变后续方案，或能防止未来 session 重复踩坑；
3. 可以写清适用范围与对最终设计的影响；
4. 能压缩成一两条判断，不依赖完整尝试时间线。

规范化表达为：

```text
不采用什么 + 已验证原因 + 适用范围 + 对后续选择的影响 + 可选重新评估条件
```

例如：“当前 Windows/WSL 部署不采用跨界递归 watcher；22k 文件场景触发句柄上限，因此改用 Vault event + 启动补偿扫描；运行环境统一到 Windows 原生后再评估。”临时网络错误、命令拼写错误或偶发工具失败不会通过晋升门。

## 8. Section 生命周期

### 创建

- 出现一个能够独立验收、独立回滚或独立说明的子目标时创建；
- 至少已经能写出目标和一条完成条件；
- 不按会话、消息、问题数量或尝试次数创建。

### 工作中

- 推理、临时 todo、提问和试错全部留在 agent 会话；
- 只在目标/完成条件实质变化、事实/永久约束被确认、产生已验证部分结果或出现长期 blocker 时更新 core；
- 同一失败方案产生永久约束时更新当前 section 的 `judgment.constraints`，不新开“失败记录” section；
- 计划切换 session、进入长时间等待或上下文即将压缩时调用 `task_handoff`，完整覆盖接续卡；
- PHA comment 可以显示 active 目标，但不会同步会话过程。

### 收口

- `done`：最终决定、实际结果和至少一条具体证据必填；
- `blocked`：必须写 blocker 和解除阻塞条件；
- `cancelled`：必须写取消原因和最终处置；
- 修正已有结论时覆盖同一个 section，不新开“修复上一节”的时间线章节；
- 关闭 section 前把仍有长期价值的接续内容归并到 core/blocks，再清除该 section 的接续卡；
- revision 历史交给插件数据、Git/File Recovery，不追加到正文。

## 9. vNext MCP 工具

### 9.1 工具清单

| 工具 | 职责 |
| --- | --- |
| `task_catalog` | 返回可用项目 board 与 column/type catalog；所有对象使用稳定 ID |
| `task_query` | 按 board、column、card state 和标题分页查询；只返回摘要，无扫描写副作用 |
| `task_resume` | 返回有严格预算的跨 session 接续包；不返回 rich block 正文 |
| `task_read` | `outline/checkpoint/block` 三种显式视图；block 分页读取 |
| `task_create` | 同时创建任务文档与链接 card；必须选择已有 `board_id/column_id` |
| `task_card_update` | 移动 card 以改变任务类型，或更新 `active/done/archived`；不接收自由 type/status |
| `task_checkpoint_commit` | 创建或完整替换一个 checkpoint 的结构化 core |
| `task_block_put` | 创建或完整替换一个有类型的富内容 block；单块默认保留 24,576 字符能力 |
| `task_handoff` | 完整覆盖 active checkpoint 的接续卡，不写永久 section、不触发 PHA |
| `task_finalize` | 写任务级最终结果、检查所有 checkpoint，并同步 card checkbox/state |

不以工具数量作为轻重标准，而以“每种生命周期只有一个写入口”为标准。core、rich block、resume capsule 和 card 的校验与同步语义不同，不能再塞进同一个自由 Markdown 工具。

当前工具迁移：

| 当前工具 | vNext 处理 |
| --- | --- |
| `task_list` | 拆为只读 catalog 与结构化、分页的 `task_query` |
| `task_get` | 改为显式视图的 `task_read`；跨 session 恢复改走 `task_resume` |
| `task_create` | 保留看板创建链路，但改用稳定 board/column ID，并保证 card 链接文档 |
| `task_write_section` | 拆为结构化 core 的 `task_checkpoint_commit` 与富内容 `task_block_put` |
| `task_todo` | 删除 session todo；CP/验收等领域清单使用 `domain_checklist` block |
| `task_log` | 删除；技术审计留在插件数据/Git |
| `task_issue` | 删除；bug/incident 由 checkpoint kind 表达 |
| `task_set_field` | PHA 绑定等改为强类型参数或 Obsidian UI |
| `task_set_status` | 改为 `task_card_update`；类型=column，完成=checkbox/state |
| `task_normalize` | 移到插件内部迁移命令，不暴露给 agent |

### 9.2 `task_checkpoint_commit` 核心输入

```ts
type CheckpointCommit = {
  schema_version: 1
  request_id: string          // 幂等键
  task_id: string
  checkpoint_id?: string      // 省略=创建；更新时必填
  expected_revision: number   // 创建为 0
  trigger:
    | "subtask_started"
    | "subtask_completed"
    | "decision_finalized"
    | "constraint_confirmed"
    | "partial_result_confirmed"
    | "result_verified"
    | "blocker_confirmed"
    | "correction"
  core: {
    title: string
    kind: "analysis" | "decision" | "implementation" | "incident" | "operation"
    status: "active" | "blocked" | "done" | "cancelled" | "superseded"
    objective: {
      statement: string
      acceptance: Array<{
        id: string
        statement: string
        status: "pending" | "verified" | "waived"
        evidence_refs?: string[]
      }>
    }
    judgment?: {
      facts?: Array<{ fact: string; relevance: string }>
      decisions?: string[]
      constraints?: Array<{
        rejected_option: string
        verified_reason: string
        scope: string
        impact: string
        evidence_refs: string[]
        reconsider_when?: string
      }>
    }
    outcome?: {
      summary: string
      evidence: Array<{
        id: string
        type: "test" | "artifact" | "observation" | "source" | "user_acceptance"
        statement: string
        ref?: string
      }>
      residual_risks?: string[]
    }
    blocker?: string
    unblock_condition?: string
    cancellation?: {
      reason: string
      disposition: string
    }
    superseded_by?: string
  }
}
```

agent 不能在 core 中传 Markdown 标题、表格、代码围栏、checkbox 或自由布局；插件根据对象生成固定文档。富内容由独立工具接收：

```ts
type TaskBlockPut = {
  request_id: string
  task_id: string
  checkpoint_id: string
  block_id?: string
  expected_revision: number
  block: {
    kind: "data_table" | "mermaid" | "domain_checklist" | "code_or_config" |
          "test_evidence" | "technical_spec" | "source_reference"
    title: string
    summary: string
    supports: "objective" | "judgment" | "outcome"
    checklist_scope?: "acceptance" | "compatibility" | "deployment" |
                      "test_matrix" | "production_check"
    source_uri?: string
    language?: string
    content: string
  }
}
```

`task_handoff` 只接收 5.4 节的 ResumeCapsule；`task_resume` 返回任务目标、当前 active/blocked checkpoint core、已完成 checkpoint 的标题/一句结果、接续卡和 rich block manifest，不返回完整历史或 block 正文。

### 9.3 强制质量门

写文件前必须通过硬校验，而不是写完后给提醒：

- JSON Schema 使用 `additionalProperties: false`；
- 标题默认不超过 40 个字符；
- core 渲染后默认不超过约 2,500 个展示字符；该预算不包含 rich block；
- core 的完成条件、关键事实、证据和剩余风险分别设置小型上限；超量矩阵进入对应 block；
- `done` 必须有 outcome、所有未豁免 acceptance 的验证状态和至少一条具体 evidence；decision/analysis profile 还必须有最终判断，简单 operation 不为填字段而编造决定；
- 实施型 `done` 至少有一条 `test`/`observation`/`user_acceptance` 证据；
- `blocked` 必须有 blocker 和 unblock condition；
- `cancelled` 必须有取消原因和处置；
- `superseded` 必须指向替代它的 checkpoint，且替代项必须存在；
- 禁止 `TODO`、`TBD`、`待补充`、`同上` 等占位符；
- core 拒绝角色前缀、聊天 transcript、时间流水、大段引用和大代码块；
- facts 必须同时写 relevance，防止把所有上下文事实搬入文档；
- constraint 必须同时写被否定选择、已验证原因、适用范围、后续影响和至少一条 evidence reference；
- 对字段间高相似内容去重或拒绝；
- 与上一 revision 无实质变化时返回 `noop`，不增加 revision、不触发 PHA。

rich block 的独立质量门：

- 单块默认最多 24,576 个 Unicode 字符，每个 checkpoint 默认最多 8 块、总量默认约 96,000 字符；均可在设置页调整；
- 必须有 `kind/summary/supports`，不能使用 `misc/note/log/conversation/session_plan` 等逃生类型；
- `data_table` 必须是合法表格，`mermaid` 必须可解析，`domain_checklist` 必须有合法 scope，`code_or_config` 必须有语言；
- 仍禁止对话转录、思维过程、试错时间线，以及用 block 绕过 core 限制的普通长篇叙述；
- 完整 replace、hash no-op；不提供 append。

“我、用户问、接下来、然后、后来、尝试了、可能、也许、正在”等过程或不确定表达可作为 lint；严格模式下升级为拒绝。额外 LLM judge 可以作为将来选项，但不能取代上述确定性校验。

### 9.4 幂等、冲突和原子性

- `request_id` 是幂等键；相同键和相同规范化 payload 返回第一次结果；
- 相同键但 payload 不同返回 `IDEMPOTENCY_CONFLICT`；
- `checkpoint_id` 是稳定身份，显示序号不参与更新；
- 更新必须提交 `task_read` 返回的 `expected_revision`；
- 每个任务有进程内互斥；
- 文件更新使用 Obsidian `Vault.process()` 在最新内容上替换目标 checkpoint；
- 人工修改导致 revision/hash 不一致时返回 `DOCUMENT_CONFLICT`，不能静默覆盖；
- 成功结果同时返回结构化 `task_id/checkpoint_id/revision/document_hash/pha_sync`；
- 工具应声明 `outputSchema` 并提供 `structuredContent`，文本结果只保留一行摘要。

board 与任务文档是两个 Markdown 文件，不能假装存在跨文件原子写。插件使用持久化 mutation journal 保存 `mutationId/taskId/boardId/base hashes/desired states`：先登记意图，再顺序更新两边并重新解析确认；失败时保留 repair operation。`task_create` 只有在“文档存在、card 存在、card 链接正确”全部成立后才返回成功。只读 scan 不得顺手修复，Reconcile 必须先显示预览再显式执行。

Obsidian 官方说明 `Vault.process()` 保证读取与写入之间文件不会被其他修改穿插，适合替代当前同步整文件覆盖。[Vault API](https://docs.obsidian.md/Plugins/Vault) MCP 官方工具规范也支持 `outputSchema` 和结构化结果。[MCP Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

建议错误码：

```text
INVALID_INPUT
TASK_NOT_FOUND
CHECKPOINT_NOT_FOUND
VERSION_CONFLICT
IDEMPOTENCY_CONFLICT
QUALITY_REJECTED
DOCUMENT_CONFLICT
DOCUMENT_MALFORMED
IO_BUSY
IO_ERROR
PLUGIN_CONFIG_REQUIRED
```

`task_finalize` 同样只接收结构化输入，并通过 revision 防止覆盖新状态：

```ts
type TaskFinalize = {
  schema_version: 1
  request_id: string
  task_id: string
  expected_revision: number
  status: "done" | "archived"
  final_outcome: string
  evidence: Array<{
    type: "test" | "artifact" | "observation" | "source" | "user_acceptance"
    statement: string
    ref?: string
  }>
  remaining: string[]
}
```

`done` 时不允许仍有 `active`/`blocked` checkpoint，且至少需要一条证据；`archived` 时 `final_outcome` 写终止原因和已有产出的处置。任务级结论由已提交 checkpoint 聚合，renderer 不接受自由 Markdown；成功后同步勾选或归档 Kanban card。

## 10. Agent 写作协议

1. 新 session 先调用 `task_resume`，不要默认读取全文或 rich block。
2. 推理、todo、临时提问和失败尝试留在会话里。
3. 只有出现独立子目标、最终决定、已验证部分/最终结果、确认的永久约束、长期 blocker 或结论纠正时才 commit core。
4. 同一子任务始终更新同一个 `checkpoint_id`；新会话不等于新 section。
5. commit 是当前有效事实的完整替换，永远不 append 过程。
6. 失败过程只有通过第 7 节的永久约束晋升门，才写入 `judgment.constraints`；否则丢弃。
7. 表格、Mermaid、大型 CP 清单等只通过 `task_block_put` 写入，且必须先说明它支持哪条目标、判断或结果。
8. 切换 session、进入外部等待或上下文即将压缩前调用 `task_handoff`；只留一个下一动作，不写完整执行计划。
9. 三个月后不能帮助理解“为什么这样做、最终做了什么、结果如何”的内容不提交长期 core/block。
10. `VERSION_CONFLICT` 后重新读取并合并干净事实；纯网络重试继续使用原 `request_id`。
11. `task_finalize` 只能基于已提交 checkpoint 写最终结果，不能重新总结整段聊天。

### 10.1 如何跨不同 LLM 保持一致

仅靠 prompt 或 skill 无法稳定控制不同模型的取舍与篇幅。建议使用以下由硬到软的约束层：

1. **MCP Schema**：限制字段、枚举、长度、条件必填和 block 类型；自由度最低。
2. **状态与质量门**：在落盘前拒绝无证据完成、重复字段、过程语言、未说明 relevance 的事实和不合格 constraint。
3. **Canonical renderer**：标题、顺序、标签、表格和空块隐藏全部由插件生成，模型文风不会改变最终版式。
4. **增量读取**：resume 只返回 core 与 block manifest，减少旧长文重新污染模型上下文。
5. **TaskDoc Writer skill**：教 agent 什么时候 resume、commit、写 block、handoff；它是调用协议，不是最终质量防线。
6. **一致性测试集**：用同一批带有无关聊天、临时问题、失败尝试和大型 CP 表的 fixture 运行目标模型，只检查结构不变量与信息选择；模型升级后重新跑。

建议随插件提供一个简短的 `taskdoc-checkpoint` skill：

```text
taskdoc-checkpoint/
├─ SKILL.md                    只保留开始、提交、富块、handoff、结束流程
└─ references/
   ├─ examples.md             bug/需求/调研/CP 清单/永久约束示例
   └─ rejection-cases.md      对话转录、过程日志、伪证据等反例
```

skill 不复制完整 JSON Schema，避免和插件版本漂移；Schema 由 MCP `tools/list` 暴露，稳定协议同时通过 server instructions 或只读 resource `taskdoc://protocol/v1` 提供。根据 `skill-creator` 的低自由度原则，一致性要求越高，越应该交给工具和确定性校验，而不是增加长篇提示。

质量失败返回字段路径、规则名和可执行修改建议，例如“删除与验收无关的第 4 条 fact”或“为 constraint 补充 scope/impact”。严格模式可再增加一个可选 editorial review，但它只查看“上一 revision + 新结构化 payload”，不能读取整段聊天，也不能取代确定性质量门。语义相关性无法对任意 LLM 做到 100% 自动保证；这里的目标是把模型能自由发挥的区域压缩到最小，并让失败可拒绝、可测试、可修正。

## 11. 独立 Obsidian 插件架构

```text
TaskDocPlugin
├─ SettingsTab
├─ TaskRepository          Obsidian Vault API
├─ DocumentCodec          解析、固定渲染、质量校验
├─ RichBlockStore         inline/assets 存储与分页读取
├─ ResumeStore            接续卡覆盖、渲染与过期检查
├─ TaskIndex              create/modify/rename/delete 增量索引
├─ KanbanIntegration
│  ├─ BoardRegistry       board/column catalog
│  ├─ BoardMarkdownAdapter
│  ├─ BoardReconciler
│  └─ MutationJournal     跨 board/document 恢复
├─ McpGateway
│  ├─ StreamableHttpServer
│  ├─ AuthGuard           Bearer + Host/Origin 校验
│  └─ ToolService
└─ PhaSync
   ├─ SyncEngine
   ├─ DurableOutbox
   ├─ BindingStore
   ├─ ConflictStore
   └─ PhaAdapter
```

模块边界：

```text
core/       Task、Checkpoint、Block、Resume、Validator、Renderer、Repository 接口
obsidian/   Vault repository、events、settings、commands、status UI
kanban/     board catalog、card mutation、journal、reconcile、statistics
mcp/        official SDK transport、tools、schemas、result mapping
pha/        adapter、outbox、reconciliation、conflict handling
```

### 看板事实模型

| 对象/字段 | 含义与事实来源 |
| --- | --- |
| board | 一个大项目；board frontmatter 持有稳定 `board_id/project_id` |
| column | 一种项目内任务类型；设置页将 column 映射到稳定 type ID 和校验 profile |
| card | 一个具体任务；首个完整 vault-relative wikilink 指向唯一任务文档 |
| checkbox | `active/done` 的事实来源，与文档 state 双向投影 |
| task document | 目标、checkpoint core、接续卡和 rich block manifest |
| section | 一个稳定 checkpoint ID；与 PHA managed comment 一对一 |

column 不再同时承担完成状态；移动 card 表示改变任务类型，勾选 card 表示完成。删除 card 不自动删除文档，只标记 orphan；删除文档不自动删除 card，只标记 broken；复制 card 形成 duplicate conflict，插件不静默删数据。

board frontmatter 保存可移植的稳定映射，column 标题只负责显示：

```yaml
taskdoc:
  board_id: 01KBOARD...
  project_id: win-console
  columns:
    - column_id: 01KBUG...
      heading: Bug
      type_id: bug
      profile: bug
```

card 使用完整 vault-relative wikilink，身份取链接文档的 `task_id`：

```markdown
- [ ] [[Tasks/win-console/修复启动失败|修复启动失败]]
```

冲突时的事实来源固定为：`project/board/type/completion` 以 board/card 为准，文档 frontmatter 只是镜像；`title/checkpoint/resume/block` 以任务文档为准，card alias 是投影。MCP 变更先登记 mutation，再同时更新事实源和投影，不能让“最后扫描到哪个文件”决定结果。

### 生命周期

- 插件 manifest 设置 `isDesktopOnly: true`，因为内嵌服务需要 Node HTTP API；Obsidian 官方 manifest 用该字段标记依赖 Node/Electron 的插件。[Manifest](https://docs.obsidian.md/Reference/Manifest)
- `onload()` 只加载设置、注册设置页和命令；索引、HTTP server 和 PHA worker 在 `workspace.onLayoutReady()` 后启动，避免拖慢 Obsidian 启动。[加载指南](https://docs.obsidian.md/plugins/guides/load-time)
- `onunload()` 停止接收 MCP 请求、取消 PHA 请求、持久化队列并关闭 socket。
- 每个 Vault 是独立实例，使用独立端口、token、任务目录和 PHA 绑定。
- Obsidian 关闭或插件禁用时 MCP/PHA worker 均停止；需要 24×7 时必须另加 companion daemon。

### 文件和索引

- 插件天然限定当前 Vault，删除 `vaultDir`；
- MCP 只接受 task/checkpoint UUID 和 vault-relative path，不接受 Windows 绝对路径；
- 删除 `pathMap`，agent 不再直接编辑任务文件；
- 设置页选择 Vault 内任务根目录；用户路径经 `normalizePath()`，拒绝绝对路径和 `..`；
- 每个受管 board 绑定自己的任务目录；初次只扫描这些 board/目录，之后监听 Vault `create/modify/rename/delete` 事件增量更新；
- 不再每 15 秒全 Vault 轮询；
- 正文更新使用 `Vault.process()`；frontmatter-only 操作使用 `FileManager.processFrontMatter()`。

从 Kanban 新建无链接 card 时，可按 board 设置自动转换或通过“Convert card to TaskDoc task”显式转换：插件只读取干净标题，创建文档，再原位改为 wikilink。MCP 创建任务必须提交 `board_id/column_id`。任何只读 scan 都不得顺手修改文件；设置页先展示 orphan/broken/duplicate/type mismatch/status mismatch，再由用户执行 Reconcile。

## 12. Obsidian 设置页

所有 TaskDoc 自身配置迁入 Obsidian 的独立插件设置页；凭据使用 Obsidian SecretStorage，不写入明文 `data.json`。[SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage)

| 分组 | 设置与操作 |
| --- | --- |
| Boards | 创建/接入 board、项目 ID、任务目录、column→type/profile 映射、默认 column、card 自动转换、checkbox 完成映射、统计、Preview/Reconcile |
| Task documents | 命名规则、自动补稳定 ID、core 字数预算、rich block 单块/总量、inline/assets 阈值、严格质量模式、接续卡显示 |
| MCP server | 启用、端口、绑定模式、运行状态、重启、重新生成 token、复制客户端配置、连接测试 |
| PHA | 启用、adapter、base URL、workspace/project、token secret、同步模式、超时、测试连接、立即重试/全量对账 |
| Diagnostics | MCP/PHA 状态、board/doc mutation、outbox/conflict、orphan/broken/duplicate 数量、最后错误、重试失败项、导出脱敏诊断 |

“Add existing board”向导读取所有 column，让用户逐列确认 type/profile，不按相似名称猜测。column 重命名后映射进入 unresolved，需显式重连；自定义显示名无限制，但 agent 永远只看到并提交 catalog 中的稳定 ID。

安全默认值：

- 默认只监听 `127.0.0.1`，但设置页可显式选择具体 Host-only/桥接/LAN 地址、`0.0.0.0` 或 `::`；
- 监听地址（bind host）和客户端配置使用的可达地址（client host）分离；通配地址不能作为 client host，IPv6 URL 自动加方括号；
- 首次启用生成随机 256-bit Bearer token；
- Host 必须格式合法且端口与实际监听端口一致；所有 IP literal 均可用，不设置来源 IP 白名单；DNS Host 只允许 `localhost` 或用户配置的 client host，以保留 DNS rebinding 防护；
- Origin 存在时必须位于 allowlist；
- 不返回 `Access-Control-Allow-Origin: *`；
- 限制请求体、并发数和工具输出；
- 日志不记录 token、完整 PHA comment 或完整任务文档；
- 非回环监听始终强制 Bearer token，并在 UI 显著提示：HTTP 明文不会因 token 而加密；Host-only/桥接/LAN 场景应使用 Windows 防火墙限制可信 VM/网段，跨不可信网络需 TLS/VPN，不能直接暴露到公网。

建议使用官方 TypeScript SDK 的无状态 Streamable HTTP，而不是迁移当前手写 JSON-RPC 子集。官方 SDK专门提供本地服务 Host/Origin 校验和 DNS rebinding 防护。[MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)

OpenCode 仍需要知道一次 MCP endpoint 和认证头，这部分不可能只保存在 Obsidian 中。插件设置页应提供“复制 OpenCode 配置”，而不是擅自修改外部配置；其他任务/PHA/格式设置均归插件管理。

`win-console` 旧 Taskflow 本轮保留不删；启用新插件前由用户关闭旧 MCP/文件写入即可，不在新插件中重新实现 session 监控或 bridge。必须确保 OpenCode 只注册一个 TaskDoc MCP，避免双写。

## 13. Section → PHA Comment 实时同步

### 13.1 当前缺口

现有设计只有“用户手动触发 → 向 agent 发送 PHA 概览同步 prompt”。它没有：

- section ↔ comment 稳定映射；
- comment upsert；
- revision/hash；
- 幂等去重；
- 离线队列和重试；
- 冲突检测；
- 文件人工修改后的同步。

因此这确实是一个尚未设计的能力，不是已有功能的小补充。

### 13.2 身份映射

```text
一个 task document  ↔ 一个 PHA task
一个 checkpoint ID ↔ 一个 managed PHA comment
```

任务 frontmatter 保存 `pha_task_id`。本地 section marker 保存稳定 `checkpoint_id`。插件 BindingStore 保存：

```text
(provider, phaTaskId, taskId, checkpointId)
  -> commentId, remoteRevision, lastSyncedHash
```

PHA comment 尾部包含机器 marker：

```html
<!-- taskdoc-sync:v1 task=01K... checkpoint=01K... revision=3 hash=... -->
```

即使本地 BindingStore 丢失，也可以查询 marker 重建映射。没有 marker 的普通 PHA comments 永远不进入任务文档。

### 13.3 触发链

```text
task_checkpoint_commit 或 task_block_put 通过校验
→ Vault.process 原子写入
→ checkpoint.projection_changed(task, checkpoint, revision, hash)
→ 持久化 UPSERT_COMMENT outbox
→ MCP 返回 local=committed, pha=queued
→ worker 异步 create/update 同一个 PHA comment
→ 保存 commentId / remoteRevision / syncedHash
```

PHA 网络失败不回滚已成功的本地 checkpoint。工具返回同步状态：

```text
synced | queued | failed | unbound | conflict
```

默认 comment 投影包含项目/类型/任务/section 标题、完整 core，以及 rich block 的标题、摘要、类型、进度和 Obsidian 链接；不内联 24k block 正文，也不包含接续卡。设置页可选择 `manifest-only`（默认）、`inline-selected` 或 `inline-all-with-limit`。大型 CP checklist 的频繁勾选去抖 1–2 秒，始终更新原 comment。

### 13.4 Outbox 规则

- outbox 项包含 `opId/provider/phaTaskId/taskId/checkpointId/commentId?/desiredBody/desiredHash/attempt/nextAttemptAt/state`；
- 同一 checkpoint 未发送的多个 revision 合并为最新快照，不积压中间版本；
- core 与多个 block 的连续修改按 checkpoint ID 合并为一个最新 comment 投影；
- adapter 支持幂等键时传 `opId`；
- create 响应丢失时，重试前先按 marker/hash 查询，避免重复 comment；
- 408、429、5xx 按带 jitter 的指数退避并尊重 `Retry-After`；
- 鉴权、权限、格式等 4xx 进入 blocked，在设置页显示；
- 插件重启后将残留 inflight 恢复为 pending；
- section 删除默认保留远端审计 comment并解除/归档映射，不自动删除 PHA 历史。

### 13.5 人工修改与冲突

- MCP 提交是唯一强保证路径；
- 用户在 Obsidian 手工修改受管 section 时，Vault `modify` 事件 debounce 1–2 秒；
- 插件重新解析并通过同一 Schema/质量门后，生成 `origin=obsidian` 的 committed 事件；
- 无法通过校验的人工内容只标记 dirty，不推送 PHA；
- 默认本地任务文档是事实源，但发现 managed comment 被远端人工修改时不静默覆盖，而进入 conflict；
- 设置页提供“保留本地 / 采用远端 / 手工合并”，其中采用远端也必须通过同一质量门；
- 普通 PHA 对话 comment 不参与冲突或同步。

### 13.6 PHA Adapter

在确认具体 PHA API 前，不能假设它支持 edit comment、搜索 marker、ETag、webhook 或原生幂等键。adapter 至少需要能力探测：

```ts
interface PhaAdapter {
  capabilities: {
    updateComment: boolean
    nativeIdempotency: boolean
    conditionalUpdate: boolean
    searchableMetadata: boolean
    pushSubscription: boolean
    maxCommentLength?: number
  }

  validateConnection(): Promise<void>
  getTask(taskId: string): Promise<PhaTask>
  listComments(taskId: string, cursor?: string): Promise<CommentPage>
  createComment(taskId: string, body: string, opId: string): Promise<PhaComment>
  updateComment(taskId: string, commentId: string, body: string, revision?: string): Promise<PhaComment>
}
```

若 PHA 不支持更新 comment，只能降级为“新 revision comment + supersedes marker”。这会增加噪声，不满足默认的“一 section 一 comment”，因此应作为显式降级而不是默认实现。

### 13.7 “实时”的实际边界

- Obsidian 运行时，本地 checkpoint → PHA 可做到提交后约 1–2 秒 push；
- 如果未来需要 PHA → 本地，只有 PHA 支持 WebSocket/SSE 等出站订阅时才能近实时，否则只能增量轮询；
- 公网 webhook 无法直接调用只监听 loopback 的 Obsidian 插件；
- Obsidian 退出后同步停止；
- v1 推荐明确为“本地文档权威、PHA managed comment 单向镜像、近实时 push”。

## 14. 迁移建议

### 阶段 1：独立插件 + 看板只读接入

- 新建独立插件仓库；
- 实现 BoardRegistry、稳定 board/task/checkpoint ID 和 Vault repository；
- 设置页支持 Add existing board、column/type 映射和只读 reconcile report；
- 此阶段不自动修改旧 board/card/document。

### 阶段 2：文档、MCP 与看板写入

- 实现 Checkpoint core、rich block、接续卡、固定 renderer 和质量门；
- 实现第 9 节工具、revision、幂等、冲突和 mutation journal；
- 接管 card 创建/移动/checkbox 与任务文档的一致性；
- 完成跨 session 的 `task_handoff` / `task_resume`。

### 阶段 3：PHA 单向同步

- 确认 PHA API；
- 实现 adapter、binding、durable outbox、重试和诊断；
- 完成一个 checkpoint 对应一个 comment 的 upsert；
- 支持 Obsidian 人工修改后的校验与同步。

### 阶段 4：旧看板与文档迁移

- 只读扫描现有 v5 文档；
- 为 board、card、任务和顶级 section 分配稳定 ID；
- 逐列确认 column/type/profile 映射，并检查 orphan/broken/duplicate card；
- `pha_issue` 映射为 `pha_task_id`；
- 24k 表格、Mermaid 和 CP 清单识别为候选 rich block；不自动用算法/LLM 删除旧正文，先备份并预览；
- `task_normalize` 变成 Obsidian 内部迁移命令。

### 阶段 5：切换 writer

- OpenCode 改为只注册新 Obsidian 插件的 MCP endpoint；
- 用户关闭 `win-console` 旧 Taskflow 的 MCP 与文件写入；
- 本轮不删除 `win-console` 代码，待新插件稳定后再单独决定是否清理；
- 切换前后运行一次 board/document reconcile，禁止双 writer 迁移。

双向 PHA、全天候 daemon 和 win-console 代码清理应在核心稳定后单独评估；Kanban 不是后续扩展，而是本轮的一等入口。

## 15. 验收标准

- 任一完成 section 缺少实际结果或证据时，工具拒绝写入；
- agent 无法自由改写 section core 布局、写日志表或 append 流水；表格/Mermaid/CP 清单可通过合法 rich block 写入；
- bug、需求、调研和配置示例渲染出同一组标题和近似长度；
- 自定义任务类型可在 board column 中配置；agent 只能选择 catalog 中的稳定 ID，不能制造拼写变体；
- 从 board 或 MCP 创建任务后，必须同时存在唯一文档、唯一 card 和正确链接；
- 移动 card 会改变任务类型，勾选 card 会改变完成状态，统计结果无需扫描正文推断；
- 24,576 字符 CP 清单可以保存和在 Obsidian 阅读，但 `task_resume` 只返回其 manifest；
- 新 session 的 resume 结果包含当前 checkpoint、最后验证点、唯一下一动作、blocker 和工作产物，不依赖聊天历史；
- 失败方案缺少已验证原因、scope 或 impact 时不能晋升为永久 constraint；
- 相同 `request_id` 重试不会重复 section 或 PHA comment；
- 两个 agent 同时更新同一 section 时，至少一方收到明确版本冲突；
- `task_resume` 与 `task_read(view="outline")` 不会把全文或 rich block 重新注入上下文；
- 人工修改未通过质量门时不会污染 PHA；
- 断网后重启 Obsidian，outbox 可继续同步；
- 同一 section 的多次 revision 始终更新同一个 PHA managed comment；
- PHA 普通讨论不会自动进入任务文档；
- 所有非客户端连接信息均可在 Obsidian 插件设置页配置和诊断；
- 使用包含无关对话、临时提问和失败尝试的相同 fixture 测试目标 LLM，最终 renderer 的标题/顺序一致且无禁入内容；
- 新插件启用时旧 `win-console` Taskflow writer 已关闭；
- 插件禁用后端口释放，任务 Markdown 仍可正常阅读。

## 16. 实现前唯一必须确认的外部条件

需要获得 PHA 的具体产品/API 文档，并确认至少以下能力：

1. 获取 task；
2. 列出或搜索 task comments；
3. 创建 comment；
4. 更新同一个 comment；
5. comment revision、ETag 或 `updated_at`；
6. comment 最大长度和限流规则；
7. 是否支持幂等键或可搜索的机器 marker。

其中“更新同一个 comment”是满足“一 section 一 comment”的硬条件；如果没有，只能接受显式的多 revision comment 降级模式。
