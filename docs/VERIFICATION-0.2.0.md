# 0.2.0 交付验证

验证日期：2026-09-09。环境：macOS、Node.js v24.19.0、npm 11.17.0。

- TypeScript：通过。
- 自动化：51 项通过，0 失败。包含真实 MCP HTTP 客户端、领域流程、旧格式、冲突、持久化、回滚、看板尾部与归档，以及模拟 Obsidian 控件。
- 生产构建、生成 bundle 的语法检查：通过。
- npm audit：0 个已知漏洞。依赖审计是当时快照，不代表不存在未知问题。
- package.json、manifest.json、package-lock.json 与 versions.json：版本一致。
- ZIP：仅包含 main.js、manifest.json、styles.css，无配置、日志、凭据或用户数据。
- git diff --check：通过。

发布包：taskdoc-mcp-0.2.0.zip

SHA-256：

```text
c833c852fc2bb22232af6b5faeb820359d0c0497f5897a0690a34c76805fd49e
```

本地测试未在真实 Obsidian/Kanban 中执行视觉操作，也未验证 Windows/SMB 和多实例同时写入。CI 配置覆盖 Node.js 22/24；其远程运行结果以 PR 检查为准。
