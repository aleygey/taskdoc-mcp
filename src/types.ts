export type TaskState = "active" | "done" | "archived";
export type CheckpointStatus = "active" | "blocked" | "done" | "cancelled" | "superseded";
export type CheckpointKind = "analysis" | "decision" | "implementation" | "incident" | "operation";
export type EvidenceType = "test" | "artifact" | "observation" | "source" | "user_acceptance";
export type BlockKind =
  | "data_table"
  | "mermaid"
  | "domain_checklist"
  | "code_or_config"
  | "test_evidence"
  | "technical_spec"
  | "source_reference";

export interface AcceptanceItem {
  id: string;
  statement: string;
  status: "pending" | "verified" | "waived";
  evidenceRefs?: string[];
}

export interface Finding {
  fact: string;
  relevance: string;
}

export interface DurableConstraint {
  rejectedOption: string;
  verifiedReason: string;
  scope: string;
  impact: string;
  evidenceRefs: string[];
  reconsiderWhen?: string;
}

export interface Evidence {
  id: string;
  type: EvidenceType;
  statement: string;
  ref?: string;
}

export interface BlockManifest {
  id: string;
  kind: BlockKind;
  title: string;
  summary: string;
  supports: "objective" | "judgment" | "outcome";
  path: string;
  chars: number;
  contentHash: string;
  revision: number;
}

export interface CheckpointCore {
  id: string;
  revision: number;
  title: string;
  kind: CheckpointKind;
  status: CheckpointStatus;
  objective: {
    statement: string;
    acceptance: AcceptanceItem[];
  };
  judgment?: {
    facts?: Finding[];
    decisions?: string[];
    constraints?: DurableConstraint[];
  };
  outcome?: {
    summary: string;
    evidence: Evidence[];
    residualRisks?: string[];
  };
  blocker?: string;
  unblockCondition?: string;
  cancellation?: {
    reason: string;
    disposition: string;
  };
  supersededBy?: string;
  blocks: BlockManifest[];
}

export interface ResumeCapsule {
  focusCheckpointId: string;
  basedOnRevision: number;
  lastVerified?: string;
  nextAction: string;
  blockers: Array<{ statement: string; unblockWhen: string }>;
  openQuestions: string[];
  workingArtifacts: Array<{
    path: string;
    purpose: string;
    state: "editing" | "changed" | "verified";
  }>;
  workspaceRef?: {
    repo?: string;
    branch?: string;
    commit?: string;
  };
}

export interface TaskDocument {
  schema: "checkpoint/v1";
  taskId: string;
  boardId: string;
  columnId: string;
  title: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  objective: string;
  acceptance: string[];
  finalOutcome?: string;
  finalEvidence?: Evidence[];
  remaining?: string[];
  phaTaskId?: string;
  resume?: ResumeCapsule;
  checkpoints: CheckpointCore[];
  path: string;
  revision: number;
}

export type ValidationProfile = "bug" | "feature" | "research" | "migration" | "configuration" | "maintenance" | "other";

export interface BoardColumnConfig {
  id: string;
  heading: string;
  typeId: string;
  profile: ValidationProfile;
}

export interface BoardConfig {
  id: string;
  name: string;
  projectId: string;
  file: string;
  tasksFolder: string;
  defaultColumnId?: string;
  autoConvertCards: boolean;
  columns: BoardColumnConfig[];
}

export interface PhaSettings {
  enabled: boolean;
  baseUrl: string;
  workspace: string;
  tokenSecretKey: string;
}

export interface TaskDocSettings {
  mcpEnabled: boolean;
  mcpBindHost: string;
  mcpClientHost: string;
  mcpPort: number;
  mcpTokenSecretKey: string;
  allowedOrigins: string[];
  strictQuality: boolean;
  coreCharLimit: number;
  blockCharLimit: number;
  totalBlockCharLimit: number;
  resumeCharLimit: number;
  boards: BoardConfig[];
  pha: PhaSettings;
}

export interface VaultFileInfo {
  path: string;
  basename: string;
}

export type VaultOperation = "exists" | "read" | "create" | "write" | "delete" | "process" | "list" | "mkdir";

export class VaultIoError extends Error {
  readonly code: "IO_BUSY" | "IO_ERROR";
  readonly retryable: boolean;

  constructor(
    readonly operation: VaultOperation,
    readonly path: string,
    cause: unknown,
    retryable = looksTransient(cause)
  ) {
    super(`Vault ${operation} operation failed`, { cause });
    this.name = "VaultIoError";
    this.retryable = retryable;
    this.code = retryable ? "IO_BUSY" : "IO_ERROR";
  }
}

export interface VaultAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  delete?(path: string): Promise<void>;
  process(path: string, update: (current: string) => string): Promise<void>;
  listMarkdownFiles(roots: string[]): Promise<VaultFileInfo[]>;
  ensureFolder(path: string): Promise<void>;
}

function looksTransient(error: unknown): boolean {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown; message?: unknown } : {};
  const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
  const message = typeof record.message === "string" ? record.message.toUpperCase() : "";
  return ["EBUSY", "EAGAIN", "EMFILE", "ENFILE", "ETXTBSY"].includes(code) ||
    /\b(?:EBUSY|EAGAIN|EMFILE|ENFILE|ETXTBSY)\b/.test(message);
}
