import { Notice, PluginSettingTab, Setting } from "obsidian";
import type TaskDocPlugin from "./main";
import type { BoardConfig, TaskDocSettings, ValidationProfile } from "./types";
import { newId } from "./util/id";

export const DEFAULT_SETTINGS: TaskDocSettings = {
  mcpEnabled: true,
  mcpBindHost: "127.0.0.1",
  mcpClientHost: "127.0.0.1",
  mcpPort: 27124,
  mcpTokenSecretKey: "taskdoc-mcp-token",
  allowedOrigins: [],
  strictQuality: true,
  coreCharLimit: 2500,
  blockCharLimit: 24576,
  totalBlockCharLimit: 96000,
  resumeCharLimit: 1600,
  boards: [],
  pha: {
    enabled: false,
    baseUrl: "",
    workspace: "",
    tokenSecretKey: "taskdoc-pha-token",
  },
};

const PROFILES: ValidationProfile[] = [
  "bug",
  "feature",
  "research",
  "migration",
  "configuration",
  "maintenance",
  "other",
];

const PROFILE_LABELS: Record<ValidationProfile, string> = {
  bug: "缺陷（bug）",
  feature: "功能（feature）",
  research: "调研（research）",
  migration: "迁移（migration）",
  configuration: "配置（configuration）",
  maintenance: "维护（maintenance）",
  other: "其他（other）",
};

export class TaskDocSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: TaskDocPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h1", { text: "TaskDoc MCP 设置" });

    this.renderMcp();
    this.renderBoards();
    this.renderDocuments();
    this.renderPha();
    this.renderDiagnostics();
  }

  private renderMcp(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "MCP 服务" });

    new Setting(containerEl)
      .setName("启用 MCP 服务")
      .setDesc(
        "在下面配置的网络地址上启动 MCP。网络相关配置修改后需要重启服务；开关本项会自动重启。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.mcpEnabled)
          .onChange(async (value) => {
            this.plugin.settings.mcpEnabled = value;
            await this.plugin.saveSettings();
            await this.plugin.restartMcp();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("监听地址（Bind host）")
      .setDesc(
        "Windows 上实际监听的网卡地址。127.0.0.1 仅限本机；可填写 Host-only、桥接或局域网网卡地址，例如 192.168.56.1；0.0.0.0 监听所有 IPv4 接口，:: 监听所有 IPv6 接口。它不是客户端 IP 白名单。修改后请重启服务。",
      )
      .addText((text) =>
        text
          .setPlaceholder("127.0.0.1")
          .setValue(this.plugin.settings.mcpBindHost)
          .onChange(async (value) => {
            this.plugin.settings.mcpBindHost = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("客户端连接地址（Client host）")
      .setDesc(
        "虚拟机或其他客户端用来访问 Windows 的 IP 或主机名，用于生成客户端配置和显示连接地址，不是客户端来源 IP 白名单。所有合法 IP Host 都可连接；若使用 DNS 主机名，则该名称需与这里一致。只填主机部分，不要包含 http://、端口或路径。修改后请重启服务。",
      )
      .addText((text) =>
        text
          .setPlaceholder("192.168.56.1")
          .setValue(this.plugin.settings.mcpClientHost)
          .onChange(async (value) => {
            this.plugin.settings.mcpClientHost = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("p", {
      cls: "taskdoc-mcp-warning",
      text: "安全提醒：Bearer Token 负责客户端认证，监听地址不用于限制客户端来源。将服务开放到非回环接口后，请保管好令牌，并用 Windows 防火墙限制可信虚拟机或网段；当前连接是未加密 HTTP，不要直接暴露到公网。",
    });

    new Setting(containerEl)
      .setName("监听端口")
      .setDesc(
        "当前 Vault 的 MCP 端口，范围 1024–65535。多个 Vault 同时使用时必须分别配置不同端口。修改后请点击下方“重启服务”。",
      )
      .addText((text) =>
        text
          .setPlaceholder("27124")
          .setValue(String(this.plugin.settings.mcpPort))
          .onChange(async (value) => {
            const port = Number(value);
            if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
              this.plugin.settings.mcpPort = port;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("允许的浏览器来源（Origins）")
      .setDesc(
        "仅供浏览器 MCP 客户端跨域连接使用，多个来源用英文逗号分隔，例如 http://localhost:3000。原生 MCP 客户端建议留空。修改后请重启服务。",
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.allowedOrigins.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.allowedOrigins = value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    const running = this.plugin.mcpStatus();
    new Setting(containerEl)
      .setName("连接状态")
      .setDesc(
        running.running
          ? `运行中：${running.endpoint}`
          : `已停止${running.error ? `：${running.error}` : ""}`,
      )
      .addButton((button) =>
        button.setButtonText("重启服务").onClick(async () => {
          await this.plugin.restartMcp();
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText("复制客户端配置").onClick(async () => {
          try {
            await navigator.clipboard.writeText(
              await this.plugin.clientConfig(),
            );
            new Notice("已复制 TaskDoc MCP 客户端配置。");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }),
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("重新生成令牌")
          .onClick(async () => {
            await this.plugin.regenerateMcpToken();
            await this.plugin.restartMcp();
            new Notice("MCP 令牌已重新生成，请更新所有客户端配置。");
          }),
      );
  }

  private renderBoards(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "看板" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "一个看板对应一个项目；列可按类型或执行状态组织。任务文档记录执行状态，复选框和归档区作为看板展示；手动变更后可预览协调。",
    });
    containerEl.createEl("p", {
      cls: "taskdoc-mcp-warning",
      text: "兼容提醒：扫描只登记列，不会迁移旧任务文档。旧 win-console 文档尚不能由新版 MCP 直接写入；旧卡片的 [[链接]] 也应包含完整的 Vault 相对路径，不能只写位于子目录中的文件名。",
    });

    for (const board of this.plugin.settings.boards) {
      const wrapper = containerEl.createDiv({ cls: "taskdoc-mcp-board-row" });
      wrapper.createEl("h3", { text: board.name || "未命名看板" });
      this.renderBoard(wrapper, board);
    }

    new Setting(containerEl)
      .setName("登记看板")
      .setDesc(
        "只新增一条配置，不会创建或改写 Markdown 看板。填写已有看板路径后，再扫描其中的列。",
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText("添加")
          .onClick(async () => {
            this.plugin.settings.boards.push({
              id: newId(),
              name: "新项目",
              projectId: `project-${this.plugin.settings.boards.length + 1}`,
              file: "",
              tasksFolder: "Tasks",
              autoConvertCards: false,
              columns: [],
            });
            await this.plugin.saveSettings();
            this.display();
          }),
      );
  }

  private renderBoard(container: HTMLElement, board: BoardConfig): void {
    new Setting(container)
      .setName("列的组织方式")
      .setDesc(
        "按类型分类，或按执行状态推进。切换后检查列映射；原任务类型单独保留。",
      )
      .addDropdown((d) =>
        d
          .addOptions({ type: "任务类型", state: "执行状态" })
          .setValue(board.columnMode ?? "type")
          .onChange(async (v) => {
            board.columnMode = v as "type" | "state";
            if (v === "state" && !board.taskTypes)
              board.taskTypes = [
                ...new Map(
                  board.columns.map((c) => [
                    c.typeId,
                    { id: c.typeId, name: c.heading, profile: c.profile },
                  ]),
                ).values(),
              ];
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    if (board.columnMode === "state") {
      container.createEl("p", {
        text: "为列映射执行状态；需要使用的每个状态都必须有对应列。已完成和已取消仍需通过验收窗口或 task_finalize 进入。",
      });
      board.taskTypes ??= [{ id: "other", name: "其他", profile: "other" }];
      for (const type of board.taskTypes)
        new Setting(container)
          .setName("任务类型")
          .addText((t) =>
            t
              .setValue(type.id)
              .setPlaceholder("稳定类型标识")
              .onChange(async (v) => {
                type.id = v.trim();
                await this.plugin.saveSettings();
              }),
          )
          .addText((t) =>
            t
              .setValue(type.name)
              .setPlaceholder("显示名称")
              .onChange(async (v) => {
                type.name = v;
                await this.plugin.saveSettings();
              }),
          )
          .addDropdown((d) => {
            for (const p of PROFILES) d.addOption(p, PROFILE_LABELS[p]);
            d.setValue(type.profile).onChange(async (v) => {
              type.profile = v as ValidationProfile;
              await this.plugin.saveSettings();
            });
          });
      new Setting(container).addButton((b) =>
        b.setButtonText("新增任务类型").onClick(async () => {
          board.taskTypes!.push({
            id: `type-${newId()}`,
            name: "新类型",
            profile: "other",
          });
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    }
    new Setting(container)
      .setName("项目名称")
      .setDesc("仅用于界面和 MCP 返回结果中的显示名称，可以使用中文。")
      .addText((text) =>
        text.setValue(board.name).onChange(async (value) => {
          board.name = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(container)
      .setName("项目 ID")
      .setDesc(
        "项目的稳定机器标识，用于关联和同步。建议使用简短英文、数字和连字符；创建任务后不要随意修改。",
      )
      .addText((text) =>
        text.setValue(board.projectId).onChange(async (value) => {
          board.projectId = value.trim();
          await this.plugin.saveSettings();
        }),
      );
    new Setting(container)
      .setName("看板文件")
      .setDesc(
        "相对于当前 Obsidian Vault 的 Markdown 路径，例如 Projects/机型A.md。不要填写 Z:\\、UNC/SMB 地址或虚拟机内的绝对路径；应先把共享目录作为 Vault 打开，再填写 Vault 内的相对路径。",
      )
      .addText((text) =>
        text
          .setPlaceholder("Projects/机型A.md")
          .setValue(board.file)
          .onChange(async (value) => {
            board.file = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(container)
      .setName("任务文档目录")
      .setDesc(
        "相对于当前 Vault 的目录。新任务文档会保存在这里，并由看板卡片链接；同样不能填写绝对路径。",
      )
      .addText((text) =>
        text
          .setPlaceholder("Tasks/机型A")
          .setValue(board.tasksFolder)
          .onChange(async (value) => {
            board.tasksFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(container)
      .setName("看板列")
      .setDesc(
        board.columns.length === 0
          ? "尚未扫描。看板路径有效后，扫描其中所有二级标题（##）。"
          : `已映射 ${board.columns.length} 个列。看板标题有变化时请重新扫描。`,
      )
      .addButton((button) =>
        button.setButtonText("扫描二级标题").onClick(async () => {
          try {
            await this.plugin.refreshBoardColumns(board.id);
            this.display();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        }),
      )
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("移除配置")
          .onClick(async () => {
            this.plugin.settings.boards = this.plugin.settings.boards.filter(
              (candidate) => candidate.id !== board.id,
            );
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    for (const column of board.columns) {
      new Setting(container)
        .setName(`标题映射：${column.heading}`)
        .addButton((b) =>
          b.setButtonText("重连标题").onClick(() => {
            void this.plugin.relinkColumn(board.id, column.id);
          }),
        );
      if (board.columnMode === "state")
        new Setting(container).setName("对应执行状态").addDropdown((d) =>
          d
            .addOptions({
              "": "请选择",
              planned: "待开始",
              active: "进行中",
              blocked: "受阻",
              done: "已完成",
              cancelled: "已取消",
            })
            .setValue(column.state ?? "")
            .onChange(async (v) => {
              if (v) column.state = v as NonNullable<typeof column.state>;
              else delete column.state;
              await this.plugin.saveSettings();
            }),
        );
      new Setting(container)
        .setName(column.heading)
        .setDesc(
          `列 ID：${column.id}。右侧依次为稳定的任务类型 ID 和校验模板；标题改名后重新扫描可能需要重新确认映射。`,
        )
        .addText((text) =>
          text
            .setPlaceholder("任务类型 ID")
            .setValue(column.typeId)
            .onChange(async (value) => {
              column.typeId = value.trim();
              await this.plugin.saveSettings();
            }),
        )
        .addDropdown((dropdown) => {
          for (const profile of PROFILES)
            dropdown.addOption(profile, PROFILE_LABELS[profile]);
          dropdown.setValue(column.profile).onChange(async (value) => {
            column.profile = value as ValidationProfile;
            await this.plugin.saveSettings();
          });
        });
    }
  }

  private renderDocuments(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "任务文档" });
    new Setting(containerEl)
      .setName("文字质量提醒")
      .setDesc(
        "开启后对占位词、过程叙述和不确定表达给出提醒。关闭不影响结构、证据引用和验收校验。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.strictQuality)
          .onChange(async (value) => {
            this.plugin.settings.strictQuality = value;
            await this.plugin.saveSettings();
          }),
      );
    this.numberSetting(
      "Checkpoint 核心区字符上限",
      "每个 section 的目标、判断、结果等核心内容上限。长表格、Mermaid、清单和配置应放入详细资料（Rich Block）。",
      "coreCharLimit",
      500,
      20000,
    );
    this.numberSetting(
      "单个详细资料字符上限",
      "每个 Rich Block 的字符上限，默认 24,576；用于容纳大型表格、Mermaid、清单、配置或证据。",
      "blockCharLimit",
      1000,
      200000,
    );
    this.numberSetting(
      "单个 Checkpoint 详细资料总上限",
      "同一 section 下所有 Rich Block 的字符总上限。",
      "totalBlockCharLimit",
      1000,
      1000000,
    );
    this.numberSetting(
      "接续卡字符上限",
      "任务文档顶部的可覆盖交接状态上限。接续卡只记录下一步和阻塞项，不属于永久任务历史。",
      "resumeCharLimit",
      200,
      5000,
    );
  }

  private numberSetting(
    name: string,
    description: string,
    key:
      | "coreCharLimit"
      | "blockCharLimit"
      | "totalBlockCharLimit"
      | "resumeCharLimit",
    min: number,
    max: number,
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings[key]))
          .onChange(async (value) => {
            const parsed = Number(value);
            if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
              this.plugin.settings[key] = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );
  }

  private renderPha(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "PHA 同步（预留）" });
    containerEl.createEl("p", {
      cls: "taskdoc-mcp-warning",
      text: "当前版本 只包含 PHA 适配器接口，尚未实现远端同步。目标映射是一张看板卡片/任务文档对应一个 PHA task、每个 section/checkpoint 对应该 task 下一个 comment；接续卡不参与同步。下面的配置暂时不会上传任务、comment、附件或图片。",
    });
    new Setting(containerEl)
      .setName("API 基础地址（预留）")
      .setDesc(
        "公司 PHA 服务的 API 根地址，不是浏览器中的看板页面地址；当前版本仅保存，不会发起同步。",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://pha.example.com/api")
          .setValue(this.plugin.settings.pha.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.pha.baseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName("工作区 / 项目标识（预留）")
      .setDesc(
        "PHA API 使用的 workspace 或 project ID；并不是把整个看板同步为一个 PHA task。当前版本仅保存。",
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.pha.workspace)
          .onChange(async (value) => {
            this.plugin.settings.pha.workspace = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    const hasPhaToken = Boolean(
      this.app.secretStorage.getSecret(this.plugin.settings.pha.tokenSecretKey),
    );
    new Setting(containerEl)
      .setName("PHA 访问令牌（预留）")
      .setDesc(
        hasPhaToken
          ? "令牌已保存在 Obsidian SecretStorage；输入新值可替换。当前版本不会使用它发起同步。"
          : "尚未保存令牌。令牌仅存入 Obsidian SecretStorage，不写入普通插件配置。",
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(hasPhaToken ? "已保存" : "粘贴令牌")
          .onChange((value) => {
            if (value)
              this.app.secretStorage.setSecret(
                this.plugin.settings.pha.tokenSecretKey,
                value,
              );
          });
      })
      .addButton((button) =>
        button
          .setWarning()
          .setButtonText("清除")
          .onClick(() => {
            this.app.secretStorage.setSecret(
              this.plugin.settings.pha.tokenSecretKey,
              "",
            );
            this.display();
          }),
      );
  }

  private renderDiagnostics(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "诊断信息" });
    new Setting(containerEl).setName("看板与任务检查").addButton((b) =>
      b.setButtonText("打开诊断与恢复").onClick(() => {
        void this.plugin.openDiagnostics();
      }),
    );
    new Setting(containerEl).setName("新建任务").addButton((b) =>
      b.setButtonText("创建任务").onClick(() => {
        void this.plugin.openCreateTask();
      }),
    );
    const status = this.plugin.mcpStatus();
    containerEl.createEl("p", {
      cls: `taskdoc-mcp-status${status.running ? " is-running" : ""}`,
      text: status.running
        ? `MCP 运行中：${status.endpoint}`
        : `MCP 已停止${status.error ? `：${status.error}` : ""}`,
    });
    containerEl.createEl("p", {
      cls: "taskdoc-mcp-status",
      text: `已登记 ${this.plugin.settings.boards.length} 个看板。PHA 适配器：当前版本 不可用。`,
    });
  }
}
