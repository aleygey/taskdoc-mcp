import { Modal, Notice, Setting, type App } from "obsidian";
import type { TaskService } from "../service.js";
import type { BoardConfig, TaskDocument, CheckpointCore } from "../types.js";
import { upgradeTask } from "../core/task.js";
import { newId } from "../util/id.js";
import {
  taskUpdateInputSchema,
  taskCreateInputSchema,
  taskCheckpointCommitInputSchema,
  taskFinalizeInputSchema,
} from "../mcp/schemas.js";

export class TaskEditorModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private original: TaskDocument,
    private board?: BoardConfig,
  ) {
    super(app);
  }
  override onOpen(): void {
    const task = upgradeTask(this.original);
    const el = this.contentEl;
    el.createEl("h2", { text: "编辑任务" });
    el.createEl("p", {
      text: "修改目标或验收条件会重置相关验证状态。文件名保持稳定，卡片标题会同步更新。",
    });
    let title = task.title,
      objective = task.objective,
      reason = "",
      state = task.state,
      archived = task.archived ?? false;
    let columnId = task.columnId,
      typeId = task.typeId;
    if (this.board?.columnMode === "state")
      new Setting(el).setName("任务类型").addDropdown((d) => {
        for (const t of this.board?.taskTypes ?? []) d.addOption(t.id, t.name);
        d.setValue(typeId ?? "other").onChange((v) => {
          typeId = v;
        });
      });
    else if (this.board)
      new Setting(el).setName("任务分类列").addDropdown((d) => {
        for (const c of this.board?.columns ?? []) d.addOption(c.id, c.heading);
        d.setValue(columnId).onChange((v) => {
          columnId = v;
        });
      });
    let blocker = task.blocker ?? "",
      unblock = task.unblockCondition ?? "";
    new Setting(el).setName("标题").addText((t) =>
      t.setValue(title).onChange((v) => {
        title = v;
      }),
    );
    new Setting(el).setName("目标").addTextArea((t) =>
      t.setValue(objective).onChange((v) => {
        objective = v;
      }),
    );
    new Setting(el)
      .setName("执行状态")
      .setDesc("完成和取消请使用任务验收窗口；重新打开可选择进行中。")
      .addDropdown((d) => {
        d.addOption("planned", "待开始")
          .addOption("active", "进行中")
          .addOption("blocked", "受阻")
          .addOption("done", "已完成")
          .addOption("cancelled", "已取消");
        d.setValue(state).onChange((v) => {
          state = v as typeof state;
        });
      });
    new Setting(el).setName("阻塞原因").addText((t) =>
      t.setValue(blocker).onChange((v) => {
        blocker = v;
      }),
    );
    new Setting(el).setName("解除条件").addText((t) =>
      t.setValue(unblock).onChange((v) => {
        unblock = v;
      }),
    );
    new Setting(el)
      .setName("归档")
      .setDesc("已完成或已取消的任务可收起到看板归档区。")
      .addToggle((t) =>
        t.setValue(archived).onChange((v) => {
          archived = v;
        }),
      );
    el.createEl("h3", { text: "验收条件" });
    const items = (task.acceptanceItems ?? []).map((a) => ({
      id: a.id,
      statement: a.statement,
      removed: false,
    }));
    const renderItem = (item: (typeof items)[number]) => {
      const row = new Setting(el).setName(item.id);
      row.addTextArea((t) =>
        t.setValue(item.statement).onChange((v) => {
          item.statement = v;
        }),
      );
      row.addToggle((t) =>
        t
          .setValue(true)
          .setTooltip("保留此验收项")
          .onChange((v) => {
            item.removed = !v;
          }),
      );
    };
    items.forEach(renderItem);
    new Setting(el).setName("新增验收条件").addButton((b) =>
      b.setButtonText("添加").onClick(() => {
        const item = { id: `AC-${newId()}`, statement: "", removed: false };
        items.push(item);
        renderItem(item);
      }),
    );
    new Setting(el).setName("变更原因").addTextArea((t) =>
      t.setPlaceholder("说明纠正或范围调整的原因").onChange((v) => {
        reason = v;
      }),
    );
    new Setting(el).addButton((b) =>
      b
        .setCta()
        .setButtonText("保存修改")
        .onClick(async () => {
          b.setDisabled(true);
          try {
            const input = taskUpdateInputSchema.parse({
              schema_version: 2,
              request_id: newId(),
              task_id: task.taskId,
              expected_revision: task.revision,
              reason,
              ...(title !== task.title ? { title } : {}),
              ...(objective !== task.objective ? { objective } : {}),
              ...(JSON.stringify(
                items
                  .filter((i) => !i.removed)
                  .map(({ id, statement }) => ({ id, statement })),
              ) !==
              JSON.stringify(
                (task.acceptanceItems ?? []).map(({ id, statement }) => ({
                  id,
                  statement,
                })),
              )
                ? {
                    acceptance: items
                      .filter((i) => !i.removed)
                      .map(({ id, statement }) => ({ id, statement })),
                  }
                : {}),
              ...(state !== task.state ? { state } : {}),
              archived:
                state !== task.state &&
                ["done", "cancelled"].includes(task.state)
                  ? false
                  : archived,
              ...(columnId !== task.columnId ? { column_id: columnId } : {}),
              ...(typeId !== task.typeId ? { type_id: typeId } : {}),
              ...(state === "blocked"
                ? { blocker, unblock_condition: unblock }
                : {}),
            });
            await this.service.update(input);
            new Notice("任务与看板已更新。");
            this.close();
          } catch (error) {
            showError(error);
            b.setDisabled(false);
          }
        }),
    );
  }
}

export class TaskAcceptanceModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private original: TaskDocument,
  ) {
    super(app);
  }
  override onOpen(): void {
    const task = upgradeTask(this.original),
      el = this.contentEl;
    el.createEl("h2", { text: "验收或取消任务" });
    let outcome = "",
      status: "done" | "cancelled" = "done",
      archived = false;
    const assessments = (task.acceptanceItems ?? []).map((a) => ({
      id: a.id,
      status: a.status,
      evidence_refs: [...(a.evidenceRefs ?? [])],
      waiver_reason: a.waiverReason ?? "",
    }));
    el.createEl("p", {
      text: "每条已验证的条件须关联证据；豁免须说明原因。引用列表中的证据标识，多个用逗号分隔。",
    });
    const evidence = [...(task.evidence ?? [])];
    const evidenceEl = el.createDiv();
    const refreshEvidence = () => {
      evidenceEl.empty();
      for (const e of evidence)
        evidenceEl.createEl("p", {
          text: `${e.id} — ${e.statement}${e.ref ? ` (${e.ref})` : ""}`,
        });
      for (const cp of task.checkpoints.filter(
        (c) => c.status !== "cancelled" && c.status !== "superseded",
      ))
        for (const e of cp.outcome?.evidence ?? [])
          evidenceEl.createEl("p", {
            text: `${cp.id}/${e.id} — ${e.statement}`,
          });
    };
    refreshEvidence();
    let evidenceStatement = "",
      evidenceRef = "",
      evidenceType:
        | "test"
        | "artifact"
        | "observation"
        | "source"
        | "user_acceptance" = "observation";
    new Setting(el).setName("新增证据").addTextArea((t) =>
      t.setPlaceholder("实际观察、测试结果或交付物").onChange((v) => {
        evidenceStatement = v;
      }),
    );
    new Setting(el).setName("证据类型").addDropdown((d) =>
      d
        .addOptions({
          test: "测试",
          artifact: "产物",
          observation: "观察",
          source: "来源",
          user_acceptance: "用户验收",
        })
        .setValue(evidenceType)
        .onChange((v) => {
          evidenceType = v as typeof evidenceType;
        }),
    );
    new Setting(el)
      .setName("证据引用")
      .addText((t) =>
        t.setPlaceholder("文件、测试名或 URL").onChange((v) => {
          evidenceRef = v;
        }),
      )
      .addButton((b) =>
        b.setButtonText("加入证据").onClick(() => {
          if (!evidenceStatement.trim()) return;
          evidence.push({
            id: nextEvidenceId(evidence.map((e) => e.id)),
            type: evidenceType,
            statement: evidenceStatement,
            ...(evidenceRef ? { ref: evidenceRef } : {}),
          });
          refreshEvidence();
        }),
      );
    for (const a of assessments) {
      const statement =
        task.acceptanceItems?.find((i) => i.id === a.id)?.statement ?? a.id;
      new Setting(el).setName(statement).addDropdown((d) =>
        d
          .addOptions({ pending: "待验证", verified: "已验证", waived: "豁免" })
          .setValue(a.status)
          .onChange((v) => {
            a.status = v as typeof a.status;
          }),
      );
      new Setting(el)
        .setName("关联证据 / 豁免原因")
        .addText((t) =>
          t
            .setValue(a.evidence_refs.join(", "))
            .setPlaceholder("证据标识")
            .onChange((v) => {
              a.evidence_refs = v
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean);
            }),
        )
        .addText((t) =>
          t
            .setValue(a.waiver_reason)
            .setPlaceholder("选择豁免时必填")
            .onChange((v) => {
              a.waiver_reason = v;
            }),
        );
    }
    new Setting(el).setName("结束方式").addDropdown((d) =>
      d
        .addOptions({ done: "验收完成", cancelled: "取消任务" })
        .onChange((v) => {
          status = v as typeof status;
        }),
    );
    new Setting(el).setName("最终结果 / 取消原因与处置").addTextArea((t) =>
      t.onChange((v) => {
        outcome = v;
      }),
    );
    new Setting(el).setName("同时归档").addToggle((t) =>
      t.onChange((v) => {
        archived = v;
      }),
    );
    new Setting(el).addButton((b) =>
      b
        .setCta()
        .setButtonText("保存验收结果")
        .onClick(async () => {
          b.setDisabled(true);
          try {
            await this.service.finalize(
              taskFinalizeInputSchema.parse({
                schema_version: 2,
                request_id: newId(),
                task_id: task.taskId,
                expected_revision: task.revision,
                status,
                archived,
                final_outcome: outcome,
                evidence,
                remaining: [],
                acceptance: assessments.map((a) => ({
                  id: a.id,
                  status: a.status,
                  evidence_refs: a.evidence_refs,
                  ...(a.waiver_reason
                    ? { waiver_reason: a.waiver_reason }
                    : {}),
                })),
              }),
            );
            new Notice(
              status === "done" ? "任务已完成。" : "任务已取消，已有记录保留。",
            );
            this.close();
          } catch (error) {
            showError(error);
            b.setDisabled(false);
          }
        }),
    );
  }
}

export class ReconcileModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private task: TaskDocument,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.contentEl.createEl("h2", { text: "协调看板与任务" });
    new Setting(this.contentEl).setName("以哪一边为准").addDropdown((d) =>
      d
        .addOptions({
          document_to_board: "以任务文档为准",
          board_to_document: "采用看板变更",
        })
        .onChange((v) => {
          void this.preview(v as "document_to_board" | "board_to_document");
        }),
    );
    void this.preview("document_to_board");
  }
  private region: HTMLElement | undefined;
  private serial = 0;
  private async preview(direction: "document_to_board" | "board_to_document") {
    const serial = ++this.serial;
    this.region?.remove();
    const region = this.contentEl.createDiv();
    this.region = region;
    try {
      const plan = await this.service.reconcile({
        task_id: this.task.taskId,
        mode: "preview",
        direction,
      });
      if (serial !== this.serial) return;
      for (const change of plan.changes) region.createEl("p", { text: change });
      if (!plan.changes.length)
        region.createEl("p", { text: "看板与任务一致。" });
      if (plan.can_apply && plan.changes.length)
        new Setting(region).addButton((b) =>
          b
            .setCta()
            .setButtonText("应用以上变更")
            .onClick(async () => {
              b.setDisabled(true);
              try {
                await this.service.reconcile({
                  task_id: this.task.taskId,
                  mode: "apply",
                  direction,
                  request_id: newId(),
                  expected_revision: plan.document_revision,
                  expected_board_revision: plan.board_revision,
                });
                new Notice("协调完成。");
                this.close();
              } catch (error) {
                showError(error);
                b.setDisabled(false);
              }
            }),
        );
    } catch (error) {
      showError(error);
    }
  }
}

export class RecoveryModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private path: string,
  ) {
    super(app);
  }
  override onOpen(): void {
    void this.preview();
  }
  private async preview() {
    try {
      const preview = await this.service.previewDocumentRecovery(this.path);
      this.contentEl.createEl("h2", { text: "恢复受管文档" });
      this.contentEl.createEl("p", {
        text: "以下操作会把当前文件完整备份到 TaskDoc Backups，再按保存的结构化内容重建正文。人工改写的正文不会自动导入，请从备份核对后使用任务编辑功能修正。",
      });
      for (const [title, content] of [
        ["当前文件", preview.content],
        ["恢复后的内容", preview.recovered],
      ]) {
        const details = this.contentEl.createEl("details");
        details.createEl("summary", { text: title! });
        details.createEl("pre", { text: content!, cls: "taskdoc-mcp-preview" });
      }
      new Setting(this.contentEl).addButton((b) =>
        b
          .setWarning()
          .setButtonText("备份并恢复以上内容")
          .onClick(async () => {
            b.setDisabled(true);
            try {
              const backup = await this.service.restoreManagedDocument(
                this.path,
                preview.hash,
                newId(),
              );
              new Notice(`已恢复，人工修改保存在 ${backup}`);
              this.close();
            } catch (error) {
              showError(error);
              b.setDisabled(false);
            }
          }),
      );
    } catch (error) {
      showError(error);
      this.close();
    }
  }
}

export class DiagnosticsModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private boards: BoardConfig[],
  ) {
    super(app);
  }
  override onOpen(): void {
    void this.render();
  }
  private async render() {
    const el = this.contentEl;
    el.empty();
    el.createEl("h2", { text: "任务诊断" });
    try {
      const pending = await this.service.pendingRecovery();
      if (pending) {
        el.createEl("p", {
          text: `有一次未完成的写入，涉及 ${pending.files.length} 个文件。恢复会回滚该次写入；若检测到后续人工修改，会停止并保留文件。`,
        });
        pending.files.forEach((f) => el.createEl("p", { text: f.path }));
        new Setting(el).addButton((b) =>
          b
            .setWarning()
            .setButtonText("恢复中断的写入")
            .onClick(async () => {
              try {
                await this.service.recoverPendingWrites();
                await this.render();
              } catch (error) {
                showError(error);
              }
            }),
        );
      }
      for (const board of this.boards) {
        el.createEl("h3", { text: board.name });
        try {
          const query = await this.service.query({
            board_id: board.id,
            limit: 100,
          });
          for (const issue of query.diagnostics ?? [])
            el.createEl("p", { text: `${issue.path}：${issue.message}` });
          if (query.diagnostics_truncated)
            el.createEl("p", {
              text: `共 ${query.diagnostics_total} 项问题，本次显示前 50 项；修复后重新打开诊断。`,
            });
          const report = await this.service.boardDiagnostics(board.id);
          for (const heading of report.unresolvedColumns)
            el.createEl("p", {
              text: `未匹配列：${heading}，请在设置中重新关联标题。`,
            });
          for (const issue of report.orphan)
            el.createEl("p", { text: `缺少卡片：${issue.taskPath}` });
          if (report.healthy && !query.diagnostics?.length)
            el.createEl("p", { text: "未发现看板链接或状态冲突。" });
          el.createEl("p", {
            text: "打开有问题的任务文档，执行“协调当前任务的看板”或“恢复当前受管文档”。",
          });
        } catch (error) {
          el.createEl("p", {
            text: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      showError(error);
    }
  }
}

function showError(error: unknown): void {
  new Notice(error instanceof Error ? error.message : String(error), 10000);
}

export class TaskCreateModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private boards: BoardConfig[],
  ) {
    super(app);
  }
  override onOpen(): void {
    const el = this.contentEl;
    el.createEl("h2", { text: "创建任务" });
    if (!this.boards.length) {
      el.createEl("p", { text: "请先在 TaskDoc 设置中登记看板并扫描列。" });
      return;
    }
    let boardId = this.boards[0]!.id,
      columnId = this.boards[0]!.columns[0]?.id ?? "",
      title = "",
      objective = "",
      acceptance = "",
      typeId = "";
    const columnRegion = el.createDiv();
    const columns = () => {
      columnRegion.empty();
      const board = this.boards.find((b) => b.id === boardId)!;
      columnId = board.columns[0]?.id ?? "";
      typeId = board.taskTypes?.[0]?.id ?? "other";
      if (board.columnMode === "state")
        new Setting(columnRegion).setName("任务类型").addDropdown((d) => {
          for (const t of board.taskTypes ?? [{ id: "other", name: "其他" }])
            d.addOption(t.id, t.name);
          d.setValue(typeId).onChange((v) => {
            typeId = v;
          });
        });
      if (!columnId) {
        columnRegion.createEl("p", {
          text: "此看板还没有配置列，请先在设置中扫描二级标题。",
        });
        return;
      }
      new Setting(columnRegion).setName("看板列").addDropdown((d) => {
        for (const c of board.columns) d.addOption(c.id, c.heading);
        d.setValue(columnId).onChange((v) => {
          columnId = v;
        });
      });
    };
    new Setting(el).setName("项目看板").addDropdown((d) => {
      for (const b of this.boards) d.addOption(b.id, b.name);
      d.setValue(boardId).onChange((v) => {
        boardId = v;
        columns();
      });
    });
    columns();
    new Setting(el).setName("标题").addText((t) =>
      t.onChange((v) => {
        title = v;
      }),
    );
    new Setting(el).setName("目标").addTextArea((t) =>
      t.onChange((v) => {
        objective = v;
      }),
    );
    new Setting(el)
      .setName("验收条件")
      .setDesc(
        "每行一项，描述怎样算完成。简单任务可以直接验收，无需创建子任务。",
      )
      .addTextArea((t) =>
        t.onChange((v) => {
          acceptance = v;
        }),
      );
    new Setting(el).addButton((b) =>
      b
        .setCta()
        .setButtonText("创建并打开")
        .onClick(async () => {
          b.setDisabled(true);
          try {
            const result = await this.service.create(
              taskCreateInputSchema.parse({
                schema_version: 2,
                request_id: newId(),
                board_id: boardId,
                column_id: columnId,
                ...(this.boards.find((board) => board.id === boardId)
                  ?.columnMode === "state"
                  ? { type_id: typeId }
                  : {}),
                title,
                objective,
                acceptance: acceptance
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              }),
            );
            await this.app.workspace.openLinkText(result.task.path, "", false);
            this.close();
          } catch (error) {
            showError(error);
            b.setDisabled(false);
          }
        }),
    );
  }
}

export class CheckpointListModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private task: TaskDocument,
  ) {
    super(app);
  }
  override onOpen(): void {
    const el = this.contentEl;
    el.createEl("h2", { text: "编辑子任务" });
    for (const cp of this.task.checkpoints)
      new Setting(el)
        .setName(cp.title)
        .setDesc(cp.status)
        .addButton((b) =>
          b.setButtonText("编辑").onClick(() => {
            new CheckpointEditorModal(
              this.app,
              this.service,
              this.task,
              cp,
            ).open();
            this.close();
          }),
        );
    new Setting(el).addButton((b) =>
      b.setButtonText("新增可独立验收的子任务").onClick(() => {
        new CheckpointEditorModal(this.app, this.service, this.task).open();
        this.close();
      }),
    );
  }
}

class CheckpointEditorModal extends Modal {
  constructor(
    app: App,
    private service: TaskService,
    private task: TaskDocument,
    private original?: CheckpointCore,
  ) {
    super(app);
  }
  override onOpen(): void {
    const cp: CheckpointCore = structuredClone(
      this.original ?? {
        id: newId(),
        revision: 0,
        title: "",
        kind: "operation",
        status: "active",
        objective: {
          statement: "",
          acceptance: [{ id: "AC-1", statement: "", status: "pending" }],
        },
        blocks: [],
      },
    );
    const el = this.contentEl;
    el.createEl("h2", {
      text: this.original ? "纠正子任务记录" : "新增子任务",
    });
    new Setting(el).setName("标题").addText((t) =>
      t.setValue(cp.title).onChange((v) => {
        cp.title = v;
      }),
    );
    new Setting(el).setName("目标").addTextArea((t) =>
      t.setValue(cp.objective.statement).onChange((v) => {
        cp.objective.statement = v;
      }),
    );
    new Setting(el).setName("状态").addDropdown((d) =>
      d
        .addOptions({
          active: "进行中",
          blocked: "受阻",
          done: "已完成",
          cancelled: "已取消",
          superseded: "被替代",
        })
        .setValue(cp.status)
        .onChange((v) => {
          cp.status = v as typeof cp.status;
        }),
    );
    new Setting(el).setName("替代此子任务的记录").addDropdown((d) => {
      d.addOption("", "选择替代记录");
      for (const other of this.task.checkpoints.filter((c) => c.id !== cp.id))
        d.addOption(other.id, other.title);
      d.setValue(cp.supersededBy ?? "").onChange((v) => {
        if (v) cp.supersededBy = v;
        else delete cp.supersededBy;
      });
    });
    new Setting(el).setName("阻塞原因").addText((t) =>
      t.setValue(cp.blocker ?? "").onChange((v) => {
        cp.blocker = v;
      }),
    );
    new Setting(el).setName("解除条件").addText((t) =>
      t.setValue(cp.unblockCondition ?? "").onChange((v) => {
        cp.unblockCondition = v;
      }),
    );
    for (const item of cp.objective.acceptance) {
      new Setting(el)
        .setName("验收条件")
        .addTextArea((t) =>
          t.setValue(item.statement).onChange((v) => {
            item.statement = v;
          }),
        )
        .addDropdown((d) =>
          d
            .addOptions({
              pending: "待验证",
              verified: "已验证",
              waived: "豁免",
            })
            .setValue(item.status)
            .onChange((v) => {
              item.status = v as typeof item.status;
            }),
        );
      new Setting(el).setName("豁免原因").addText((t) =>
        t.setValue(item.waiverReason ?? "").onChange((v) => {
          if (v) item.waiverReason = v;
          else delete item.waiverReason;
        }),
      );
      new Setting(el).setName("关联证据").addText((t) =>
        t.setValue(item.evidenceRefs?.join(",") ?? "").onChange((v) => {
          item.evidenceRefs = v
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean);
        }),
      );
    }
    cp.judgment ??= {};
    for (const fact of cp.judgment.facts ?? [])
      new Setting(el)
        .setName("已确认事实")
        .addTextArea((t) =>
          t.setValue(fact.fact).onChange((v) => {
            fact.fact = v;
          }),
        )
        .addTextArea((t) =>
          t.setValue(fact.relevance).onChange((v) => {
            fact.relevance = v;
          }),
        );
    for (const constraint of cp.judgment.constraints ?? []) {
      new Setting(el).setName("不采用的方案").addTextArea((t) =>
        t.setValue(constraint.rejectedOption).onChange((v) => {
          constraint.rejectedOption = v;
        }),
      );
      new Setting(el).setName("已验证原因").addTextArea((t) =>
        t.setValue(constraint.verifiedReason).onChange((v) => {
          constraint.verifiedReason = v;
        }),
      );
      new Setting(el).setName("适用范围").addTextArea((t) =>
        t.setValue(constraint.scope).onChange((v) => {
          constraint.scope = v;
        }),
      );
      new Setting(el).setName("影响").addTextArea((t) =>
        t.setValue(constraint.impact).onChange((v) => {
          constraint.impact = v;
        }),
      );
    }
    new Setting(el)
      .setName("持续有效的决定")
      .setDesc("每行一项；会进入后续接续信息。")
      .addTextArea((t) =>
        t.setValue(cp.judgment?.decisions?.join("\n") ?? "").onChange((v) => {
          cp.judgment!.decisions = v.split("\n").filter((s) => s.trim());
        }),
      );
    let summary = cp.outcome?.summary ?? "",
      newEvidence = "",
      cancellationReason = cp.cancellation?.reason ?? "",
      disposition = cp.cancellation?.disposition ?? "";
    new Setting(el).setName("实际结果").addTextArea((t) =>
      t.setValue(summary).onChange((v) => {
        summary = v;
      }),
    );
    for (const e of cp.outcome?.evidence ?? [])
      new Setting(el)
        .setName(`证据 ${e.id}`)
        .addTextArea((t) =>
          t.setValue(e.statement).onChange((v) => {
            e.statement = v;
          }),
        )
        .addText((t) =>
          t.setValue(e.ref ?? "").onChange((v) => {
            if (v) e.ref = v;
            else delete e.ref;
          }),
        );
    new Setting(el)
      .setName("新增观察证据")
      .setDesc("保存后标识为 E-observation，可在本子任务验收中引用。")
      .addTextArea((t) =>
        t.onChange((v) => {
          newEvidence = v;
        }),
      );
    new Setting(el).setName("取消原因").addTextArea((t) =>
      t.setValue(cancellationReason).onChange((v) => {
        cancellationReason = v;
      }),
    );
    new Setting(el).setName("已有产出处置").addTextArea((t) =>
      t.setValue(disposition).onChange((v) => {
        disposition = v;
      }),
    );
    new Setting(el).addButton((b) =>
      b
        .setCta()
        .setButtonText("保存子任务")
        .onClick(async () => {
          b.setDisabled(true);
          try {
            if (summary)
              cp.outcome = {
                ...cp.outcome,
                summary,
                evidence: cp.outcome?.evidence ?? [],
              };
            if (newEvidence) {
              cp.outcome ??= { summary, evidence: [] };
              cp.outcome.evidence = cp.outcome.evidence.filter(
                (e) => e.id !== "E-observation",
              );
              cp.outcome.evidence.push({
                id: "E-observation",
                type: "observation",
                statement: newEvidence,
              });
            }
            if (cp.status !== "blocked") {
              delete cp.blocker;
              delete cp.unblockCondition;
            }
            if (cp.status === "cancelled")
              cp.cancellation = { reason: cancellationReason, disposition };
            else delete cp.cancellation;
            if (cp.status !== "superseded") delete cp.supersededBy;
            const { id, revision, blocks: _blocks, ...core } = cp;
            const input = taskCheckpointCommitInputSchema.parse({
              schema_version: 2,
              request_id: newId(),
              task_id: this.task.taskId,
              ...(this.original ? { checkpoint_id: id } : {}),
              expected_revision: revision,
              trigger: this.original ? "correction" : "subtask_started",
              core: snakeKeys(core),
            });
            await this.service.checkpointCommit(input);
            new Notice("子任务记录已保存。");
            this.close();
          } catch (error) {
            showError(error);
            b.setDisabled(false);
          }
        }),
    );
  }
}

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
        snakeKeys(entry),
      ]),
    );
  return value;
}

function nextEvidenceId(ids: string[]): string {
  let i = 1;
  while (ids.includes(`E-${i}`)) i++;
  return `E-${i}`;
}
