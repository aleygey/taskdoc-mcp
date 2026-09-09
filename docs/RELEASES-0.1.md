# TaskDoc MCP 0.1.0-alpha.2

这是中文界面与接入说明更新，适合已经安装首个 alpha 的用户直接覆盖升级。

## 本版更新

- Obsidian 设置页、命令和通知改为中文，并为所有可见配置项补充用途、范围与风险说明。
- 10 个 MCP 工具保留稳定英文工具名，但增加中文标题、写作协议和逐参数 JSON Schema 描述。
- MCP 监听地址不再写死为 `127.0.0.1`：支持具体 Host-only/桥接/LAN 地址、`0.0.0.0` 和 `::`，并单独配置客户端可达地址。
- 新增完整中文使用文档，说明已有看板登记、Z 盘/SMB 路径、跨 session 接续、任务文档结构和 PHA 目标映射。
- 在设置页明确提示：扫描旧看板不会迁移旧任务文档；PHA adapter、comment、图片和附件同步当前仍未实现。
- 中文看板列名可辅助推断校验 profile。

## 升级

下载 `taskdoc-mcp-0.1.0-alpha.2.zip`，覆盖 `<vault>/.obsidian/plugins/taskdoc-mcp/` 下的 `main.js`、`manifest.json` 和 `styles.css`，然后在 Obsidian 中重载插件。

已有 `.obsidian/plugins/taskdoc-mcp/data.json` 不要删除，其中包含看板和列的稳定 ID。

压缩包 SHA-256：`FFA1FF22722B42742260603F41D5B0DEE33965C9F7FD8ED57B2E7D42DE01EE43`

## 重要兼容边界

- 已有标准 Markdown 看板可逐个登记并扫描，当前不会自动发现整个 Vault。
- 旧 win-console 任务文档还不能由新 MCP 直接管理，需要后续迁移器。
- 旧卡片若链接子目录中的任务文档，`[[链接]]` 需要包含完整 Vault 相对路径。
- 看板文件和任务目录只填 Vault 相对路径；不要填 `Z:\\...`、UNC/SMB URL 或虚拟机内部绝对路径。
- PHA 配置仍为预留，不会产生真实 task/comment/附件同步。
- 非回环监听仍为 HTTP；Token 负责认证但不加密流量，应配合 Windows 防火墙，跨不可信网络时使用 TLS/VPN。

## 验证

- TypeScript 类型检查通过。
- 25 项自动化测试全部通过。
- 生产 bundle 构建通过。

---

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
