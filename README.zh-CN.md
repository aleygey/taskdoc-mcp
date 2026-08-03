# TaskDoc MCP 中文使用说明

TaskDoc MCP 是一个桌面版 Obsidian 插件：看板负责项目统计和任务入口，任务 Markdown 负责保存可长期追溯的 checkpoint，插件内嵌的 MCP 让 agent 按统一结构读写这些内容。

当前版本为 `0.1.0-alpha.2`。PHA 配置还是接口占位，尚不会产生真实同步。

## 1. 对象对应关系

| Obsidian / TaskDoc 对象 | 含义 |
| --- | --- |
| 一个看板 | 一个机型/项目 |
| 一个 H2 列（`##`） | 一类任务，由你配置稳定的类型 ID |
| 一张带 `[[任务文档]]` 链接的勾选卡片 | 一个具体任务 |
| 一个任务文档 | 一张卡片的长期任务记录 |
| 文档中的一个 H2 section | 一个可独立验收的子任务/checkpoint |
| 文档顶部“当前接续点” | 同一任务的覆盖式跨 session 快照，不是另一张卡片 |

看板列在当前设计中表示“任务类型”，不是执行状态；任务状态由卡片是否勾选以及任务文档的 `active/done/archived` 表示。

## 2. 第一次配置

### 2.1 先确定 Vault 的打开方式

插件所有文件字段都是**当前 Obsidian Vault 的相对路径**。

例如实际文件是：

```text
Z:\zhang\TaskVault\Boards\机型A.md
```

如果在 Obsidian 中把 `Z:\zhang\TaskVault` 打开为 Vault，则填写：

```text
看板文件：Boards/机型A.md
任务目录：Tasks/机型A
```

若 Vault 通过 `\\192.168.56.100\zhang\TaskVault` 打开，填写内容仍然相同。不要填写以下路径：

- `Z:\...` 或 `Z:/...`；
- `\\192.168.56.100\...` 或 `//192.168.56.100/...`；
- 虚拟机内部的 `/home/...`；
- 含 `..`、位于当前 Vault 外部的路径。

Windows Obsidian 无法直接访问只存在于虚拟机内部的绝对路径。应先用 SMB/共享目录暴露整个 Vault，再从 Windows 打开它。`Z:` 映射盘和 UNC 对插件没有语义差别；建议固定使用一种入口，并避免 Windows、虚拟机和旧 win-console writer 同时写同一组文件。

MCP 监听地址已经可以配置。虚拟机可直接连接 Windows 的 Host-only、桥接或局域网网卡地址，不需要再依赖反向代理重写 Host。

### 2.2 登记现有看板

1. 打开“设置 → 第三方插件 → TaskDoc MCP”。
2. 在“看板”区域点击“添加看板”。
3. 填写看板名称、项目 ID、看板文件相对路径和任务目录相对路径。
4. 点击“扫描二级标题”。
5. 为扫描出的每一列确认稳定的任务类型 ID 和校验配置。内部列 ID 由插件生成，不要手工改 `data.json`。

当前版本**不会自动遍历 Vault 发现旧看板**，需要逐个登记。扫描只读取已登记文件中的 H2 标题。

兼容的基本 Markdown 形状是：

```markdown
---
kanban-plugin: board
---

## 缺陷

- [ ] [[Tasks/机型A/修复启动异常|修复启动异常]]

## 功能

- [x] [[Tasks/机型A/增加诊断页|增加诊断页]]
```

旧看板文件一般不需要重建，但必须满足：列是非代码块中的 H2；卡片是列下顶层 checkbox；卡片中有 `[[wikilink]]`。当前解析器不支持 H3 列、缩进卡片或仅有普通 Markdown 链接的卡片。

特别注意：当前 alpha 不使用 Obsidian 的链接解析缓存。旧卡若只写 `[[修复启动异常]]`，而文档实际位于 `Tasks/机型A/`，插件会错误地到 Vault 根目录查找。接入前请把旧链接规范为包含完整 Vault 相对路径的形式。

### 2.3 连接 MCP 客户端

1. 选择监听地址和客户端连接地址；仅本机使用可都保持 `127.0.0.1`。
2. 保持默认端口 `27124`，除非端口冲突。
3. 启用“MCP 服务”或修改网络参数后点击“重启服务”。
4. 点击“复制客户端配置”。
5. 将生成的 JSON 放到 MCP 客户端配置中，然后重启或刷新客户端。
6. 让 agent 先调用 `task_catalog`；能看到已登记看板和列即连接成功。

服务地址默认为：

```text
http://127.0.0.1:27124/mcp
```

Bearer token 保存在 Obsidian SecretStorage。重新生成 token 后，之前复制的客户端配置会立即失效。

虚拟机常用配置：

| 场景 | 监听地址 | 客户端连接地址 |
| --- | --- | --- |
| 仅 Windows 本机 | `127.0.0.1` | `127.0.0.1` |
| 只监听 Host-only 网卡 | Windows Host-only IP，例如 `192.168.56.1` | 同一个 IP |
| 只监听桥接/局域网网卡 | 该网卡的 Windows IP | 同一个 IP 或可解析主机名 |
| 同时支持多个 IPv4 网卡 | `0.0.0.0` | 复制配置时希望使用的一个可达 Windows IP |
| 所有 IPv6 接口 | `::` | 一个具体可达 IPv6 地址，URL 会自动加方括号 |

监听 `0.0.0.0` 后，客户端可以按各自网络使用不同的 Windows 网卡 IP；“客户端连接地址”只是状态页和复制配置使用的默认地址，不是来源 IP 白名单。所有合法 IPv4/IPv6 Host 都可连接；若使用 DNS 主机名，则名称需与“客户端连接地址”一致。

Token 负责认证，不负责加密，也不代替 Windows 防火墙。当前传输是 HTTP：Host-only 网络可用防火墙只允许虚拟机 IP；桥接或局域网场景应只开放给可信网段，跨不可信网络需增加 TLS/VPN，不能直接暴露到公网。

## 3. 配置项说明

### MCP 服务

| 配置项 | 建议 | 说明 |
| --- | --- | --- |
| 启用 MCP 服务 | 开 | 关闭后 agent 无法连接，但文档和看板不受影响 |
| 监听地址 | `127.0.0.1` 或具体 VM 网卡 IP | 决定 Windows 哪些网卡接收连接；`0.0.0.0`/`::` 表示所有 IPv4/IPv6 接口 |
| 客户端连接地址 | 客户端实际可达的 Windows IP | 用于状态页和生成配置；不能填 `0.0.0.0`、`::`、协议、端口或路径 |
| 端口 | `27124` | 修改后需重新复制或同步更新客户端配置 |
| 允许的 Origin | 留空 | 仅浏览器型 MCP 客户端需要；多个完整 origin 用英文逗号分隔，如 `http://127.0.0.1:3000`，不要使用 `*` |
| 重新生成 token | 首次或泄露时使用 | 会使旧客户端配置失效 |
| 复制客户端配置 | 配完后使用 | 复制含 endpoint 和 Bearer token 的连接片段 |

### 文档质量和长度

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| 严格质量校验 | 开 | 拒绝对话原文、过程流水账、临时计划等不适合长期正文的内容；建议保持开启 |
| Checkpoint 核心上限 | 2,500 字符 | 只约束“目标与验收/关键判断/结果与证据”的渲染文本 |
| 单个富内容块上限 | 24,576 字符 | 表格、Mermaid、CP 清单、规格等放这里；可按大型 CP 清单需求提高 |
| 单个 checkpoint 富内容总量 | 96,000 字符 | 一个 section 下所有富内容块的总预算 |
| 接续卡上限 | 800 字符 | 只保留当前停点、唯一下一动作、阻塞和工作文件，防止接续内容膨胀 |

单个 MCP rich block 的协议硬上限是 200,000 字符。提高插件设置不能突破该硬上限。大型内容并没有被取消，而是从默认核心和跨 session 恢复包中分离，按需分页读取。

### 看板

| 配置项 | 说明 |
| --- | --- |
| 看板名称 | 人可读名称，例如“机型 A” |
| 项目 ID | 稳定机器 ID；不同看板不能重复，建立任务后不要随意修改 |
| 看板文件 | 当前 Vault 内的 Markdown 相对路径 |
| 任务目录 | 新任务文档和 rich block 资源的 Vault 相对目录 |
| 列 ID / 类型 ID | 稳定机器 ID；agent 只能引用 `task_catalog` 返回的现有值 |
| 校验配置 | `bug/feature/research/migration/configuration/maintenance/other`；影响完成时的证据规则，不改变文档版式 |

看板和列的稳定 ID 当前只保存在 `.obsidian/plugins/taskdoc-mcp/data.json`。若把同一个 Vault 带到另一台机器，请连同这个文件保留；只复制插件 release 再重新扫列可能生成不同 ID，导致已有新格式任务文档无法匹配。

插件内部会把第一次扫描到的首列记为默认列，但 MCP 写入仍要求 agent 明确传入 `column_id`。`autoConvertCards` 也是尚未开放到界面的保留字段，当前不会自动迁移旧卡片。

### PHA

| 配置项 | 当前含义 |
| --- | --- |
| Base URL | 将来填写公司 PHA API 根地址 |
| Workspace | 将来的默认 workspace；若不同看板映射不同项目，还需扩展为看板级配置 |
| Token SecretStorage 键 | 将来保存 PHA token 的 SecretStorage 键名 |

这些字段目前不会触发网络同步；见“PHA 映射与适配”。

## 4. MCP 工具和常用参数

工具名保持英文以兼容不同 MCP 客户端；工具标题、说明和 JSON Schema 参数描述已提供中文。

| 工具 | 何时使用 | 关键参数 |
| --- | --- | --- |
| `task_catalog` | 开始创建/分类前 | 无参数；返回合法 `board_id/column_id` |
| `task_query` | 找任务 | 可按 `board_id/column_id/state/query` 筛选 |
| `task_resume` | 新 session 接手已有任务时首先调用 | `task_id`；返回活动核心、已完成摘要、接续卡和 block 清单 |
| `task_read` | 需要大纲、某个 checkpoint 或大型 block 正文时 | `view=outline/checkpoint/block`，按视图提供 ID 和游标 |
| `task_create` | 新建任务 | `request_id`、目录返回的看板/列 ID、标题、目标、验收条件 |
| `task_card_update` | 改任务类型或重新打开 | `expected_revision`；只可移动到现有列 |
| `task_checkpoint_commit` | 创建或完整替换一个可验收子任务 | `checkpoint_id` 创建时省略、更新时必填；`core` 是完整新状态 |
| `task_block_put` | 保存表格、Mermaid、CP 清单、配置、规格和大型证据 | `kind/title/summary/supports/content` |
| `task_handoff` | 切换 session、上下文压缩或暂停前 | 当前 checkpoint、最后验证点、唯一下一动作、阻塞和工作文件 |
| `task_finalize` | 完成或归档整个任务 | 最终结果、至少一条关键证据、最多三条遗留事项 |

所有写工具都使用：

- `schema_version: 1`：当前写入契约版本；
- `request_id`：幂等键，同一次不确定重试必须复用，新动作必须换新值；
- `expected_revision`：乐观并发版本。发生冲突时先 `task_resume/task_read`，不要盲目重试旧内容。

推荐给 agent 的最短工作协议：

```text
新任务：task_catalog → task_create → task_checkpoint_commit
继续任务：task_resume → 必要时 task_read → 更新同一 checkpoint
大型资料：task_block_put，不塞入核心
暂停/换 session：task_handoff
完成：提交 done checkpoint → task_finalize
```

## 5. 任务文档现在怎样设计

一个任务文档由三层内容组成。

### 任务级信息

YAML frontmatter 保存稳定身份、看板/列绑定、任务目标、验收条件、状态和 revision。可选的 `pha_task_id` 用于将来绑定一个 PHA task。

### 当前接续点

活动任务顶部可有一个受管 callout：

```markdown
> [!taskdoc-resume] 当前接续点
> 当前：CP-02 · 实现同步适配器
> 最后已验证：评论创建接口已通过测试。
> 下一动作：实现同一评论的条件更新。
> 工作文件：`src/pha/adapter.ts`（已修改，未验证）。
```

它在同一个任务文档内持续覆盖，不创建新文档、看板卡片或 PHA comment。checkpoint 内容变化后旧接续卡会被清除，避免新 session 读到过期状态；因此暂停前需要重新调用 `task_handoff`。如果 session 在落盘前突然中断，只能恢复到最后一次已提交的 checkpoint/handoff。

### Checkpoint sections

每个 H2 是一个可独立验收的子任务，统一渲染：

```markdown
## CP-01 · 确认评论更新语义

### 目标与验收
- 目标：确认公司 PHA 是否支持原地更新同一 comment。
- [x] A1：已确认更新端点和并发条件。

### 关键判断
- 事实：接口使用 comment ID 定位，ETag 进行条件更新。
- 决定：一个 checkpoint 永久映射一个 comment ID。
- 约束：旧的追加评论方案不可用；原因已经由接口测试验证；仅适用于当前 PHA 版本；升级 API 后重新评估。

### 结果与证据
- 结果：已形成可幂等 upsert 的适配契约。
- 证据（test）：集成测试 `updates the same comment` 通过。
- 剩余风险：附件接口的大小限制仍待确认。

### 详细资料
- [接口请求响应样例](相对资源路径) — 支持关键判断。
```

固定的“目标与验收 → 关键判断 → 结果与证据”足以覆盖长期结论；跨 session 的短期停点由顶部接续卡补充。没有内容的长期区块不会为了填模板而强制渲染。

失败方案只在以下条件同时成立时进入永久正文：失败原因已经验证、会影响未来选择、适用范围明确、存在证据、知道何时可重评。普通尝试失败、临时 workaround、尚未证实的猜测只留在当前工作上下文，必要时短暂写入接续卡，不能形成 checkpoint 时间线。

## 6. 旧内容是否需要迁移

- **旧看板**：形状兼容时可以原地登记和扫描，不必复制或重建。
- **旧任务文档**：需要迁移。旧 win-console 文档没有 `task_schema: checkpoint/v1`、稳定 ID、revision 和受管 marker，新 MCP 不能安全写入。
- **旧 wikilink**：basename 链接需要规范为完整 Vault 相对路径。
- **无链接纯文本卡片**：当前不会自动转换。

当前 release 还没有迁移命令。不要直接在生产看板上批量尝试写工具；建议先复制一份 Vault 做兼容扫描。后续迁移器应提供只读预览、链接解析、旧 section 到 checkpoint 的人工确认和可回滚备份，而不是静默重写。

## 7. PHA 映射与适配

目标映射是：

```text
一个 board                ↔ 一个本地机型/项目（可映射 PHA workspace/project）
一张 card + 一个 task doc ↔ 一个 PHA task
一个 checkpoint/section   ↔ 该 PHA task 下一个固定 managed comment
```

不是把一个项目的所有看板卡片同步到同一个 PHA task。顶部接续卡不进入 PHA。

当前 alpha 只有 `pha_task_id` 字段、adapter 接口和内存 outbox 骨架，实际 adapter 不可用；评论、图片和附件均不会上传。公司 PHA 即使是开源项目的 fork，也需要一个本地适配器，但 agent 无需再手工同步：Obsidian 插件直接调用内网 API 即可。

实施前至少需要提供：

- 上游项目/版本以及公司修改情况；
- API Base URL、鉴权和内网证书要求；
- 查询任务、列出/搜索评论、创建评论、原地更新评论的接口；
- comment revision/ETag、幂等键、限流和最大长度；
- 文件/图片上传及关联 comment 的接口、MIME 和大小限制；
- 一份 OpenAPI/Swagger，或能够工作的 curl 请求与响应样例。

图片/附件同步还需要持久化 `vault path + SHA-256 + MIME + remote attachment ID/URL`，先上传再改写 comment 中的本地 embed，并通过持久 outbox 重试。这部分不是仅填写 Base URL 就能自动适配。

## 8. 已知边界

- Obsidian 必须保持运行，MCP 才可访问。
- 当前不会自动发现旧看板或迁移旧任务文档。
- `data.json` 中的看板/列稳定 ID 需要随 Vault 一起保留。
- 网络 Vault 没有跨主机分布式锁；必须避免多个 writer。
- 非回环 MCP 连接使用明文 HTTP；Token 认证不能替代防火墙、TLS 或 VPN。
- PHA 同步和附件上传尚未实现。
- 插件重载后，写请求的短期幂等结果缓存会清空；不确定请求应先重新读取。

完整设计和约束见 [TASKFLOW_VNEXT_DESIGN.md](./TASKFLOW_VNEXT_DESIGN.md)。
