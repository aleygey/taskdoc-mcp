export type TaskDocErrorCode =
  | "INVALID_INPUT"
  | "TASK_NOT_FOUND"
  | "CHECKPOINT_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "QUALITY_REJECTED"
  | "DOCUMENT_CONFLICT"
  | "DOCUMENT_MALFORMED"
  | "IO_BUSY"
  | "IO_ERROR"
  | "PLUGIN_CONFIG_REQUIRED";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  path: string;
  rule: string;
  message: string;
  severity: ValidationSeverity;
  suggestion?: string;
}

export class TaskDocError extends Error {
  readonly code: TaskDocErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly issues: readonly ValidationIssue[] | undefined;

  constructor(
    code: TaskDocErrorCode,
    message: string,
    options: {
      details?: Readonly<Record<string, unknown>>;
      issues?: readonly ValidationIssue[];
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TaskDocError";
    this.code = code;
    this.details = options.details;
    this.issues = options.issues;
  }
}

export function malformedDocument(message: string, cause?: unknown): TaskDocError {
  return new TaskDocError("DOCUMENT_MALFORMED", message, { cause });
}

export function qualityRejected(issues: readonly ValidationIssue[]): TaskDocError {
  const first = issues.find((issue) => issue.severity === "error");
  return new TaskDocError(
    "QUALITY_REJECTED",
    first === undefined ? "Task document failed quality validation" : first.message,
    { issues }
  );
}
