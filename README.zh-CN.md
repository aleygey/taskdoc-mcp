# TaskDoc MCP 0.2.0

TaskDoc 是桌面版 Obsidian 插件，用任务 Markdown 保存目标、验收、证据和接续信息，用 Kanban 作为入口，并内嵌 MCP 服务供 AI 读写。人可以通过插件命令创建、修改和验收任务。

[English](README.md) · [升级说明](docs/MIGRATION-0.2.0.md) · [版本说明](RELEASE_NOTES.md) · [当前设计](docs/DESIGN-0.2.0.md)

## 安装与开始使用

1. 将发布包中的 `main.js`、`manifest.json`、`styles.css` 放入 `<vault>/.obsidian/plugins/taskdoc-mcp/`。最低 Obsidian 版本为 1.11.4，仅支持桌面端。
2. 在 Obsidian 中启用插件，在 TaskDoc 设置中登记已有 Markdown 看板，填写 Vault 相对路径并扫描二级标题。
3. 打开命令面板，执行 **TaskDoc MCP：创建任务**，填写目标和“怎样才算完成”。
4. 简单任务可直接执行 **验收或取消当前任务**；复杂任务再创建可独立验收的子任务（checkpoint）。
5. 需要 AI 接入时，开启 MCP 服务并复制客户端配置。默认端点为 `http://127.0.0.1:27124/mcp`，使用 Bearer token。

升级时保留已有 `data.json`、SecretStorage token 和 `runtime.json`。不要重新生成看板或列的稳定 ID。详细的映射盘、SMB、虚拟机网络及 token 说明见 [网络配置](docs/NETWORK.zh-CN.md)。

## 任务怎样工作

| 概念 | 0.2.0 行为 |
| --- | --- |
| 目标与验收 | 每项验收有稳定 ID，状态为待验证、已验证或豁免 |
| 证据 | 测试、观察、产物、来源或用户验收，可由多项验收引用 |
| 完成 | 所有任务验收均已验证并关联证据，或有明确豁免原因；活动子任务必须先结束 |
| 子任务 | 可选，适合独立决策、研究或交付单元；简单任务无需创建 |
| 接续点 | 任务级或子任务级快照，允许记录已改未验证事项、假设和下一步 |
| 长期资料 | 表格、配置、Mermaid、清单等仍使用 rich block，按需读取 |
| 人工纠正 | 使用编辑命令修正目标、范围、验收、状态及子任务记录 |

执行状态为 `planned / active / blocked / done / cancelled`。受阻任务必须说明阻塞原因与解除条件。**归档是独立属性**：已完成或已取消后，可将卡片收起到看板的 Archive 区。取消会保留已有记录，并结束尚未完成的子任务。重新打开会清除终态摘要、取消归档，并将任务验收重置为待验证。

一个看板可选择：

- **按任务类型分列**：兼容 0.1.x；列决定任务类型，状态单独记录。
- **按执行状态分列**：每个使用的状态需要映射列；任务类型单独配置、选择，不随进度移动而改变。

状态列不绕过验收：把卡片拖到“完成”或手动打勾，不能直接把任务判定为已完成。取消在状态看板上需要配置对应的取消列。切换已有看板的组织方式后，应检查映射并逐项协调已有任务。

## 人与 AI 共用的操作

命令面板提供：创建任务、编辑当前任务、编辑当前任务的子任务、验收或取消当前任务、协调当前任务的看板、恢复当前受管文档、查看任务诊断。

修改目标会重置任务验收；修改某一条件会重置该项；替换证据会重置引用了旧证据的验收；替换子任务核心会让引用该子任务证据的任务验收重新待验证。任务修改记录保留最近 20 次变更原因，不能代替 Vault 的完整版本历史。

接续点受相关变更影响时会保留并标为“待复核”，不会悄悄丢弃未验证工作。`task_resume` 返回仍有效的决定和约束，包括已完成子任务中的记录，并带来源和分页信息。取消或被替代的子任务不再提供有效约束。接手者必须读完 `context_complete=false` 的后续页，并核对过期接续点。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `task_catalog` | 获取看板、列、任务类型、状态映射和版本 |
| `task_query` | 查询任务，返回任务状态、卡片状态和冲突诊断；支持 `archived` 筛选 |
| `task_resume` | 接续点、活动子任务、有效约束与决定、验收覆盖 |
| `task_read` | 分页读取任务大纲、单个子任务或资料正文 |
| `task_create` | 同时创建任务文档与看板卡片 |
| `task_update` | 修改任务标题、目标、验收、证据、类型、状态或归档；需 `reason` |
| `task_card_update` | 兼容入口：移动列或重新打开任务 |
| `task_checkpoint_commit` | 新建或完整替换子任务核心 |
| `task_block_put` | 保存带类型和用途的长期资料 |
| `task_handoff` | 保存任务或活动子任务接续点，可含 `pending_checks` |
| `task_finalize` | 逐项验收后完成，或说明原因取消；`archived` 独立控制 |
| `task_reconcile` | 预览文档与看板差异，再选择方向应用 |

新调用推荐 `schema_version: 2`。版本 1 的请求格式仍接受，但完成任务同样需要逐项验收，旧客户端的自动结束逻辑需要调整。

所有写入均使用 `request_id`；重试同一操作保持 ID 和参数不变，新操作使用新 ID。任务修改使用最新 `document_revision`；更新子任务或资料使用对应对象的 revision，新建子任务/资料使用 `expected_revision: 0`。`task_reconcile` 应用时同时提交预览返回的文档与看板版本。

简单任务的完成参数示例（ID、版本须替换成实际返回值）：

```json
{
  "schema_version": 2,
  "request_id": "complete-task-unique-001",
  "task_id": "returned-task-id",
  "expected_revision": 1,
  "status": "done",
  "final_outcome": "Windows 和 Linux 均通过启动检查",
  "evidence": [
    {"id": "E-smoke", "type": "test", "statement": "两种系统的启动测试通过", "ref": "Tests/smoke.log"}
  ],
  "acceptance": [
    {"id": "AC-1", "status": "verified", "evidence_refs": ["E-smoke"]},
    {"id": "AC-2", "status": "verified", "evidence_refs": ["E-smoke"]}
  ],
  "remaining": []
}
```

任务证据使用自身 ID；子任务证据使用 `checkpoint_id/evidence_id`。豁免使用 `status: "waived"` 和 `waiver_reason`，不能代替真实验证。校验只能检查结构、引用与声明的证据类型，不能确认测试是否实际运行。

类型规则：缺陷需要测试或观察，功能需要测试/观察/用户验收，研究需要来源/观察/产物，迁移、配置、维护需要测试/观察/产物；`other` 不限制证据类型。0.2.0 的任务级每一项已验证验收，都必须引用符合该类型的证据。

## 冲突、恢复与持久化

- 坏链接或损坏任务不会让同一看板的健康任务从查询中消失。查询最多展示 50 条诊断，`diagnostics_total` 与 `diagnostics_truncated` 说明数量；修复后重新查询。
- 人工移动/打勾与文档不一致时，查询显式报告冲突。协调窗口先预览，再选择以文档为准或采用看板变更；两边任一版本变化都会拒绝过期预览。
- 标题改名后文件名不变。新文件使用 UUID，卡片仍显示可读标题。`[API]`、`C#` 和竖线标题不会破坏新链接。
- 手改受管正文会触发冲突。恢复窗口展示当前内容和重建内容，应用前将原文件备份为 `TaskDoc Backups/*.txt`；人工新增的正文不会自动变成结构化数据。
- 插件私有 `runtime.json` 保存请求幂等记录和跨文件写入日志。重启后，同一请求不会重复创建任务；最近 1,000 个成功请求可重放结果，更早的请求返回 `IDEMPOTENCY_EXPIRED`，仍阻止重复执行。
- 中断写入会阻止后续写操作。诊断窗口可以条件回滚：如果检测到后来的人工作品，会停止恢复并保留文件。不要靠删除日志解除保护。

默认核心区 2,500 字符、单资料 24,576 字符、每子任务资料总量 98,304 字符、接续点 1,600 字符。文字质量提醒可关闭；结构、引用和验收仍校验。合法 YAML 配置和不确定表述不再因关键词被一概拒绝。

MCP 返回上限为 64 KiB。分页按数量和内容大小共同限制；过大的活动核心会返回 ID 大纲，须逐个 `task_read`。写入已成功但结果过大时返回成功凭据与 `result_omitted`，不要重复创建。

## 兼容边界

- 这是单 Vault、单个 Obsidian 插件实例的写入协调，不提供多电脑同时写入的分布式锁。共享盘上应避免多个写入者。
- 支持 H2 列、顶层 checkbox、完整 Vault 相对路径 wikilink、Kanban 设置尾部及标准 Archive 区。短文件名链接不使用 Obsidian 模糊解析；配置的任务目录避免 `#`、`^`、`[]`、`|`。
- 看板必须先登记；不自动转换普通卡片，不导入旧 win-console 文档。`checkpoint/v1` TaskDoc 文档可读取，并在修改时升级到 v2。
- PHA 接口仍为预留，不提供远端任务、评论或附件同步。
- 发布前的自动化包含服务流程、MCP HTTP、故障恢复和模拟 Obsidian 控件操作；真实 Obsidian/Kanban 的视觉与跨平台交互需要在测试 Vault 中确认。

## 开发与打包

```sh
npm ci
npm run check
npm run package:release
```

发布产物在 `release/taskdoc-mcp-0.2.0.zip`。源码测试与生产构建无需读取用户 Vault。建议 Node.js 22 或 24。
