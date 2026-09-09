import type { CheckpointCore, ResumeCapsule, TaskDocument } from "../types";
import { isTerminal } from "../types";
import type { ValidationIssue } from "./errors";
import { qualityRejected } from "./errors";
import { renderCheckpointCore, renderResumeCallout } from "./renderer";
import { nonEmpty, unicodeLength } from "./text";

export interface ValidationLimits {
  coreCharLimit: number;
  blockCharLimit: number;
  totalBlockCharLimit: number;
  resumeCharLimit: number;
  maxBlocksPerCheckpoint: number;
}

export const DEFAULT_VALIDATION_LIMITS: Readonly<ValidationLimits> = {
  coreCharLimit: 2_500,
  blockCharLimit: 24_576,
  totalBlockCharLimit: 98_304,
  resumeCharLimit: 1600,
  maxBlocksPerCheckpoint: 8,
};

export interface ValidationOptions extends Partial<ValidationLimits> {
  strictQuality?: boolean;
  limits?: Partial<ValidationLimits>;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  renderedChars?: number;
}

function resolveLimits(options: ValidationOptions): ValidationLimits {
  return {
    ...DEFAULT_VALIDATION_LIMITS,
    ...options.limits,
    ...Object.fromEntries(
      Object.entries(options).filter(
        ([key]) => key in DEFAULT_VALIDATION_LIMITS,
      ),
    ),
  } as ValidationLimits;
}

function issue(
  issues: ValidationIssue[],
  path: string,
  rule: string,
  message: string,
  severity: ValidationIssue["severity"] = "error",
  suggestion?: string,
): void {
  issues.push({
    path,
    rule,
    message,
    severity,
    ...(suggestion === undefined ? {} : { suggestion }),
  });
}

function finish(
  issues: ValidationIssue[],
  renderedChars?: number,
): ValidationResult {
  const errors = issues.filter((entry) => entry.severity === "error");
  const warnings = issues.filter((entry) => entry.severity === "warning");
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
    ...(renderedChars === undefined ? {} : { renderedChars }),
  };
}

const PLACEHOLDER = /\b(?:TODO|TBD|FIXME)\b|待补充|待确认|同上|稍后补/iu;
const TRANSCRIPT =
  /(^|\n)\s*(?:user|assistant|system|agent|用户|助手|系统|智能体)\s*[:：]/iu;
const PROCESS_NARRATIVE =
  /用户(?:问|说|提到)|我(?:会|将|先|正在|接下来)|(?:先尝试|尝试了|接下来|然后|后来|经过尝试|也许|可能)/u;
const TIMELINE =
  /(^|\n)\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}:\d{2})\s*(?:[|：:-]|$)/u;
const FREE_MARKDOWN =
  /(^|\n)\s*(?:#{1,6}\s|```|>\s|[-*]\s+\[[ xX]\]|\|.+\|\s*$)/u;

function inspectProse(
  issues: ValidationIssue[],
  path: string,
  value: string,
  strictQuality: boolean,
): void {
  if (!nonEmpty(value)) {
    issue(issues, path, "required", `${path} must not be empty`);
    return;
  }
  if (value.includes("\n") || value.includes("\r")) {
    issue(
      issues,
      path,
      "single_line",
      `${path} must be a concise single-line field`,
    );
  }
  if (strictQuality && PLACEHOLDER.test(value)) {
    issue(
      issues,
      path,
      "placeholder",
      `${path} contains a placeholder`,
      "warning",
    );
  }
  if (TRANSCRIPT.test(value)) {
    issue(issues, path, "conversation", `${path} looks like a chat transcript`);
  }
  if (TIMELINE.test(value)) {
    issue(issues, path, "timeline", `${path} looks like a chronological log`);
  }
  if (FREE_MARKDOWN.test(value)) {
    issue(
      issues,
      path,
      "free_markdown",
      `${path} contains layout reserved for a rich block`,
    );
  }
  if (strictQuality && PROCESS_NARRATIVE.test(value)) {
    issue(
      issues,
      path,
      "process_narrative",
      `${path} looks like process narration or an unconfirmed statement`,
      "warning",
      "Keep only the confirmed fact, durable decision, or verified result.",
    );
  }
}

function inspectResumeQuestion(
  issues: ValidationIssue[],
  path: string,
  value: string,
): void {
  if (!nonEmpty(value)) {
    issue(issues, path, "required", `${path} must not be empty`);
    return;
  }
  if (value.includes("\n") || value.includes("\r")) {
    issue(
      issues,
      path,
      "single_line",
      `${path} must be a concise single-line field`,
    );
  }
  if (TRANSCRIPT.test(value) || TIMELINE.test(value)) {
    issue(
      issues,
      path,
      "conversation",
      `${path} cannot contain transcript or log content`,
    );
  }
  if (FREE_MARKDOWN.test(value)) {
    issue(
      issues,
      path,
      "free_markdown",
      `${path} cannot contain Markdown layout`,
    );
  }
}

function uniqueIds(
  issues: ValidationIssue[],
  path: string,
  values: readonly { id: string }[],
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!nonEmpty(value.id)) {
      issue(issues, `${path}[${index}].id`, "required", "ID must not be empty");
    } else if (seen.has(value.id)) {
      issue(
        issues,
        `${path}[${index}].id`,
        "unique",
        `Duplicate ID: ${value.id}`,
      );
    }
    seen.add(value.id);
  }
}

export function validateCheckpoint(
  checkpoint: CheckpointCore,
  options: ValidationOptions = {},
): ValidationResult {
  const limits = resolveLimits(options);
  const strict = options.strictQuality ?? true;
  const issues: ValidationIssue[] = [];

  inspectProse(issues, "checkpoint.title", checkpoint.title, strict);
  if (unicodeLength(checkpoint.title) > 40) {
    issue(
      issues,
      "checkpoint.title",
      "max_length",
      "Checkpoint title must be at most 40 characters",
    );
  }
  if (!nonEmpty(checkpoint.id)) {
    issue(issues, "checkpoint.id", "required", "Checkpoint ID is required");
  }
  if (!Number.isInteger(checkpoint.revision) || checkpoint.revision < 1) {
    issue(
      issues,
      "checkpoint.revision",
      "revision",
      "Checkpoint revision must be a positive integer",
    );
  }

  inspectProse(
    issues,
    "checkpoint.objective.statement",
    checkpoint.objective.statement,
    strict,
  );
  if (checkpoint.objective.acceptance.length === 0) {
    issue(
      issues,
      "checkpoint.objective.acceptance",
      "required",
      "At least one acceptance condition is required",
    );
  }
  if (checkpoint.objective.acceptance.length > 5) {
    issue(
      issues,
      "checkpoint.objective.acceptance",
      "max_items",
      "Move acceptance matrices over 5 items to a rich block",
    );
  }
  uniqueIds(
    issues,
    "checkpoint.objective.acceptance",
    checkpoint.objective.acceptance,
  );
  for (const [index, acceptance] of checkpoint.objective.acceptance.entries()) {
    inspectProse(
      issues,
      `checkpoint.objective.acceptance[${index}].statement`,
      acceptance.statement,
      strict,
    );
  }

  const facts = checkpoint.judgment?.facts ?? [];
  const decisions = checkpoint.judgment?.decisions ?? [];
  const constraints = checkpoint.judgment?.constraints ?? [];
  if (facts.length > 4) {
    issue(
      issues,
      "checkpoint.judgment.facts",
      "max_items",
      "At most 4 core facts are allowed",
    );
  }
  if (decisions.length > 3) {
    issue(
      issues,
      "checkpoint.judgment.decisions",
      "max_items",
      "At most 3 core decisions are allowed",
    );
  }
  if (constraints.length > 3) {
    issue(
      issues,
      "checkpoint.judgment.constraints",
      "max_items",
      "At most 3 durable constraints are allowed",
    );
  }
  for (const [index, finding] of facts.entries()) {
    inspectProse(
      issues,
      `checkpoint.judgment.facts[${index}].fact`,
      finding.fact,
      strict,
    );
    inspectProse(
      issues,
      `checkpoint.judgment.facts[${index}].relevance`,
      finding.relevance,
      strict,
    );
  }
  for (const [index, decision] of decisions.entries()) {
    inspectProse(
      issues,
      `checkpoint.judgment.decisions[${index}]`,
      decision,
      strict,
    );
  }

  const evidence = checkpoint.outcome?.evidence ?? [];
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  uniqueIds(issues, "checkpoint.outcome.evidence", evidence);
  if (checkpoint.outcome !== undefined) {
    inspectProse(
      issues,
      "checkpoint.outcome.summary",
      checkpoint.outcome.summary,
      strict,
    );
    if (evidence.length > 5) {
      issue(
        issues,
        "checkpoint.outcome.evidence",
        "max_items",
        "Move evidence matrices over 5 items to a rich block",
      );
    }
    for (const [index, entry] of evidence.entries()) {
      inspectProse(
        issues,
        `checkpoint.outcome.evidence[${index}].statement`,
        entry.statement,
        strict,
      );
    }
    for (const [index, risk] of (
      checkpoint.outcome.residualRisks ?? []
    ).entries()) {
      inspectProse(
        issues,
        `checkpoint.outcome.residualRisks[${index}]`,
        risk,
        strict,
      );
    }
    if ((checkpoint.outcome.residualRisks?.length ?? 0) > 3) {
      issue(
        issues,
        "checkpoint.outcome.residualRisks",
        "max_items",
        "At most 3 residual risks are allowed",
      );
    }
  }

  for (const [index, acceptance] of checkpoint.objective.acceptance.entries()) {
    for (const ref of acceptance.evidenceRefs ?? []) {
      if (!evidenceIds.has(ref)) {
        issue(
          issues,
          `checkpoint.objective.acceptance[${index}].evidenceRefs`,
          "reference",
          `Unknown evidence reference: ${ref}`,
        );
      }
    }
  }

  for (const [index, constraint] of constraints.entries()) {
    const base = `checkpoint.judgment.constraints[${index}]`;
    inspectProse(
      issues,
      `${base}.rejectedOption`,
      constraint.rejectedOption,
      strict,
    );
    inspectProse(
      issues,
      `${base}.verifiedReason`,
      constraint.verifiedReason,
      strict,
    );
    inspectProse(issues, `${base}.scope`, constraint.scope, strict);
    inspectProse(issues, `${base}.impact`, constraint.impact, strict);
    if (constraint.reconsiderWhen !== undefined) {
      inspectProse(
        issues,
        `${base}.reconsiderWhen`,
        constraint.reconsiderWhen,
        strict,
      );
    }
    if (constraint.evidenceRefs.length === 0) {
      issue(
        issues,
        `${base}.evidenceRefs`,
        "constraint_evidence",
        "A durable constraint needs at least one evidence reference",
      );
    }
    for (const ref of constraint.evidenceRefs) {
      if (!evidenceIds.has(ref)) {
        issue(
          issues,
          `${base}.evidenceRefs`,
          "reference",
          `Unknown evidence reference: ${ref}`,
        );
      }
    }
  }

  if (checkpoint.status === "done") {
    if (
      checkpoint.outcome === undefined ||
      !nonEmpty(checkpoint.outcome.summary)
    ) {
      issue(
        issues,
        "checkpoint.outcome",
        "done_outcome",
        "A done checkpoint requires an actual outcome",
      );
    }
    if (evidence.length === 0) {
      issue(
        issues,
        "checkpoint.outcome.evidence",
        "done_evidence",
        "A done checkpoint requires at least one concrete evidence item",
      );
    }
    for (const [
      index,
      acceptance,
    ] of checkpoint.objective.acceptance.entries()) {
      if (acceptance.status === "pending") {
        issue(
          issues,
          `checkpoint.objective.acceptance[${index}].status`,
          "done_acceptance",
          "A done checkpoint cannot have pending acceptance conditions",
        );
      }
    }
    if (
      checkpoint.kind === "implementation" &&
      !evidence.some(
        (entry) =>
          entry.type === "test" ||
          entry.type === "observation" ||
          entry.type === "user_acceptance",
      )
    ) {
      issue(
        issues,
        "checkpoint.outcome.evidence",
        "implementation_evidence",
        "A completed implementation needs test, observation, or user acceptance evidence",
      );
    }
    if (
      (checkpoint.kind === "analysis" || checkpoint.kind === "decision") &&
      facts.length + decisions.length === 0
    ) {
      issue(
        issues,
        "checkpoint.judgment",
        "final_judgment",
        "A completed analysis or decision checkpoint requires a final judgment",
      );
    }
  }

  if (checkpoint.status === "blocked") {
    if (!nonEmpty(checkpoint.blocker)) {
      issue(
        issues,
        "checkpoint.blocker",
        "blocked_reason",
        "A blocked checkpoint requires a blocker",
      );
    }
    if (!nonEmpty(checkpoint.unblockCondition)) {
      issue(
        issues,
        "checkpoint.unblockCondition",
        "blocked_condition",
        "A blocked checkpoint requires an unblock condition",
      );
    }
  }
  if (
    checkpoint.status !== "blocked" &&
    (checkpoint.blocker !== undefined ||
      checkpoint.unblockCondition !== undefined)
  ) {
    issue(
      issues,
      "checkpoint.blocker",
      "state_field",
      "Only a blocked checkpoint may contain blocker fields",
    );
  }
  if (
    checkpoint.status === "cancelled" &&
    (!nonEmpty(checkpoint.cancellation?.reason) ||
      !nonEmpty(checkpoint.cancellation?.disposition))
  ) {
    issue(
      issues,
      "checkpoint.cancellation",
      "cancelled_disposition",
      "A cancelled checkpoint requires a reason and disposition",
    );
  }
  if (
    checkpoint.status !== "cancelled" &&
    checkpoint.cancellation !== undefined
  ) {
    issue(
      issues,
      "checkpoint.cancellation",
      "state_field",
      "Only a cancelled checkpoint may contain cancellation fields",
    );
  }
  if (
    checkpoint.status === "superseded" &&
    !nonEmpty(checkpoint.supersededBy)
  ) {
    issue(
      issues,
      "checkpoint.supersededBy",
      "superseded_target",
      "A superseded checkpoint requires its replacement ID",
    );
  }
  if (
    checkpoint.status !== "superseded" &&
    checkpoint.supersededBy !== undefined
  ) {
    issue(
      issues,
      "checkpoint.supersededBy",
      "state_field",
      "Only a superseded checkpoint may name a replacement",
    );
  }

  uniqueIds(issues, "checkpoint.blocks", checkpoint.blocks);
  if (checkpoint.blocks.length > limits.maxBlocksPerCheckpoint) {
    issue(
      issues,
      "checkpoint.blocks",
      "max_items",
      `A checkpoint may contain at most ${limits.maxBlocksPerCheckpoint} rich blocks`,
    );
  }
  let totalBlockChars = 0;
  for (const [index, block] of checkpoint.blocks.entries()) {
    totalBlockChars += block.chars;
    if (
      !nonEmpty(block.title) ||
      !nonEmpty(block.summary) ||
      !nonEmpty(block.path)
    ) {
      issue(
        issues,
        `checkpoint.blocks[${index}]`,
        "manifest",
        "Block manifest requires title, summary, and path",
      );
    }
    if (!/^[a-f0-9]{64}$/.test(block.contentHash)) {
      issue(
        issues,
        `checkpoint.blocks[${index}].contentHash`,
        "block_hash",
        "Block manifest requires a SHA-256 content hash",
      );
    }
    if (
      !Number.isInteger(block.chars) ||
      block.chars < 1 ||
      block.chars > limits.blockCharLimit
    ) {
      issue(
        issues,
        `checkpoint.blocks[${index}].chars`,
        "block_size",
        `Block size must be between 1 and ${limits.blockCharLimit} characters`,
      );
    }
    if (!Number.isInteger(block.revision) || block.revision < 1) {
      issue(
        issues,
        `checkpoint.blocks[${index}].revision`,
        "revision",
        "Block revision must be a positive integer",
      );
    }
  }
  if (totalBlockChars > limits.totalBlockCharLimit) {
    issue(
      issues,
      "checkpoint.blocks",
      "total_block_size",
      `Block total exceeds ${limits.totalBlockCharLimit} characters`,
    );
  }

  const renderedChars = unicodeLength(
    renderCheckpointCore(checkpoint, 1, { includeBlockManifest: false }),
  );
  if (renderedChars > limits.coreCharLimit) {
    issue(
      issues,
      "checkpoint",
      "core_size",
      `Rendered checkpoint core exceeds ${limits.coreCharLimit} characters`,
    );
  }
  return finish(issues, renderedChars);
}

export function validateResumeCapsule(
  resume: ResumeCapsule,
  checkpoints: readonly CheckpointCore[],
  options: ValidationOptions = {},
): ValidationResult {
  const limits = resolveLimits(options);
  const issues: ValidationIssue[] = [];
  const focus = checkpoints.find(
    (checkpoint) => checkpoint.id === resume.focusCheckpointId,
  );
  if (resume.focusCheckpointId !== undefined && focus === undefined) {
    issue(
      issues,
      "resume.focusCheckpointId",
      "reference",
      "Resume focus checkpoint does not exist",
    );
  } else if (focus !== undefined && !resume.stale) {
    if (focus.status !== "active" && focus.status !== "blocked") {
      issue(
        issues,
        "resume.focusCheckpointId",
        "resume_terminal",
        "Resume can only focus an active or blocked checkpoint",
      );
    }
    if (resume.basedOnRevision !== focus.revision) {
      issue(
        issues,
        "resume.basedOnRevision",
        "resume_revision",
        "Resume revision does not match the focused checkpoint",
      );
    }
  }
  if (!nonEmpty(resume.nextAction)) {
    issue(
      issues,
      "resume.nextAction",
      "required",
      "Resume requires exactly one next action",
    );
  } else if (
    resume.nextAction.includes("\n") ||
    /(?:^|\s)\d+[.)]\s/.test(resume.nextAction)
  ) {
    issue(
      issues,
      "resume.nextAction",
      "single_action",
      "Resume nextAction must be one concise action, not a plan",
    );
  }
  if (TRANSCRIPT.test(resume.nextAction) || TIMELINE.test(resume.nextAction)) {
    issue(
      issues,
      "resume.nextAction",
      "conversation",
      "Resume cannot contain transcript or log content",
    );
  }
  if (resume.lastVerified !== undefined) {
    inspectProse(issues, "resume.lastVerified", resume.lastVerified, false);
  }
  if (resume.openQuestions.length > 3) {
    issue(
      issues,
      "resume.openQuestions",
      "max_items",
      "Resume may contain at most 3 open questions",
    );
  }
  if (resume.blockers.length > 3) {
    issue(
      issues,
      "resume.blockers",
      "max_items",
      "Resume may contain at most 3 blockers",
    );
  }
  if (resume.workingArtifacts.length > 5) {
    issue(
      issues,
      "resume.workingArtifacts",
      "max_items",
      "Resume may contain at most 5 working artifacts",
    );
  }
  for (const [index, blocker] of resume.blockers.entries()) {
    if (!nonEmpty(blocker.statement) || !nonEmpty(blocker.unblockWhen)) {
      issue(
        issues,
        `resume.blockers[${index}]`,
        "blocker",
        "Resume blocker requires statement and unblock condition",
      );
    } else {
      inspectProse(
        issues,
        `resume.blockers[${index}].statement`,
        blocker.statement,
        false,
      );
      inspectProse(
        issues,
        `resume.blockers[${index}].unblockWhen`,
        blocker.unblockWhen,
        false,
      );
    }
  }
  for (const [index, question] of resume.openQuestions.entries()) {
    inspectResumeQuestion(issues, `resume.openQuestions[${index}]`, question);
  }
  for (const [index, artifact] of resume.workingArtifacts.entries()) {
    if (!nonEmpty(artifact.path)) {
      issue(
        issues,
        `resume.workingArtifacts[${index}].path`,
        "required",
        "Working artifact path must not be empty",
      );
    }
    inspectProse(
      issues,
      `resume.workingArtifacts[${index}].purpose`,
      artifact.purpose,
      false,
    );
  }
  const renderedChars = unicodeLength(renderResumeCallout(resume, checkpoints));
  if (renderedChars > limits.resumeCharLimit) {
    issue(
      issues,
      "resume",
      "resume_size",
      `Resume callout exceeds ${limits.resumeCharLimit} characters`,
    );
  }
  return finish(issues, renderedChars);
}

export function validateTaskDocument(
  task: TaskDocument,
  options: ValidationOptions = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const strict = options.strictQuality ?? true;
  if (task.schema !== "checkpoint/v1" && task.schema !== "checkpoint/v2") {
    issue(issues, "task.schema", "schema", "Unsupported task document schema");
  }
  for (const [path, value] of [
    ["task.taskId", task.taskId],
    ["task.boardId", task.boardId],
    ["task.columnId", task.columnId],
    ["task.title", task.title],
    ["task.objective", task.objective],
    ["task.path", task.path],
  ] as const) {
    inspectProse(issues, path, value, strict);
  }
  if (unicodeLength(task.title) > 40) {
    issue(
      issues,
      "task.title",
      "max_length",
      "Task title must be at most 40 characters",
    );
  }
  if (!Number.isInteger(task.revision) || task.revision < 1) {
    issue(
      issues,
      "task.revision",
      "revision",
      "Task revision must be a positive integer",
    );
  }
  if (
    Number.isNaN(Date.parse(task.createdAt)) ||
    Number.isNaN(Date.parse(task.updatedAt))
  ) {
    issue(
      issues,
      "task",
      "datetime",
      "createdAt and updatedAt must be ISO-compatible timestamps",
    );
  }
  if (task.acceptance.length === 0) {
    issue(
      issues,
      "task.acceptance",
      "required",
      "Task needs at least one acceptance condition",
    );
  }
  if (task.finalOutcome !== undefined) {
    inspectProse(issues, "task.finalOutcome", task.finalOutcome, strict);
  }
  for (const [index, acceptance] of task.acceptance.entries()) {
    inspectProse(issues, `task.acceptance[${index}]`, acceptance, strict);
  }

  uniqueIds(issues, "task.checkpoints", task.checkpoints);
  const activeCheckpointCount = task.checkpoints.filter(
    (checkpoint) =>
      checkpoint.status === "active" || checkpoint.status === "blocked",
  ).length;
  if (activeCheckpointCount > 5) {
    issue(
      issues,
      "task.checkpoints",
      "max_active",
      "A task may contain at most 5 active or blocked checkpoints",
    );
  }
  for (const [index, checkpoint] of task.checkpoints.entries()) {
    const result = validateCheckpoint(checkpoint, options);
    for (const entry of result.issues) {
      issues.push({
        ...entry,
        path: `task.checkpoints[${index}].${entry.path.replace(/^checkpoint\.?/, "")}`,
      });
    }
    if (
      checkpoint.status === "superseded" &&
      (checkpoint.supersededBy === checkpoint.id ||
        !task.checkpoints.some(
          (candidate) => candidate.id === checkpoint.supersededBy,
        ))
    ) {
      issue(
        issues,
        `task.checkpoints[${index}].supersededBy`,
        "reference",
        "Superseded target must be another checkpoint in this task",
      );
    }
  }

  if (isTerminal(task.state)) {
    if (!nonEmpty(task.finalOutcome)) {
      issue(
        issues,
        "task.finalOutcome",
        "terminal_outcome",
        "A terminal task requires a final outcome",
      );
    }
    if (task.schema === "checkpoint/v1" && task.checkpoints.length === 0) {
      issue(
        issues,
        "task.checkpoints",
        "terminal_checkpoint",
        "A terminal task requires at least one checkpoint",
      );
    }
    if (
      task.checkpoints.some(
        (checkpoint) =>
          checkpoint.status === "active" || checkpoint.status === "blocked",
      )
    ) {
      issue(
        issues,
        "task.checkpoints",
        "terminal_checkpoints",
        "A terminal task cannot contain active or blocked checkpoints",
      );
    }
    if (
      task.schema === "checkpoint/v1" &&
      (task.finalEvidence?.length ?? 0) === 0
    ) {
      issue(
        issues,
        "task.finalEvidence",
        "terminal_evidence",
        "A terminal task requires at least one final evidence item",
      );
    }
  }
  if (
    !isTerminal(task.state) &&
    (task.finalOutcome !== undefined ||
      task.finalEvidence !== undefined ||
      task.remaining !== undefined)
  ) {
    issue(
      issues,
      "task",
      "terminal_fields",
      "An active task cannot retain terminal outcome, evidence, or remaining fields",
    );
  }
  if ((task.remaining?.length ?? 0) > 3) {
    issue(
      issues,
      "task.remaining",
      "max_items",
      "A task may contain at most 3 durable remaining items",
    );
  }
  if (task.finalEvidence !== undefined) {
    uniqueIds(issues, "task.finalEvidence", task.finalEvidence);
    for (const [index, evidence] of task.finalEvidence.entries()) {
      inspectProse(
        issues,
        `task.finalEvidence[${index}].statement`,
        evidence.statement,
        strict,
      );
    }
  }
  for (const [index, remaining] of (task.remaining ?? []).entries()) {
    inspectProse(issues, `task.remaining[${index}]`, remaining, strict);
  }
  if (task.resume !== undefined) {
    if (isTerminal(task.state)) {
      issue(
        issues,
        "task.resume",
        "resume_state",
        "Only active tasks may contain a resume capsule",
      );
    }
    const result = validateResumeCapsule(
      task.resume,
      task.checkpoints,
      options,
    );
    issues.push(...result.issues);
  }
  if (task.schema === "checkpoint/v2") {
    const criteria = task.acceptanceItems ?? [];
    if (criteria.length === 0 || criteria.length > 20)
      issue(
        issues,
        "task.acceptanceItems",
        "required",
        "A task requires 1–20 acceptance items",
      );
    uniqueIds(issues, "task.acceptanceItems", criteria);
    uniqueIds(issues, "task.evidence", task.evidence ?? []);
    if ((task.evidence?.length ?? 0) > 20)
      issue(
        issues,
        "task.evidence",
        "max_items",
        "At most 20 task evidence items are allowed",
      );
    for (const entry of task.evidence ?? []) {
      inspectProse(
        issues,
        `task.evidence.${entry.id}.statement`,
        entry.statement,
        strict,
      );
      if (
        ![
          "test",
          "artifact",
          "observation",
          "source",
          "user_acceptance",
        ].includes(entry.type)
      )
        issue(issues, "task.evidence", "enum", "Unknown evidence type");
    }
    const available = new Set((task.evidence ?? []).map((e) => e.id));
    for (const cp of task.checkpoints) {
      if (cp.status === "cancelled" || cp.status === "superseded") continue;
      for (const e of cp.outcome?.evidence ?? [])
        available.add(`${cp.id}/${e.id}`);
    }
    for (const item of criteria) {
      if (!["pending", "verified", "waived"].includes(item.status))
        issue(
          issues,
          "task.acceptanceItems",
          "enum",
          "Unknown acceptance status",
        );
      inspectProse(
        issues,
        `task.acceptanceItems.${item.id}.statement`,
        item.statement,
        strict,
      );
      if (item.status === "verified" && !item.evidenceRefs?.length)
        issue(
          issues,
          `task.acceptanceItems.${item.id}`,
          "acceptance_evidence",
          "Verified acceptance requires evidence references",
        );
      if (item.status === "waived" && !nonEmpty(item.waiverReason))
        issue(
          issues,
          `task.acceptanceItems.${item.id}`,
          "waiver_reason",
          "Waived acceptance requires a reason",
        );
      for (const ref of item.evidenceRefs ?? []) {
        if (!available.has(ref))
          issue(
            issues,
            `task.acceptanceItems.${item.id}`,
            "reference",
            `Unknown or inactive evidence reference: ${ref}`,
          );
      }
      if (
        task.state === "done" &&
        item.status === "pending" &&
        !task.legacyAcceptanceReview
      )
        issue(
          issues,
          `task.acceptanceItems.${item.id}`,
          "task_acceptance",
          `Acceptance ${item.id} is still pending`,
        );
    }
    if (task.archived && !isTerminal(task.state))
      issue(
        issues,
        "task.archived",
        "archive_state",
        "Complete or cancel a task before archiving it",
      );
    if (
      task.state === "blocked" &&
      (!nonEmpty(task.blocker) || !nonEmpty(task.unblockCondition))
    )
      issue(
        issues,
        "task.blocker",
        "blocked_reason",
        "Blocked tasks need a blocker and an unblock condition",
      );
    if (
      task.state !== "blocked" &&
      (task.blocker !== undefined || task.unblockCondition !== undefined)
    )
      issue(
        issues,
        "task.blocker",
        "state_field",
        "Only blocked tasks may contain blocker fields",
      );
  }
  return finish(issues);
}

export function assertValidCheckpoint(
  checkpoint: CheckpointCore,
  options: ValidationOptions = {},
): void {
  const result = validateCheckpoint(checkpoint, options);
  if (!result.valid) {
    throw qualityRejected(result.issues);
  }
}

export function assertValidTaskDocument(
  task: TaskDocument,
  options: ValidationOptions = {},
): void {
  const result = validateTaskDocument(task, options);
  if (!result.valid) {
    throw qualityRejected(result.issues);
  }
}
