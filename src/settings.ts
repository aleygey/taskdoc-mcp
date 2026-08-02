import { Notice, PluginSettingTab, Setting } from "obsidian";
import type TaskDocPlugin from "./main";
import type { BoardConfig, TaskDocSettings, ValidationProfile } from "./types";
import { newId } from "./util/id";

export const DEFAULT_SETTINGS: TaskDocSettings = {
  mcpEnabled: true,
  mcpPort: 27124,
  mcpTokenSecretKey: "taskdoc-mcp-token",
  allowedOrigins: [],
  strictQuality: true,
  coreCharLimit: 2500,
  blockCharLimit: 24576,
  totalBlockCharLimit: 96000,
  resumeCharLimit: 800,
  boards: [],
  pha: {
    enabled: false,
    baseUrl: "",
    workspace: "",
    tokenSecretKey: "taskdoc-pha-token"
  }
};

const PROFILES: ValidationProfile[] = [
  "bug",
  "feature",
  "research",
  "migration",
  "configuration",
  "maintenance",
  "other"
];

export class TaskDocSettingTab extends PluginSettingTab {
  constructor(private readonly plugin: TaskDocPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h1", { text: "TaskDoc MCP" });

    this.renderMcp();
    this.renderBoards();
    this.renderDocuments();
    this.renderPha();
    this.renderDiagnostics();
  }

  private renderMcp(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "MCP server" });

    new Setting(containerEl)
      .setName("Enable MCP server")
      .setDesc("Listen on 127.0.0.1 only. Restart applies changed network settings.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.mcpEnabled).onChange(async (value) => {
        this.plugin.settings.mcpEnabled = value;
        await this.plugin.saveSettings();
        await this.plugin.restartMcp();
        this.display();
      }));

    new Setting(containerEl)
      .setName("Port")
      .setDesc("One vault needs one stable port.")
      .addText((text) => text
        .setPlaceholder("27124")
        .setValue(String(this.plugin.settings.mcpPort))
        .onChange(async (value) => {
          const port = Number(value);
          if (Number.isInteger(port) && port >= 1024 && port <= 65535) {
            this.plugin.settings.mcpPort = port;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName("Allowed origins")
      .setDesc("Comma-separated browser origins. Empty is safest for native MCP clients.")
      .addText((text) => text
        .setValue(this.plugin.settings.allowedOrigins.join(", "))
        .onChange(async (value) => {
          this.plugin.settings.allowedOrigins = value.split(",").map((entry) => entry.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    const running = this.plugin.mcpStatus();
    new Setting(containerEl)
      .setName("Connection")
      .setDesc(running.running ? `Running at ${running.endpoint}` : `Stopped${running.error ? `: ${running.error}` : ""}`)
      .addButton((button) => button.setButtonText("Restart").onClick(async () => {
        await this.plugin.restartMcp();
        this.display();
      }))
      .addButton((button) => button.setButtonText("Copy client config").onClick(async () => {
        await navigator.clipboard.writeText(await this.plugin.clientConfig());
        new Notice("TaskDoc MCP client configuration copied.");
      }))
      .addButton((button) => button.setWarning().setButtonText("Regenerate token").onClick(async () => {
        await this.plugin.regenerateMcpToken();
        await this.plugin.restartMcp();
        new Notice("MCP token regenerated. Update every client configuration.");
      }));
  }

  private renderBoards(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "Boards" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "One board is one project. Columns are task types; card checkboxes are completion state."
    });

    for (const board of this.plugin.settings.boards) {
      const wrapper = containerEl.createDiv({ cls: "taskdoc-mcp-board-row" });
      wrapper.createEl("h3", { text: board.name || "Unnamed board" });
      this.renderBoard(wrapper, board);
    }

    new Setting(containerEl)
      .setName("Add board")
      .setDesc("Adds a blank registration. Enter the board path, then scan its columns.")
      .addButton((button) => button.setCta().setButtonText("Add").onClick(async () => {
        this.plugin.settings.boards.push({
          id: newId(),
          name: "New project",
          projectId: `project-${this.plugin.settings.boards.length + 1}`,
          file: "",
          tasksFolder: "Tasks",
          autoConvertCards: false,
          columns: []
        });
        await this.plugin.saveSettings();
        this.display();
      }));
  }

  private renderBoard(container: HTMLElement, board: BoardConfig): void {
    new Setting(container).setName("Project name").addText((text) => text.setValue(board.name).onChange(async (value) => {
      board.name = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(container).setName("Project ID").addText((text) => text.setValue(board.projectId).onChange(async (value) => {
      board.projectId = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(container).setName("Board file").setDesc("Vault-relative Markdown path.").addText((text) => text.setValue(board.file).onChange(async (value) => {
      board.file = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(container).setName("Task folder").setDesc("Vault-relative folder for linked task documents.").addText((text) => text.setValue(board.tasksFolder).onChange(async (value) => {
      board.tasksFolder = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(container)
      .setName("Columns")
      .setDesc(board.columns.length === 0 ? "No columns scanned." : `${board.columns.length} mapped columns.`)
      .addButton((button) => button.setButtonText("Scan headings").onClick(async () => {
        try {
          await this.plugin.refreshBoardColumns(board.id);
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        }
      }))
      .addButton((button) => button.setWarning().setButtonText("Remove board").onClick(async () => {
        this.plugin.settings.boards = this.plugin.settings.boards.filter((candidate) => candidate.id !== board.id);
        await this.plugin.saveSettings();
        this.display();
      }));

    for (const column of board.columns) {
      new Setting(container)
        .setName(column.heading)
        .setDesc(`column_id: ${column.id}`)
        .addText((text) => text.setPlaceholder("type-id").setValue(column.typeId).onChange(async (value) => {
          column.typeId = value.trim();
          await this.plugin.saveSettings();
        }))
        .addDropdown((dropdown) => {
          for (const profile of PROFILES) dropdown.addOption(profile, profile);
          dropdown.setValue(column.profile).onChange(async (value) => {
            column.profile = value as ValidationProfile;
            await this.plugin.saveSettings();
          });
        });
    }
  }

  private renderDocuments(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "Task documents" });
    new Setting(containerEl).setName("Strict quality mode").addToggle((toggle) => toggle.setValue(this.plugin.settings.strictQuality).onChange(async (value) => {
      this.plugin.settings.strictQuality = value;
      await this.plugin.saveSettings();
    }));
    this.numberSetting("Core character limit", "Long tables and diagrams belong in rich blocks.", "coreCharLimit", 500, 20000);
    this.numberSetting("Rich block character limit", "Per block. Defaults to the original 24k capability.", "blockCharLimit", 1000, 200000);
    this.numberSetting("Total rich block limit", "Per checkpoint.", "totalBlockCharLimit", 1000, 1000000);
    this.numberSetting("Resume capsule limit", "Mutable handoff state, not permanent history.", "resumeCharLimit", 200, 5000);
  }

  private numberSetting(
    name: string,
    description: string,
    key: "coreCharLimit" | "blockCharLimit" | "totalBlockCharLimit" | "resumeCharLimit",
    min: number,
    max: number
  ): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addText((text) => text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
        this.plugin.settings[key] = parsed;
        await this.plugin.saveSettings();
      }
    }));
  }

  private renderPha(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "PHA sync" });
    containerEl.createEl("p", {
      cls: "taskdoc-mcp-warning",
      text: "Adapter boundary is included in this alpha, but remote sync is disabled until the concrete PHA comment API is known."
    });
    new Setting(containerEl).setName("Base URL").addText((text) => text.setValue(this.plugin.settings.pha.baseUrl).onChange(async (value) => {
      this.plugin.settings.pha.baseUrl = value.trim();
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Workspace / project").addText((text) => text.setValue(this.plugin.settings.pha.workspace).onChange(async (value) => {
      this.plugin.settings.pha.workspace = value.trim();
      await this.plugin.saveSettings();
    }));
    const hasPhaToken = Boolean(this.app.secretStorage.getSecret(this.plugin.settings.pha.tokenSecretKey));
    new Setting(containerEl)
      .setName("PHA token")
      .setDesc(hasPhaToken ? "A token is stored securely. Enter a value to replace it." : "No token stored.")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(hasPhaToken ? "Stored" : "Paste token").onChange((value) => {
          if (value) this.app.secretStorage.setSecret(this.plugin.settings.pha.tokenSecretKey, value);
        });
      })
      .addButton((button) => button.setWarning().setButtonText("Clear").onClick(() => {
        this.app.secretStorage.setSecret(this.plugin.settings.pha.tokenSecretKey, "");
        this.display();
      }));
  }

  private renderDiagnostics(): void {
    const { containerEl } = this;
    containerEl.createEl("h2", { text: "Diagnostics" });
    const status = this.plugin.mcpStatus();
    containerEl.createEl("p", {
      cls: `taskdoc-mcp-status${status.running ? " is-running" : ""}`,
      text: status.running ? `MCP running: ${status.endpoint}` : `MCP stopped${status.error ? ` — ${status.error}` : ""}`
    });
    containerEl.createEl("p", {
      cls: "taskdoc-mcp-status",
      text: `${this.plugin.settings.boards.length} board(s) registered. PHA adapter: unavailable in this alpha.`
    });
  }
}
