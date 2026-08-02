import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const requestId = z.string().trim().min(8).max(128);
const revision = z.number().int().min(0);
const shortText = z.string().trim().min(1).max(240);
const evidenceType = z.enum(["test", "artifact", "observation", "source", "user_acceptance"]);

export const taskCatalogInputSchema = z.object({}).strict();

export const taskQueryInputSchema = z
  .object({
    board_id: id.optional(),
    column_id: id.optional(),
    state: z.enum(["active", "done", "archived"]).optional(),
    query: z.string().trim().min(1).max(200).optional(),
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

export const taskResumeInputSchema = z
  .object({
    task_id: id,
    completed_limit: z.number().int().min(0).max(100).default(20),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const taskReadInputSchema = z
  .object({
    task_id: id,
    view: z.enum(["outline", "checkpoint", "block"]).default("outline"),
    checkpoint_id: id.optional(),
    block_id: id.optional(),
    cursor: z.string().trim().min(1).max(512).optional(),
    checkpoint_limit: z.number().int().min(1).max(100).default(20),
    max_chars: z.number().int().min(256).max(8192).default(4096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.view !== "outline" && value.checkpoint_id === undefined) {
      context.addIssue({ code: "custom", path: ["checkpoint_id"], message: `${value.view} view requires checkpoint_id` });
    }
    if (value.view === "block" && value.block_id === undefined) {
      context.addIssue({ code: "custom", path: ["block_id"], message: "block view requires block_id" });
    }
    if (value.view !== "block" && value.block_id !== undefined) {
      context.addIssue({ code: "custom", path: ["view"], message: "block_id is only valid for block view" });
    }
    if (value.view === "checkpoint" && value.cursor !== undefined) {
      context.addIssue({ code: "custom", path: ["cursor"], message: "cursor is only valid for outline or block view" });
    }
  });

export const taskCreateInputSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: requestId,
    board_id: id,
    column_id: id,
    expected_board_revision: revision.optional(),
    title: z.string().trim().min(2).max(40),
    objective: z.string().trim().min(1).max(1_000),
    acceptance: z.array(shortText).min(1).max(20),
  })
  .strict();

export const taskCardUpdateInputSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: requestId,
    task_id: id,
    expected_revision: revision,
    column_id: id.optional(),
    state: z.literal("active").optional(),
  })
  .strict()
  .refine((value) => value.column_id !== undefined || value.state !== undefined, {
    message: "column_id or state is required",
    path: ["column_id"],
  });

const acceptanceItemSchema = z
  .object({
    id,
    statement: z.string().trim().min(1).max(400),
    status: z.enum(["pending", "verified", "waived"]),
    evidence_refs: z.array(id).max(20).optional(),
  })
  .strict();

const findingSchema = z
  .object({
    fact: z.string().trim().min(1).max(400),
    relevance: z.string().trim().min(1).max(240),
  })
  .strict();

const constraintSchema = z
  .object({
    rejected_option: z.string().trim().min(1).max(300),
    verified_reason: z.string().trim().min(1).max(400),
    scope: z.string().trim().min(1).max(240),
    impact: z.string().trim().min(1).max(300),
    evidence_refs: z.array(id).min(1).max(20),
    reconsider_when: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

const evidenceSchema = z
  .object({
    id,
    type: evidenceType,
    statement: z.string().trim().min(1).max(400),
    ref: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

const checkpointCoreInputSchema = z
  .object({
    title: z.string().trim().min(2).max(40),
    kind: z.enum(["analysis", "decision", "implementation", "incident", "operation"]),
    status: z.enum(["active", "blocked", "done", "cancelled", "superseded"]),
    objective: z
      .object({
        statement: z.string().trim().min(1).max(600),
        acceptance: z.array(acceptanceItemSchema).min(1).max(5),
      })
      .strict(),
    judgment: z
      .object({
        facts: z.array(findingSchema).max(4).optional(),
        decisions: z.array(z.string().trim().min(1).max(400)).max(3).optional(),
        constraints: z.array(constraintSchema).max(3).optional(),
      })
      .strict()
      .optional(),
    outcome: z
      .object({
        summary: z.string().trim().min(1).max(800),
        evidence: z.array(evidenceSchema).max(5),
        residual_risks: z.array(shortText).max(3).optional(),
      })
      .strict()
      .optional(),
    blocker: z.string().trim().min(1).max(400).optional(),
    unblock_condition: z.string().trim().min(1).max(400).optional(),
    cancellation: z
      .object({
        reason: z.string().trim().min(1).max(400),
        disposition: z.string().trim().min(1).max(400),
      })
      .strict()
      .optional(),
    superseded_by: id.optional(),
  })
  .strict();

export const taskCheckpointCommitInputSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: requestId,
    task_id: id,
    checkpoint_id: id.optional(),
    expected_revision: revision,
    trigger: z.enum([
      "subtask_started",
      "subtask_completed",
      "decision_finalized",
      "constraint_confirmed",
      "partial_result_confirmed",
      "result_verified",
      "blocker_confirmed",
      "correction",
    ]),
    core: checkpointCoreInputSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expected_revision > 0 && value.checkpoint_id === undefined) {
      context.addIssue({ code: "custom", path: ["checkpoint_id"], message: "updates require checkpoint_id" });
    }
    if (value.core.status === "done" && value.core.outcome === undefined) {
      context.addIssue({ code: "custom", path: ["core", "outcome"], message: "done checkpoints require outcome" });
    }
    if (value.core.status === "blocked" && (value.core.blocker === undefined || value.core.unblock_condition === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["core", "blocker"],
        message: "blocked checkpoints require blocker and unblock_condition",
      });
    }
    if (value.core.status === "cancelled" && value.core.cancellation === undefined) {
      context.addIssue({ code: "custom", path: ["core", "cancellation"], message: "cancelled checkpoints require cancellation" });
    }
    if (value.core.status === "superseded" && value.core.superseded_by === undefined) {
      context.addIssue({ code: "custom", path: ["core", "superseded_by"], message: "superseded checkpoints require superseded_by" });
    }
  });

const blockKind = z.enum([
  "data_table",
  "mermaid",
  "domain_checklist",
  "code_or_config",
  "test_evidence",
  "technical_spec",
  "source_reference",
]);

export const taskBlockPutInputSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: requestId,
    task_id: id,
    checkpoint_id: id,
    block_id: id.optional(),
    expected_revision: revision,
    block: z
      .object({
        kind: blockKind,
        title: z.string().trim().min(2).max(80),
        summary: z.string().trim().min(10).max(240),
        supports: z.enum(["objective", "judgment", "outcome"]),
        checklist_scope: z
          .enum(["acceptance", "compatibility", "deployment", "test_matrix", "production_check"])
          .optional(),
        source_uri: z.string().trim().min(1).max(1_000).optional(),
        language: z.string().trim().min(1).max(40).optional(),
        content: z.string().min(1).max(200_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expected_revision > 0 && value.block_id === undefined) {
      context.addIssue({ code: "custom", path: ["block_id"], message: "updates require block_id" });
    }
    if (value.block.kind === "domain_checklist" && value.block.checklist_scope === undefined) {
      context.addIssue({ code: "custom", path: ["block", "checklist_scope"], message: "domain_checklist requires checklist_scope" });
    }
    if (value.block.kind === "code_or_config" && value.block.language === undefined) {
      context.addIssue({ code: "custom", path: ["block", "language"], message: "code_or_config requires language" });
    }
    if (value.block.kind === "source_reference" && value.block.source_uri === undefined) {
      context.addIssue({ code: "custom", path: ["block", "source_uri"], message: "source_reference requires source_uri" });
    }
  });

const resumeCapsuleInputSchema = z
  .object({
    focus_checkpoint_id: id,
    based_on_revision: z.number().int().min(1),
    last_verified: z.string().trim().min(1).max(400).optional(),
    next_action: z.string().trim().min(1).max(400),
    blockers: z
      .array(
        z
          .object({
            statement: z.string().trim().min(1).max(300),
            unblock_when: z.string().trim().min(1).max(300),
          })
          .strict(),
      )
      .max(3),
    open_questions: z.array(shortText).max(3),
    working_artifacts: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(1_000),
            purpose: z.string().trim().min(1).max(240),
            state: z.enum(["editing", "changed", "verified"]),
          })
          .strict(),
      )
      .max(5),
    workspace_ref: z
      .object({
        repo: z.string().trim().min(1).max(1_000).optional(),
        branch: z.string().trim().min(1).max(300).optional(),
        commit: z.string().trim().min(1).max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const taskHandoffInputSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: requestId,
    task_id: id,
    expected_revision: revision,
    capsule: resumeCapsuleInputSchema,
  })
  .strict();

export const taskFinalizeInputSchema = z
  .object({
    schema_version: z.literal(1),
    request_id: requestId,
    task_id: id,
    expected_revision: revision,
    status: z.enum(["done", "archived"]),
    final_outcome: z.string().trim().min(1).max(1_000),
    evidence: z.array(evidenceSchema.omit({ id: true })).min(1).max(20),
    remaining: z.array(shortText).max(3),
  })
  .strict();

const structuredErrorSchema = z
  .object({
    code: z.enum([
      "INVALID_INPUT",
      "TASK_NOT_FOUND",
      "CHECKPOINT_NOT_FOUND",
      "VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "QUALITY_REJECTED",
      "DOCUMENT_CONFLICT",
      "DOCUMENT_MALFORMED",
      "IO_BUSY",
      "IO_ERROR",
      "PLUGIN_CONFIG_REQUIRED",
      "INTERNAL_ERROR",
    ]),
    message: z.string(),
    action: z.enum(["revise_input", "reread", "retry_same_request", "configure_plugin", "none"]),
    retryable: z.boolean(),
    issues: z
      .array(
        z
          .object({ path: z.string(), rule: z.string(), message: z.string() })
          .strict(),
      )
      .optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// SDK 1.x wraps raw shapes reliably but its output validator does not support a
// top-level discriminated union. The handler still enforces the ok/data vs
// ok/error invariant when constructing results.
export const toolResultOutputSchema = z
  .object({
    ok: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: structuredErrorSchema.optional(),
  })
  .strict();

export type TaskCatalogInput = z.infer<typeof taskCatalogInputSchema>;
export type TaskQueryInput = z.infer<typeof taskQueryInputSchema>;
export type TaskResumeInput = z.infer<typeof taskResumeInputSchema>;
export type TaskReadInput = z.infer<typeof taskReadInputSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>;
export type TaskCardUpdateInput = z.infer<typeof taskCardUpdateInputSchema>;
export type TaskCheckpointCommitInput = z.infer<typeof taskCheckpointCommitInputSchema>;
export type TaskBlockPutInput = z.infer<typeof taskBlockPutInputSchema>;
export type TaskHandoffInput = z.infer<typeof taskHandoffInputSchema>;
export type TaskFinalizeInput = z.infer<typeof taskFinalizeInputSchema>;
