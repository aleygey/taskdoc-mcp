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
          "Start existing work with task_resume and use only board_id/column_id values returned by task_catalog. " +
          "A checkpoint is one independently verifiable subtask, never a session, temporary question, conversation, or trial log. " +
          "Keep only durable objectives, confirmed facts, final decisions, verified outcomes, evidence, and residual risks. " +
          "Record a failed approach only after its reason is verified, as a scoped constraint with evidence and a reconsideration condition. " +
          "Replace the same checkpoint as facts mature; do not append chronology. Put durable tables, Mermaid, specifications, and checklists in typed rich blocks. " +
          "Use task_handoff only for the mutable current focus, last verified point, one next action, blockers, and working artifacts.",
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
        title: "Task catalog",
        description: "List configured project boards and their existing column/type IDs. This operation is read-only.",
        inputSchema: taskCatalogInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_catalog", () => this.api.catalog(input)),
    );

    this.sdk.registerTool(
      "task_query",
      {
        title: "Query tasks",
        description: "Query linked Kanban cards by project board, existing column/type, card state, or title.",
        inputSchema: taskQueryInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_query", () => this.api.query(input)),
    );

    this.sdk.registerTool(
      "task_resume",
      {
        title: "Resume task",
        description: "Return a bounded cross-session recovery view with active core, handoff capsule, and rich-block manifests only.",
        inputSchema: taskResumeInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_resume", () => this.api.resume(input)),
    );

    this.sdk.registerTool(
      "task_read",
      {
        title: "Read task",
        description: "Read a task outline, one checkpoint, or one paginated rich block. Views must be selected explicitly.",
        inputSchema: taskReadInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: readOnlyAnnotations,
      },
      async (input) => this.invoke("task_read", () => this.api.read(input)),
    );

    this.sdk.registerTool(
      "task_create",
      {
        title: "Create task",
        description: "Create one task document and one linked card using existing board_id and column_id values from task_catalog.",
        inputSchema: taskCreateInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: createAnnotations,
      },
      async (input) => this.invoke("task_create", () => this.api.create(input)),
    );

    this.sdk.registerTool(
      "task_card_update",
      {
        title: "Update task card",
        description: "Move a card to an existing column/type or reopen a terminal task as active. Use task_finalize for done or archived state.",
        inputSchema: taskCardUpdateInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_card_update", () => this.api.cardUpdate(input)),
    );

    this.sdk.registerTool(
      "task_checkpoint_commit",
      {
        title: "Commit checkpoint core",
        description: "Create or fully replace one independently verifiable subtask checkpoint. Never use it for a session, temporary question, conversation, or failed-attempt chronology.",
        inputSchema: taskCheckpointCommitInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_checkpoint_commit", () => this.api.checkpointCommit(input)),
    );

    this.sdk.registerTool(
      "task_block_put",
      {
        title: "Put rich checkpoint block",
        description: "Create or fully replace one typed rich block for durable tables, Mermaid, domain checklists, specifications, or evidence. The configured plugin limit is enforced.",
        inputSchema: taskBlockPutInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_block_put", () => this.api.blockPut(input)),
    );

    this.sdk.registerTool(
      "task_handoff",
      {
        title: "Save task handoff",
        description: "Fully replace the bounded handoff capsule for an active checkpoint. It is not permanent checkpoint content.",
        inputSchema: taskHandoffInputSchema,
        outputSchema: toolResultOutputSchema,
        annotations: replacingMutationAnnotations,
      },
      async (input) => this.invoke("task_handoff", () => this.api.handoff(input)),
    );

    this.sdk.registerTool(
      "task_finalize",
      {
        title: "Finalize task",
        description: "Finalize or archive a task from committed checkpoint results and synchronize its card completion state.",
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
