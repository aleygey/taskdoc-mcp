import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TaskApi } from "./api.js";
import { normalizeTaskApiError, TaskApiError } from "./api.js";
import {
  taskBlockPutInputSchema,
  taskCardUpdateInputSchema,
  taskCatalogInputSchema,
  taskCheckpointCommitInputSchema,
  taskCreateInputSchema,
  taskFinalizeInputSchema,
  taskHandoffInputSchema,
  taskQueryInputSchema,
  taskReadInputSchema,
  taskResumeInputSchema,
  taskUpdateInputSchema,
  taskReconcileInputSchema,
  toolResultOutputSchema,
} from "./schemas.js";

export type McpServerOptions = {
  name?: string;
  version?: string;
};

type ObjectResult = object;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const replacingMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export class McpServer {
  readonly sdk: SdkMcpServer;

  constructor(
    private readonly api: TaskApi,
    options: McpServerOptions = {},
  ) {
    this.sdk = new SdkMcpServer(
      {
        name: options.name ?? "taskdoc-mcp",
        version: options.version ?? "0.2.0",
      },
      {
        instructions:
          "已有任务必须先调用 task_resume；board_id/column_id 只能使用 task_catalog 返回的值。" +
          "简单任务无需 checkpoint；复杂任务按独立验收单元拆分。" +
          "接续时先检查 context_complete 与 handoff_status，继续读取遗漏的有效约束。" +
          "任务完成前必须将每条任务验收标记 verified 并关联证据，或写明豁免理由。" +
          "task_update 用于纠正标题、范围、验收或状态；归档与完成分开。" +
          "永久正文只保留稳定目标、已确认事实、最终决定、已验证结果、证据和剩余风险。" +
          "失败方案只有在原因已验证且未来需要避免时，才记录为带适用范围、证据和重评条件的 constraint；普通试错不记录。" +
          "事实演进时完整替换同一 checkpoint，不追加时间线。长期表格、Mermaid、规格和清单放入有类型的 rich block。" +
          "task_handoff 保存可覆盖的工作状态，允许 pending_checks 记录待验证事项和未确认假设。",
      },
    );
    this.registerTools();
  }

  async close(): Promise<void> {
    await this.sdk.close();
  }

  private registerTools(): void {
    this.sdk.registerTool(
      "task_update",
      {
        title: "编辑任务与验收",
        description:
          "纠正任务标题、目标、验收清单，记录证据并更新执行状态或归档；范围变更会重置相关验收状态，必须说明原因。",
        inputSchema: taskUpdateInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_update", () => this.api.update(input)),
    );
    this.sdk.registerTool(
      "task_reconcile",
      {
        title: "预览或协调看板冲突",
        description:
          "先 preview 查看文档与看板差异，再带两个预期版本 apply。采用勾选状态不能绕过完成验收。",
        inputSchema: taskReconcileInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) =>
        this.invoke("task_reconcile", () => this.api.reconcile(input)),
    );

    this.sdk.registerTool(
      "task_catalog",
      {
        title: "任务目录（看板与列）",
        description:
          "列出插件中已登记的项目看板及现有列/任务类型 ID。只读；不会自动发现未登记的 Markdown 看板。",
        inputSchema: taskCatalogInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) =>
        this.invoke("task_catalog", () => this.api.catalog(input)),
    );

    this.sdk.registerTool(
      "task_query",
      {
        title: "查询任务",
        description:
          "按项目看板、现有列/任务类型、卡片状态或标题查询已链接的任务。",
        inputSchema: taskQueryInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_query", () => this.api.query(input)),
    );

    this.sdk.registerTool(
      "task_resume",
      {
        title: "跨 Session 接续任务",
        description:
          "返回有长度预算的接续视图：活动 checkpoint 核心、覆盖式接续卡和富内容清单；不加载大型内容正文。",
        inputSchema: taskResumeInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_resume", () => this.api.resume(input)),
    );

    this.sdk.registerTool(
      "task_read",
      {
        title: "读取任务内容",
        description:
          "显式读取任务大纲、单个 checkpoint，或分页读取一个富内容块。",
        inputSchema: taskReadInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_read", () => this.api.read(input)),
    );

    this.sdk.registerTool(
      "task_create",
      {
        title: "创建任务",
        description:
          "使用 task_catalog 返回的现有 board_id/column_id，同时创建一个任务文档和一张链接看板卡片。",
        inputSchema: taskCreateInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: createAnnotations,
      },
      async (input) => this.invoke("task_create", () => this.api.create(input)),
    );

    this.sdk.registerTool(
      "task_card_update",
      {
        title: "更新任务卡片",
        description:
          "把卡片移动到现有列/任务类型，或把终态任务重新打开为 active；完成或归档请使用 task_finalize。",
        inputSchema: taskCardUpdateInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) =>
        this.invoke("task_card_update", () => this.api.cardUpdate(input)),
    );

    this.sdk.registerTool(
      "task_checkpoint_commit",
      {
        title: "提交 Checkpoint 核心",
        description:
          "创建或完整替换一个可独立验收的子任务 checkpoint。不得用于记录 session、临时问题、对话或失败尝试时间线。",
        inputSchema: taskCheckpointCommitInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) =>
        this.invoke("task_checkpoint_commit", () =>
          this.api.checkpointCommit(input),
        ),
    );

    this.sdk.registerTool(
      "task_block_put",
      {
        title: "写入富内容块",
        description:
          "创建或完整替换一份有类型的长期资料，如表格、Mermaid、领域清单、规格或证据；实际大小受插件配置限制。",
        inputSchema: taskBlockPutInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) =>
        this.invoke("task_block_put", () => this.api.blockPut(input)),
    );

    this.sdk.registerTool(
      "task_handoff",
      {
        title: "保存任务接续点",
        description:
          "保存任务整体或活动 checkpoint 的接续卡，允许记录已改未验证事项。它位于同一任务文档顶部，不是永久 checkpoint，也不会创建额外看板卡片。",
        inputSchema: taskHandoffInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) =>
        this.invoke("task_handoff", () => this.api.handoff(input)),
    );

    this.sdk.registerTool(
      "task_finalize",
      {
        title: "验收或取消任务",
        description:
          "逐项检查任务验收后完成任务，或说明原因取消任务；简单任务无需 checkpoint。归档由独立参数控制。",
        inputSchema: taskFinalizeInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) =>
        this.invoke("task_finalize", () => this.api.finalize(input)),
    );
  }

  private async invoke(
    name: string,
    operation: () => Promise<ObjectResult>,
  ): Promise<CallToolResult> {
    try {
      const data = (await operation()) as Record<string, unknown>;
      let envelope = { ok: true, data: { ...data } };
      let serialized = JSON.stringify(envelope);
      const outputBytes = Buffer.byteLength(serialized, "utf8");
      if (
        outputBytes > MAX_TOOL_RESULT_BYTES &&
        !["task_catalog", "task_query", "task_resume", "task_read"].includes(
          name,
        )
      ) {
        const task = data.task as { taskId?: string } | undefined;
        envelope = {
          ok: true,
          data: {
            committed: true,
            result_omitted: true,
            task_id: task?.taskId ?? data.task_id,
            document_revision: data.document_revision,
            checkpoint_revision: data.checkpoint_revision,
            next_action:
              "The write succeeded. Read task_read outline or checkpoint for details; do not repeat the write.",
          },
        };
        serialized = JSON.stringify(envelope);
      } else if (outputBytes > MAX_TOOL_RESULT_BYTES) {
        throw new TaskApiError(
          "INVALID_INPUT",
          "Tool result exceeds the output budget; request a narrower page or view",
          {
            action: "revise_input",
            details: {
              output_bytes: outputBytes,
              max_output_bytes: MAX_TOOL_RESULT_BYTES,
            },
          },
        );
      }
      return {
        content: [{ type: "text", text: serialized }],
        structuredContent: envelope,
      };
    } catch (error) {
      const structuredError = normalizeTaskApiError(error);
      const envelope = { ok: false, error: structuredError };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        structuredContent: envelope,
      };
    }
  }
}

export const mcpServerLimits = {
  maxToolResultBytes: MAX_TOOL_RESULT_BYTES,
} as const;
