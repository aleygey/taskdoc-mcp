import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CheckpointCore, Evidence, ResumeCapsule, TaskDocument } from "../types";
import { canonicalJson, decodeBase64Json, encodeBase64Json, sha256 } from "./crypto";
import { TaskDocError, malformedDocument } from "./errors";
import { renderCheckpointCore, renderResumeCallout } from "./renderer";
import { normalizeNewlines, nonEmpty, oneLine } from "./text";
import {
  assertValidCheckpoint,
  assertValidTaskDocument,
  type ValidationOptions
} from "./validation";

const CHECKPOINT_MARKER_PATTERN = /<!-- taskdoc-checkpoint:v1:([A-Za-z0-9_-]+) -->/g;
const RESUME_MARKER_PATTERN = /<!-- taskdoc-resume:v1:([A-Za-z0-9_-]+) -->/g;
const READ_VALIDATION_OPTIONS: ValidationOptions = {
  strictQuality: false,
  coreCharLimit: Number.MAX_SAFE_INTEGER,
  blockCharLimit: Number.MAX_SAFE_INTEGER,
  totalBlockCharLimit: Number.MAX_SAFE_INTEGER,
  resumeCharLimit: Number.MAX_SAFE_INTEGER,
  maxBlocksPerCheckpoint: Number.MAX_SAFE_INTEGER
};

interface CheckpointMarkerPayload {
  type: "checkpoint";
  version: 1;
  renderHash: string;
  checkpoint: CheckpointCore;
}

interface ResumeMarkerPayload {
  type: "resume";
  version: 1;
  renderHash: string;
  resume: ResumeCapsule;
}

export interface DocumentConflict {
  scope: "document" | "checkpoint" | "resume";
  id?: string;
  expectedHash: string;
  actualHash: string;
}

export interface ParsedTaskDocument {
  task: TaskDocument;
  documentHash: string;
  storedDocumentHash: string;
  checkpointHashes: Readonly<Record<string, string>>;
  conflicts: readonly DocumentConflict[];
}

export interface ParseOptions {
  allowConflicts?: boolean;
}

export interface MutationOptions {
  expectedDocumentHash?: string;
  expectedRevision?: number;
  expectedCheckpointRevision?: number;
  updatedAt?: string;
  path?: string;
}

export interface DocumentMutationResult extends ParsedTaskDocument {
  content: string;
  noop: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw malformedDocument(`Frontmatter field ${key} must be a string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw malformedDocument(`Frontmatter field ${key} must be a string`);
  return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw malformedDocument(`Frontmatter field ${key} must be a string array`);
  }
  return [...value] as string[];
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  if (record[key] === undefined || record[key] === null) return undefined;
  return stringArray(record, key);
}

function optionalEvidenceArray(record: Record<string, unknown>, key: string): Evidence[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) =>
    !isRecord(entry) || typeof entry.id !== "string" || typeof entry.type !== "string" ||
    typeof entry.statement !== "string" || (entry.ref !== undefined && typeof entry.ref !== "string")
  )) {
    throw malformedDocument(`Frontmatter field ${key} must be an evidence array`);
  }
  return value as Evidence[];
}

function positiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw malformedDocument(`Frontmatter field ${key} must be a positive integer`);
  }
  return value as number;
}

function parseFrontmatter(markdown: string): { metadata: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown);
  if (match === null) throw malformedDocument("Task document is missing YAML frontmatter");
  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;
    if (!isRecord(parsed)) throw malformedDocument("Task frontmatter must be a mapping");
    return { metadata: parsed, body: markdown.slice(match[0].length).replace(/^\n/, "") };
  } catch (error) {
    if (error instanceof TaskDocError) throw error;
    throw malformedDocument("Task frontmatter is invalid YAML", error);
  }
}

function withoutDocumentHash(markdown: string): string {
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) return markdown;
  const frontmatter = markdown.slice(0, end).replace(/^document_hash:[^\n]*(?:\n|$)/m, "");
  return frontmatter + markdown.slice(end);
}

export function computeDocumentHash(markdown: string): string {
  return sha256(withoutDocumentHash(normalizeNewlines(markdown)));
}

function markerLine(kind: "checkpoint" | "resume", value: unknown): string {
  return `<!-- taskdoc-${kind}:v1:${encodeBase64Json(value)} -->`;
}

function renderCheckpointWithMarker(checkpoint: CheckpointCore, index: number): string {
  const visible = renderCheckpointCore(checkpoint, index);
  const payload: CheckpointMarkerPayload = {
    type: "checkpoint",
    version: 1,
    renderHash: sha256(visible),
    checkpoint
  };
  const firstBreak = visible.indexOf("\n");
  return firstBreak < 0
    ? `${visible}\n${markerLine("checkpoint", payload)}`
    : `${visible.slice(0, firstBreak)}\n${markerLine("checkpoint", payload)}${visible.slice(firstBreak)}`;
}

function renderResumeWithMarker(resume: ResumeCapsule, checkpoints: readonly CheckpointCore[]): string {
  const visible = renderResumeCallout(resume, checkpoints);
  const payload: ResumeMarkerPayload = {
    type: "resume",
    version: 1,
    renderHash: sha256(visible),
    resume
  };
  return `${markerLine("resume", payload)}\n${visible}`;
}

function renderBody(task: TaskDocument): string {
  const lines = [
    `# ${task.title.replace(/\s+/g, " ").trim()}`,
    "",
    `> 目标：${oneLine(task.objective)}`,
    "> 验收：",
    ...task.acceptance.map((entry) => `> - ${oneLine(entry)}`)
  ];
  if (task.finalOutcome !== undefined) {
    lines.push(`> 最终结果：${oneLine(task.finalOutcome)}`);
  }
  for (const evidence of task.finalEvidence ?? []) {
    const ref = evidence.ref === undefined ? "" : `（${oneLine(evidence.ref)}）`;
    lines.push(`> 最终证据（${evidence.type}，${oneLine(evidence.id)}）${ref}：${oneLine(evidence.statement)}`);
  }
  for (const remaining of task.remaining ?? []) {
    lines.push(`> 剩余事项：${oneLine(remaining)}`);
  }
  if (task.resume !== undefined) {
    lines.push("", renderResumeWithMarker(task.resume, task.checkpoints));
  }
  for (const [index, checkpoint] of task.checkpoints.entries()) {
    lines.push("", renderCheckpointWithMarker(checkpoint, index + 1));
  }
  return lines.join("\n").trimEnd();
}

function frontmatterFor(task: TaskDocument, documentHash?: string): Record<string, unknown> {
  return {
    task_schema: task.schema,
    task_id: task.taskId,
    board_id: task.boardId,
    column_id: task.columnId,
    title: task.title,
    state: task.state,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    objective: task.objective,
    acceptance: task.acceptance,
    ...(task.finalOutcome === undefined ? {} : { final_outcome: task.finalOutcome }),
    ...(task.finalEvidence === undefined ? {} : { final_evidence: task.finalEvidence }),
    ...(task.remaining === undefined ? {} : { remaining: task.remaining }),
    ...(task.phaTaskId === undefined ? {} : { pha_task_id: task.phaTaskId }),
    task_path: task.path,
    revision: task.revision,
    ...(documentHash === undefined ? {} : { document_hash: documentHash })
  };
}

function assemble(task: TaskDocument, documentHash?: string): string {
  const yaml = stringifyYaml(frontmatterFor(task, documentHash), { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${renderBody(task)}\n`;
}

function decodeCheckpointMarker(encoded: string): CheckpointMarkerPayload {
  try {
    const value = decodeBase64Json(encoded);
    if (!isRecord(value) || value.type !== "checkpoint" || value.version !== 1 ||
        typeof value.renderHash !== "string" || !isRecord(value.checkpoint) ||
        !isRecord(value.checkpoint.objective) || !Array.isArray(value.checkpoint.objective.acceptance) ||
        !Array.isArray(value.checkpoint.blocks)) {
      throw new Error("Unexpected checkpoint marker payload");
    }
    return value as unknown as CheckpointMarkerPayload;
  } catch (error) {
    throw malformedDocument("Checkpoint marker contains invalid base64 JSON", error);
  }
}

function decodeResumeMarker(encoded: string): ResumeMarkerPayload {
  try {
    const value = decodeBase64Json(encoded);
    if (!isRecord(value) || value.type !== "resume" || value.version !== 1 ||
        typeof value.renderHash !== "string" || !isRecord(value.resume) ||
        !Array.isArray(value.resume.blockers) || !Array.isArray(value.resume.openQuestions) ||
        !Array.isArray(value.resume.workingArtifacts)) {
      throw new Error("Unexpected resume marker payload");
    }
    return value as unknown as ResumeMarkerPayload;
  } catch (error) {
    throw malformedDocument("Resume marker contains invalid base64 JSON", error);
  }
}

function removeMarker(section: string, marker: string): string {
  return section.replace(`${marker}\n`, "").trimEnd();
}

function semanticCheckpoint(checkpoint: CheckpointCore): unknown {
  const { revision: _revision, ...rest } = checkpoint;
  return rest;
}

export class DocumentCodec {
  readonly validationOptions: ValidationOptions;

  constructor(options: ValidationOptions = {}) {
    this.validationOptions = options;
  }

  create(task: TaskDocument): string {
    assertValidTaskDocument(task, this.validationOptions);
    const hash = computeDocumentHash(assemble(task, "0".repeat(64)));
    return assemble(task, hash);
  }

  render(task: TaskDocument): string {
    return this.create(task);
  }

  parse(markdown: string, path?: string, options: ParseOptions = {}): ParsedTaskDocument {
    const content = normalizeNewlines(markdown);
    const { metadata, body } = parseFrontmatter(content);
    const storedDocumentHash = stringValue(metadata, "document_hash");
    const documentHash = computeDocumentHash(content);
    const conflicts: DocumentConflict[] = [];
    if (storedDocumentHash !== documentHash) {
      conflicts.push({ scope: "document", expectedHash: storedDocumentHash, actualHash: documentHash });
    }

    const checkpointHashes: Record<string, string> = {};
    const checkpoints: CheckpointCore[] = [];
    const headings = [...body.matchAll(/^##\s+.+$/gm)];
    for (const [index, heading] of headings.entries()) {
      const start = heading.index ?? 0;
      const next = headings[index + 1];
      const section = body.slice(start, next?.index ?? body.length).trimEnd();
      const markers = [...section.matchAll(CHECKPOINT_MARKER_PATTERN)];
      if (markers.length !== 1) {
        throw malformedDocument("Each checkpoint section must contain exactly one managed marker");
      }
      const marker = markers[0];
      if (marker === undefined || marker[1] === undefined) throw malformedDocument("Checkpoint marker is malformed");
      const payload = decodeCheckpointMarker(marker[1]);
      const visible = removeMarker(section, marker[0]);
      const actualHash = sha256(visible);
      checkpointHashes[payload.checkpoint.id] = actualHash;
      if (payload.renderHash !== actualHash) {
        conflicts.push({
          scope: "checkpoint",
          id: payload.checkpoint.id,
          expectedHash: payload.renderHash,
          actualHash
        });
      }
      checkpoints.push(payload.checkpoint);
    }

    let resume: ResumeCapsule | undefined;
    const resumeMarkers = [...body.matchAll(RESUME_MARKER_PATTERN)];
    if (resumeMarkers.length > 1) throw malformedDocument("Task document contains multiple resume markers");
    const resumeMarker = resumeMarkers[0];
    if (resumeMarker !== undefined) {
      const encoded = resumeMarker[1];
      if (encoded === undefined) throw malformedDocument("Resume marker is malformed");
      const payload = decodeResumeMarker(encoded);
      resume = payload.resume;
      const after = body.slice((resumeMarker.index ?? 0) + resumeMarker[0].length).replace(/^\n/, "");
      const callout = after.split(/\n\n|\n(?=##\s)/, 1)[0]?.trimEnd() ?? "";
      const actualHash = sha256(callout);
      if (payload.renderHash !== actualHash) {
        conflicts.push({ scope: "resume", expectedHash: payload.renderHash, actualHash });
      }
    }

    const schema = stringValue(metadata, "task_schema");
    const state = stringValue(metadata, "state");
    if (schema !== "checkpoint/v1" || !["active", "done", "archived"].includes(state)) {
      throw malformedDocument("Task schema or state is unsupported");
    }
    const finalOutcome = optionalString(metadata, "final_outcome");
    const finalEvidence = optionalEvidenceArray(metadata, "final_evidence");
    const remaining = optionalStringArray(metadata, "remaining");
    const phaTaskId = optionalString(metadata, "pha_task_id");
    const task: TaskDocument = {
      schema,
      taskId: stringValue(metadata, "task_id"),
      boardId: stringValue(metadata, "board_id"),
      columnId: stringValue(metadata, "column_id"),
      title: stringValue(metadata, "title"),
      state: state as TaskDocument["state"],
      createdAt: stringValue(metadata, "created_at"),
      updatedAt: stringValue(metadata, "updated_at"),
      objective: stringValue(metadata, "objective"),
      acceptance: stringArray(metadata, "acceptance"),
      ...(finalOutcome === undefined ? {} : { finalOutcome }),
      ...(finalEvidence === undefined ? {} : { finalEvidence }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(phaTaskId === undefined ? {} : { phaTaskId }),
      ...(resume === undefined ? {} : { resume }),
      checkpoints,
      path: path ?? optionalString(metadata, "task_path") ?? "",
      revision: positiveInteger(metadata, "revision")
    };
    // Reading verifies the schema, references, lifecycle and managed hashes,
    // but must not make old documents disappear when current write policy is
    // tightened in settings.
    assertValidTaskDocument(task, READ_VALIDATION_OPTIONS);

    if (conflicts.length > 0 && options.allowConflicts !== true) {
      throw new TaskDocError("DOCUMENT_CONFLICT", "Task document was modified outside its managed structure", {
        details: { conflicts }
      });
    }
    return { task, documentHash, storedDocumentHash, checkpointHashes, conflicts };
  }

  parseTask(markdown: string, path?: string, options: ParseOptions = {}): TaskDocument {
    return this.parse(markdown, path, options).task;
  }

  createCheckpoint(
    markdown: string,
    checkpoint: CheckpointCore,
    options: MutationOptions = {}
  ): DocumentMutationResult {
    const parsed = this.parse(markdown, options.path);
    this.assertExpected(parsed, options);
    if (parsed.task.checkpoints.some((entry) => entry.id === checkpoint.id)) {
      throw new TaskDocError("INVALID_INPUT", `Checkpoint already exists: ${checkpoint.id}`);
    }
    assertValidCheckpoint(checkpoint, this.validationOptions);
    const nextTask: TaskDocument = {
      ...parsed.task,
      checkpoints: [...parsed.task.checkpoints, checkpoint],
      updatedAt: options.updatedAt ?? new Date().toISOString(),
      revision: parsed.task.revision + 1
    };
    return this.mutation(nextTask, false);
  }

  replaceCheckpoint(
    markdown: string,
    replacement: CheckpointCore,
    options: MutationOptions = {}
  ): DocumentMutationResult {
    const parsed = this.parse(markdown, options.path);
    this.assertExpected(parsed, options);
    const index = parsed.task.checkpoints.findIndex((entry) => entry.id === replacement.id);
    if (index < 0) throw new TaskDocError("CHECKPOINT_NOT_FOUND", `Checkpoint not found: ${replacement.id}`);
    const current = parsed.task.checkpoints[index];
    if (current === undefined) throw new TaskDocError("CHECKPOINT_NOT_FOUND", `Checkpoint not found: ${replacement.id}`);
    const expectedRevision = options.expectedCheckpointRevision ?? options.expectedRevision;
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw new TaskDocError("VERSION_CONFLICT", "Checkpoint revision changed", {
        details: { expectedRevision, actualRevision: current.revision, checkpointId: current.id }
      });
    }
    if (canonicalJson(semanticCheckpoint(current)) === canonicalJson(semanticCheckpoint(replacement))) {
      return { ...parsed, content: markdown, noop: true };
    }
    const nextCheckpoint: CheckpointCore = { ...replacement, revision: current.revision + 1 };
    assertValidCheckpoint(nextCheckpoint, this.validationOptions);
    const checkpoints = [...parsed.task.checkpoints];
    checkpoints[index] = nextCheckpoint;
    let resume = parsed.task.resume;
    if (resume?.focusCheckpointId === nextCheckpoint.id) resume = undefined;
    const { resume: _oldResume, ...taskWithoutResume } = parsed.task;
    const nextTask: TaskDocument = {
      ...taskWithoutResume,
      checkpoints,
      ...(resume === undefined ? {} : { resume }),
      updatedAt: options.updatedAt ?? new Date().toISOString(),
      revision: parsed.task.revision + 1
    };
    return this.mutation(nextTask, false);
  }

  replaceResume(
    markdown: string,
    resume: ResumeCapsule | undefined,
    options: MutationOptions = {}
  ): DocumentMutationResult {
    const parsed = this.parse(markdown, options.path);
    this.assertExpected(parsed, options);
    if (canonicalJson(parsed.task.resume) === canonicalJson(resume)) {
      return { ...parsed, content: markdown, noop: true };
    }
    const { resume: _oldResume, ...taskWithoutResume } = parsed.task;
    const nextTask: TaskDocument = {
      ...taskWithoutResume,
      ...(resume === undefined ? {} : { resume }),
      updatedAt: options.updatedAt ?? new Date().toISOString(),
      revision: parsed.task.revision + 1
    };
    return this.mutation(nextTask, false);
  }

  clearResume(markdown: string, options: MutationOptions = {}): DocumentMutationResult {
    return this.replaceResume(markdown, undefined, options);
  }

  private mutation(task: TaskDocument, noop: boolean): DocumentMutationResult {
    const content = this.create(task);
    return { ...this.parse(content, task.path), content, noop };
  }

  private assertExpected(parsed: ParsedTaskDocument, options: MutationOptions): void {
    if (options.expectedDocumentHash !== undefined && options.expectedDocumentHash !== parsed.documentHash) {
      throw new TaskDocError("VERSION_CONFLICT", "Task document hash changed", {
        details: { expectedHash: options.expectedDocumentHash, actualHash: parsed.documentHash }
      });
    }
  }
}
