import { Notice, Plugin } from "obsidian";
import { randomBytes } from "node:crypto";
import { parseBoard } from "./kanban/index.js";
import { formatMcpEndpoint, McpHttpGateway } from "./mcp/index.js";
import { ObsidianVaultAdapter, safeVaultPath } from "./obsidian/vaultAdapter.js";
import { TaskService } from "./service.js";
import { DEFAULT_SETTINGS, TaskDocSettingTab } from "./settings.js";
import type { BoardColumnConfig, TaskDocSettings, ValidationProfile } from "./types.js";
import { newId } from "./util/id.js";

interface DisplayMcpStatus {
  running: boolean;
  endpoint?: string;
  error?: string;
}

export default class TaskDocPlugin extends Plugin {
  override settings: TaskDocSettings = structuredClone(DEFAULT_SETTINGS);
  private vaultAdapter: ObsidianVaultAdapter | undefined;
  private taskService: TaskService | undefined;
  private gateway: McpHttpGateway | undefined;
  private lastMcpError: string | undefined;
  private initialized = false;
  private unloading = false;
  private restartQueue: Promise<void> = Promise.resolve();

  override async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureMcpToken();
    this.addSettingTab(new TaskDocSettingTab(this));

    this.addCommand({
      id: "restart-mcp-server",
      name: "重启 MCP 服务",
      callback: () => { void this.restartMcp(); }
    });
    this.addCommand({
      id: "copy-mcp-client-config",
      name: "复制 MCP 客户端配置",
      callback: () => {
        void this.clientConfig().then(async (config) => {
          await navigator.clipboard.writeText(config);
          new Notice("已复制 TaskDoc MCP 客户端配置。");
        }).catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : String(error));
        });
      }
    });

    this.app.workspace.onLayoutReady(() => {
      void this.initializeRuntime().catch((error: unknown) => {
        this.lastMcpError = error instanceof Error ? error.message : String(error);
        new Notice(`TaskDoc MCP 初始化失败：${this.lastMcpError}`);
      });
    });
  }

  override onunload(): void {
    this.unloading = true;
    void this.stopMcp();
  }

  async saveSettings(): Promise<void> {
    this.taskService?.setSettings(this.runtimeSettings());
    await this.saveData(this.settings);
  }

  restartMcp(): Promise<void> {
    const operation = this.restartQueue.then(() => this.performRestartMcp());
    this.restartQueue = operation.catch(() => undefined);
    return operation;
  }

  private async performRestartMcp(): Promise<void> {
    try {
      await this.stopMcp();
      if (!this.settings.mcpEnabled || this.unloading) return;
      await this.initializeRuntime(false);
      const service = this.taskService;
      if (!service) throw new Error("Task service is not initialized");
      const token = await this.ensureMcpToken();
      const gateway = new McpHttpGateway({
        api: service,
        token,
        bindHost: this.settings.mcpBindHost,
        clientHost: this.settings.mcpClientHost,
        port: this.settings.mcpPort,
        allowedOrigins: this.settings.allowedOrigins,
        name: "taskdoc-mcp",
        version: this.manifest.version
      });
      await gateway.start();
      if (this.unloading || !this.settings.mcpEnabled) {
        await gateway.stop();
        return;
      }
      this.gateway = gateway;
      this.lastMcpError = undefined;
    } catch (error) {
      this.lastMcpError = error instanceof Error ? error.message : String(error);
      this.gateway = undefined;
      new Notice(`TaskDoc MCP 启动失败：${this.lastMcpError}`);
    }
  }

  mcpStatus(): DisplayMcpStatus {
    const status = this.gateway?.status();
    if (status?.running && status.endpoint) return { running: true, endpoint: status.endpoint };
    return {
      running: false,
      ...(this.lastMcpError === undefined ? {} : { error: this.lastMcpError })
    };
  }

  async regenerateMcpToken(): Promise<void> {
    this.app.secretStorage.setSecret(this.settings.mcpTokenSecretKey, randomBytes(32).toString("base64url"));
  }

  async clientConfig(): Promise<string> {
    const token = await this.ensureMcpToken();
    const url = mcpClientUrl(this.settings.mcpClientHost, this.settings.mcpPort);
    return JSON.stringify({
      mcp: {
        taskdoc: {
          type: "remote",
          url,
          enabled: true,
          oauth: false,
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    }, null, 2);
  }

  async refreshBoardColumns(boardId: string): Promise<void> {
    const board = this.settings.boards.find((candidate) => candidate.id === boardId);
    if (!board) throw new Error(`Board is not configured: ${boardId}`);
    board.file = safeVaultPath(board.file);
    board.tasksFolder = safeVaultPath(board.tasksFolder);
    const adapter = this.vaultAdapter ?? new ObsidianVaultAdapter(this.app.vault);
    const source = await adapter.read(board.file);
    const parsed = parseBoard(source);
    const previous = new Map(board.columns.map((column) => [column.heading, column]));
    board.columns = parsed.columns.map((column): BoardColumnConfig => {
      const existing = previous.get(column.heading);
      if (existing) return existing;
      const typeId = slug(column.heading) || `type-${board.columns.length + 1}`;
      return {
        id: newId(),
        heading: column.heading,
        typeId,
        profile: guessProfile(typeId)
      };
    });
    if (!board.defaultColumnId || !board.columns.some((column) => column.id === board.defaultColumnId)) {
      const firstColumn = board.columns[0];
      if (firstColumn) board.defaultColumnId = firstColumn.id;
      else delete board.defaultColumnId;
    }
    await this.saveSettings();
  }

  private async initializeRuntime(startMcp = true): Promise<void> {
    if (!this.initialized) {
      this.vaultAdapter = new ObsidianVaultAdapter(this.app.vault);
      this.taskService = new TaskService(this.vaultAdapter, this.runtimeSettings());
      this.initialized = true;
    }
    if (startMcp && this.settings.mcpEnabled && !this.gateway?.status().running) {
      await this.restartMcp();
    }
  }

  private async stopMcp(): Promise<void> {
    const gateway = this.gateway;
    this.gateway = undefined;
    if (gateway) await gateway.stop();
  }

  private async ensureMcpToken(): Promise<string> {
    const current = this.app.secretStorage.getSecret(this.settings.mcpTokenSecretKey);
    if (current) return current;
    const token = randomBytes(32).toString("base64url");
    this.app.secretStorage.setSecret(this.settings.mcpTokenSecretKey, token);
    return token;
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<TaskDocSettings> | null;
    this.settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...(loaded ?? {}),
      boards: loaded?.boards ?? [],
      pha: { ...DEFAULT_SETTINGS.pha, ...(loaded?.pha ?? {}) }
    };
  }

  private runtimeSettings(): TaskDocSettings {
    return {
      ...this.settings,
      boards: this.settings.boards.filter((board) =>
        board.file.trim().length > 0 &&
        board.tasksFolder.trim().length > 0 &&
        board.columns.length > 0
      )
    };
  }
}

function mcpClientUrl(host: string, port: number): string {
  const trimmed = host.trim();
  if (trimmed.length === 0) throw new Error("客户端连接地址不能为空");
  if (trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    throw new Error("客户端连接地址必须是客户端可达的具体 IP 或主机名，不能使用监听通配地址");
  }
  try {
    return formatMcpEndpoint(trimmed, port);
  } catch {
    throw new Error("客户端连接地址格式无效：请只填写 IPv4、IPv6 或主机名，不要包含协议、端口或路径");
  }
}

function slug(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 64);
}

function guessProfile(typeId: string): ValidationProfile {
  if (/bug|fix|故障|缺陷|问题/i.test(typeId)) return "bug";
  if (/feature|需求|功能/i.test(typeId)) return "feature";
  if (/research|investigat|调研|分析/i.test(typeId)) return "research";
  if (/migrat|迁移/i.test(typeId)) return "migration";
  if (/config|配置/i.test(typeId)) return "configuration";
  if (/maint|维护/i.test(typeId)) return "maintenance";
  return "other";
}
