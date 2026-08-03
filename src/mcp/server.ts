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

  constructor(private readonly api: TaskApi, options: McpServerOptions = {}) {
    this.sdk = new SdkMcpServer(
      {
        name: options.name ?? "taskdoc-mcp",
        version: options.version ?? "0.1.0",
      },
      {
        instructions:
          "已有任务必须先调用 task_resume；board_id/column_id 只能使用 task_catalog 返回的值。" +
          "一个 checkpoint 是一个可独立验收的子任务，不能按 session、临时提问、对话或尝试次数拆分。" +
          "永久正文只保留稳定目标、已确认事实、最终决定、已验证结果、证据和剩余风险。" +
          "失败方案只有在原因已验证且未来需要避免时，才记录为带适用范围、证据和重评条件的 constraint；普通试错不记录。" +
          "事实演进时完整替换同一 checkpoint，不追加时间线。长期表格、Mermaid、规格和清单放入有类型的 rich block。" +
          "task_handoff 只保存可覆盖的当前焦点、最后验证点、唯一下一动作、阻塞和工作文件，不作为永久历史。",
      },
    );
    this.registerTools();
  }

  async close(): Promise<void> {
    await this.sdk.close();
  }

  private registerTools(): void {
    this.sdk.registerTool(
      "task_catalog",
      {
        title: "任务目录（看板与列）",
        description: "列出插件中已登记的项目看板及现有列/任务类型 ID。只读；不会自动发现未登记的 Markdown 看板。",
        inputSchema: taskCatalogInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_catalog", () => this.api.catalog(input)),
    );

    this.sdk.registerTool(
      "task_query",
      {
        title: "查询任务",
        description: "按项目看板、现有列/任务类型、卡片状态或标题查询已链接的任务。",
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
        description: "返回有长度预算的接续视图：活动 checkpoint 核心、覆盖式接续卡和富内容清单；不加载大型内容正文。",
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
        description: "显式读取任务大纲、单个 checkpoint，或分页读取一个富内容块。",
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
        description: "使用 task_catalog 返回的现有 board_id/column_id，同时创建一个任务文档和一张链接看板卡片。",
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
        description: "把卡片移动到现有列/任务类型，或把终态任务重新打开为 active；完成或归档请使用 task_finalize。",
        inputSchema: taskCardUpdateInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_card_update", () => this.api.cardUpdate(input)),
    );

    this.sdk.registerTool(
      "task_checkpoint_commit",
      {
        title: "提交 Checkpoint 核心",
        description: "创建或完整替换一个可独立验收的子任务 checkpoint。不得用于记录 session、临时问题、对话或失败尝试时间线。",
        inputSchema: taskCheckpointCommitInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_checkpoint_commit", () => this.api.checkpointCommit(input)),
    );

    this.sdk.registerTool(
      "task_block_put",
      {
        title: "写入富内容块",
        description: "创建或完整替换一份有类型的长期资料，如表格、Mermaid、领域清单、规格或证据；实际大小受插件配置限制。",
        inputSchema: taskBlockPutInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_block_put", () => this.api.blockPut(input)),
    );

    this.sdk.registerTool(
      "task_handoff",
      {
        title: "保存任务接续点",
        description: "完整覆盖活动 checkpoint 的有界接续卡。它位于同一任务文档顶部，不是永久 checkpoint，也不会创建额外看板卡片。",
        inputSchema: taskHandoffInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_handoff", () => this.api.handoff(input)),
    );

    this.sdk.registerTool(
      "task_finalize",
      {
        title: "完成或归档任务",
        description: "根据已提交的 checkpoint 结果完成或归档任务，并同步看板卡片的勾选状态。",
        inputSchema: taskFinalizeInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_finalize", () => this.api.finalize(input)),
    );
  }

  private async invoke(name: string, operation: () => Promise<ObjectResult>): Promise<CallToolResult> {
    try {
      const data = await operation();
      const envelope = { ok: true, data: { ...data } };
      const serialized = JSON.stringify(envelope);
      const outputBytes = Buffer.byteLength(serialized, "utf8");
      if (outputBytes > MAX_TOOL_RESULT_BYTES) {
        throw new TaskApiError("INVALID_INPUT", "Tool result exceeds the output budget; request a narrower page or view", {
          action: "revise_input",
          details: { output_bytes: outputBytes, max_output_bytes: MAX_TOOL_RESULT_BYTES },
        });
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
