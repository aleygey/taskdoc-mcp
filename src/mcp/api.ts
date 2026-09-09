import type {
  BoardConfig,
  BlockManifest,
  CheckpointCore,
  ResumeCapsule,
  TaskDocument,
  TaskState,
} from "../types.js";
import type {
  TaskBlockPutInput,
  TaskCardUpdateInput,
  TaskCatalogInput,
  TaskCheckpointCommitInput,
  TaskCreateInput,
  TaskFinalizeInput,
  TaskHandoffInput,
  TaskQueryInput,
  TaskReadInput,
  TaskResumeInput,
  TaskUpdateInput,
  TaskReconcileInput,
} from "./schemas.js";

export type PhaSyncState =
  | "synced"
  | "queued"
  | "failed"
  | "unbound"
  | "conflict";

export type MutationResultMeta = {
  document_revision: number;
  document_hash: string;
  pha_sync: PhaSyncState;
  noop?: boolean;
  warnings?: Array<{ path: string; rule: string; message: string }>;
};

export type TaskSummary = Pick<
  TaskDocument,
  "taskId" | "boardId" | "columnId" | "title" | "state" | "path" | "revision"
> &
  Pick<TaskDocument, "archived" | "typeId">;

export type TaskCheckpointOutline = Pick<
  CheckpointCore,
  "id" | "title" | "kind" | "status" | "revision" | "blocks"
> & {
  outcome?: string;
};

export type TaskReadOutline = Pick<
  TaskDocument,
  | "taskId"
  | "boardId"
  | "columnId"
  | "title"
  | "state"
  | "objective"
  | "acceptance"
  | "revision"
  | "path"
> & {
  finalOutcome?: string;
  remaining?: string[];
  checkpoints: TaskCheckpointOutline[];
  acceptanceItems?: import("../types.js").AcceptanceItem[];
  evidence?: import("../types.js").Evidence[];
  archived?: boolean;
  typeId?: string;
  legacyAcceptanceReview?: boolean;
  next_cursor?: string;
};

export type TaskCatalogOutput = {
  boards: Array<BoardConfig & { revision?: number }>;
};

export type TaskQueryItem = {
  task_id: string;
  board_id: string;
  column_id: string;
  title: string;
  state: TaskState;
  path: string;
  revision: number;
  archived?: boolean;
  type_id?: string;
  card?: { column_id?: string; checked: boolean; archived: boolean };
};

export type TaskQueryOutput = {
  tasks: TaskQueryItem[];
  next_cursor?: string;
  diagnostics_total?: number;
  diagnostics_truncated?: boolean;
  diagnostics?: Array<{ path: string; code: string; message: string }>;
};

export type TaskResumeOutput = {
  task: Pick<
    TaskDocument,
    | "taskId"
    | "boardId"
    | "columnId"
    | "title"
    | "state"
    | "objective"
    | "acceptance"
    | "revision"
  >;
  active_checkpoints: CheckpointCore[];
  active_checkpoint_details_omitted?: boolean;
  active_checkpoint_outline?: Array<
    Pick<CheckpointCore, "id" | "title" | "status" | "revision">
  >;
  next_action?: string;
  completed_outline: Array<
    Pick<CheckpointCore, "id" | "title" | "status" | "revision"> & {
      outcome?: string;
    }
  >;
  capsule?: ResumeCapsule;
  next_cursor?: string;
  context?: ReturnType<typeof import("../core/task.js").durableContext>;
  context_complete?: boolean;
  context_next_cursor?: string;
  handoff_status?: "missing" | "current" | "stale";
  acceptance_items?: import("../types.js").AcceptanceItem[];
  evidence?: import("../types.js").Evidence[];
};

export type TaskReadOutput = {
  view: "outline" | "checkpoint" | "block";
  task?: TaskReadOutline;
  checkpoint?: CheckpointCore;
  block?: {
    manifest: BlockManifest;
    content: string;
    next_cursor?: string;
  };
};

export type TaskCreateOutput = MutationResultMeta & { task: TaskDocument };
export type TaskCardUpdateOutput = MutationResultMeta & { task: TaskSummary };
export type TaskCheckpointCommitOutput = MutationResultMeta & {
  task_id: string;
  checkpoint: CheckpointCore;
};
export type TaskBlockPutOutput = MutationResultMeta & {
  task_id: string;
  checkpoint_id: string;
  block: BlockManifest;
};
export type TaskHandoffOutput = MutationResultMeta & {
  task_id: string;
  capsule: ResumeCapsule;
};
export type TaskFinalizeOutput = MutationResultMeta & { task: TaskSummary };

export interface TaskApi {
  catalog(input: TaskCatalogInput): Promise<TaskCatalogOutput>;
  query(input: TaskQueryInput): Promise<TaskQueryOutput>;
  resume(input: TaskResumeInput): Promise<TaskResumeOutput>;
  read(input: TaskReadInput): Promise<TaskReadOutput>;
  create(input: TaskCreateInput): Promise<TaskCreateOutput>;
  cardUpdate(input: TaskCardUpdateInput): Promise<TaskCardUpdateOutput>;
  checkpointCommit(
    input: TaskCheckpointCommitInput,
  ): Promise<TaskCheckpointCommitOutput>;
  blockPut(input: TaskBlockPutInput): Promise<TaskBlockPutOutput>;
  handoff(input: TaskHandoffInput): Promise<TaskHandoffOutput>;
  finalize(input: TaskFinalizeInput): Promise<TaskFinalizeOutput>;
  update(input: TaskUpdateInput): Promise<TaskCreateOutput>;
  reconcile(input: TaskReconcileInput): Promise<TaskReconcileOutput>;
}

export type TaskReconcileOutput = {
  task_id: string;
  document_revision: number;
  board_revision: number;
  direction: "document_to_board" | "board_to_document";
  changes: string[];
  can_apply: boolean;
  applied: boolean;
};

export const taskApiErrorCodes = [
  "INVALID_INPUT",
  "TASK_NOT_FOUND",
  "CHECKPOINT_NOT_FOUND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_EXPIRED",
  "RECOVERY_REQUIRED",
  "QUALITY_REJECTED",
  "DOCUMENT_CONFLICT",
  "DOCUMENT_MALFORMED",
  "IO_BUSY",
  "IO_ERROR",
  "PLUGIN_CONFIG_REQUIRED",
  "INTERNAL_ERROR",
] as const;

export type TaskApiErrorCode = (typeof taskApiErrorCodes)[number];
export type TaskApiErrorAction =
  | "revise_input"
  | "reread"
  | "retry_same_request"
  | "configure_plugin"
  | "none";

export type TaskApiErrorIssue = {
  path: string;
  rule: string;
  message: string;
};

export type TaskApiErrorOptions = {
  action?: TaskApiErrorAction;
  retryable?: boolean;
  issues?: TaskApiErrorIssue[];
  details?: Record<string, unknown>;
  cause?: unknown;
};

export class TaskApiError extends Error {
  readonly code: TaskApiErrorCode;
  readonly action: TaskApiErrorAction | undefined;
  readonly retryable: boolean;
  readonly issues: TaskApiErrorIssue[] | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: TaskApiErrorCode,
    message: string,
    options: TaskApiErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TaskApiError";
    this.code = code;
    this.action = options.action;
    this.retryable = options.retryable ?? false;
    this.issues = options.issues;
    this.details = options.details;
  }
}

export type StructuredTaskError = {
  code: TaskApiErrorCode;
  message: string;
  action: TaskApiErrorAction;
  retryable: boolean;
  issues?: TaskApiErrorIssue[];
  details?: Record<string, unknown>;
};

export function normalizeTaskApiError(error: unknown): StructuredTaskError {
  if (error instanceof TaskApiError) {
    return {
      code: error.code,
      message: error.message,
      action: error.action ?? "none",
      retryable: error.retryable,
      ...(error.issues === undefined ? {} : { issues: error.issues }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Internal task service error",
    action: "none",
    retryable: false,
  };
}
