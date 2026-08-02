# TaskDoc MCP 0.1.0-alpha.1

首个可安装测试版，将任务文档 MCP 从 `win-console` 拆成独立的 Obsidian 桌面插件。

## 本版可测试

- 在 Obsidian 插件设置中登记多个 Markdown 看板，并将列映射为稳定任务类型。
- 通过 10 个 MCP 工具创建、查询、恢复、更新和完成任务。
- 使用固定的 checkpoint 结构记录目标与验收、关键判断、结果与证据。
- 将已验证的失败方案保存为带证据和重新评估条件的永久约束。
- 使用独立 rich block 保存表格、Mermaid、CP 清单、规格与测试证据；单块默认最多 24,576 字。
- 使用有上限的 handoff capsule 在新 session 中恢复当前 checkpoint、下一步、阻塞和工作文件。
- 无损移动或勾选看板卡片；文档和 checkpoint 均有 revision/hash 冲突保护。
- MCP 仅监听 `127.0.0.1`，使用 Obsidian SecretStorage 中的 Bearer token。

## 安装

下载 `taskdoc-mcp-0.1.0-alpha.1.zip`，解压至：

```text
<vault>/.obsidian/plugins/taskdoc-mcp/
```

然后在 Obsidian 的社区插件页面启用 **TaskDoc MCP**。请关闭 `win-console` 中原有的 Taskflow 写入功能，避免两个写入端同时修改同一文档或看板。

压缩包 SHA-256：`B4DCD073E3C522833F6919DC9F8591AF803B668EDE898752A215027B2F65B321`

## 已知限制

- PHA 同步接口和 outbox 边界已经预留，但本版不启用真实同步；需要先明确 PHA task/comment API，尤其是 comment 更新、版本冲突和幂等语义。
- Obsidian 必须保持运行，MCP 客户端才能连接。
- `request_id` 的结果缓存目前只在本次插件运行期间有效；若 Obsidian 在写入响应前重启，应先重新读取任务，再决定是否重试。
- 手工新增的无链接卡片不会在本版自动转换；请通过 MCP 创建任务。rich block 写入若在进程崩溃窗口中断，会以 hash conflict 暴露，但尚无自动 journal 修复。
- 这是预发布版本，请先在可备份的测试 vault 中验证。
