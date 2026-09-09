import { stringify as stringifyYaml } from "yaml";
import type { BlockKind, BlockManifest } from "../types";
import type { ValidationIssue } from "./errors";
import { qualityRejected } from "./errors";
import { sha256 } from "./crypto";
import {
  DEFAULT_VALIDATION_LIMITS,
  type ValidationOptions,
  type ValidationResult,
} from "./validation";
import {
  escapeHeading,
  nonEmpty,
  normalizeNewlines,
  oneLine,
  unicodeLength,
} from "./text";

export type ChecklistScope =
  | "acceptance"
  | "compatibility"
  | "deployment"
  | "test_matrix"
  | "production_check";

export interface RichBlockInput {
  id: string;
  revision: number;
  kind: BlockKind;
  title: string;
  summary: string;
  supports: BlockManifest["supports"];
  content: string;
  path: string;
  checklistScope?: ChecklistScope;
  sourceUri?: string;
  language?: string;
}

function result(
  issues: ValidationIssue[],
  renderedChars: number,
): ValidationResult {
  const errors = issues.filter((entry) => entry.severity === "error");
  const warnings = issues.filter((entry) => entry.severity === "warning");
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
    renderedChars,
  };
}

function add(
  issues: ValidationIssue[],
  path: string,
  rule: string,
  message: string,
): void {
  issues.push({ path, rule, message, severity: "error" });
}

function validMarkdownTable(content: string): boolean {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;
  const separator = lines[1];
  if (
    separator === undefined ||
    !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)
  ) {
    return false;
  }
  const count = (line: string): number => (line.match(/\|/g) ?? []).length;
  const width = count(lines[0] ?? "");
  return width >= 2 && lines.every((line) => count(line) === width);
}

function validMermaid(content: string): boolean {
  const raw = content
    .replace(/^```mermaid\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return /^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|timeline|journey|classDiagram|mindmap|pie|gitGraph|quadrantChart|xychart-beta|block-beta|architecture-beta)\b/m.test(
    raw,
  );
}

export function validateRichBlock(
  block: RichBlockInput,
  options: ValidationOptions = {},
): ValidationResult {
  const limit =
    options.blockCharLimit ??
    options.limits?.blockCharLimit ??
    DEFAULT_VALIDATION_LIMITS.blockCharLimit;
  const issues: ValidationIssue[] = [];
  const content = normalizeNewlines(block.content).trim();
  const chars = unicodeLength(content);

  if (
    !nonEmpty(block.id) ||
    !nonEmpty(block.title) ||
    !nonEmpty(block.summary) ||
    !nonEmpty(block.path)
  ) {
    add(
      issues,
      "block",
      "required",
      "Rich block requires id, title, summary, and path",
    );
  }
  if (!Number.isInteger(block.revision) || block.revision < 1) {
    add(
      issues,
      "block.revision",
      "revision",
      "Rich block revision must be a positive integer",
    );
  }
  if (!nonEmpty(content)) {
    add(
      issues,
      "block.content",
      "required",
      "Rich block content must not be empty",
    );
  }
  if (chars > limit) {
    add(
      issues,
      "block.content",
      "block_size",
      `Rich block exceeds ${limit} characters`,
    );
  }
  if (unicodeLength(block.title) > 80 || unicodeLength(block.summary) > 240) {
    add(
      issues,
      "block",
      "metadata_size",
      "Rich block title or summary is too long",
    );
  }
  if (
    block.kind !== "code_or_config" &&
    /(^|\n)\s*(?:user|assistant|system|agent|用户|助手|系统|智能体)\s*[:：]/iu.test(
      content,
    ) &&
    /(^|\n)\s*(?:assistant|助手)\s*[:：]/iu.test(content) &&
    /(^|\n)\s*(?:user|用户)\s*[:：]/iu.test(content)
  ) {
    add(
      issues,
      "block.content",
      "conversation",
      "Rich block cannot contain a chat transcript",
    );
  }

  if (block.kind === "data_table" && !validMarkdownTable(content)) {
    add(
      issues,
      "block.content",
      "data_table",
      "data_table content must be a valid Markdown table",
    );
  }
  if (block.kind === "mermaid" && !validMermaid(content)) {
    add(
      issues,
      "block.content",
      "mermaid",
      "mermaid content must start with a supported diagram declaration",
    );
  }
  if (block.kind === "domain_checklist") {
    if (block.checklistScope === undefined) {
      add(
        issues,
        "block.checklistScope",
        "checklist_scope",
        "domain_checklist requires a durable checklist scope",
      );
    }
    if (!/^\s*[-*]\s+\[[ xX]\]\s+/m.test(content)) {
      add(
        issues,
        "block.content",
        "domain_checklist",
        "domain_checklist requires Markdown checklist items",
      );
    }
  }
  if (block.kind === "code_or_config" && !nonEmpty(block.language)) {
    add(
      issues,
      "block.language",
      "language",
      "code_or_config requires a language",
    );
  }
  if (block.kind === "source_reference" && !nonEmpty(block.sourceUri)) {
    add(
      issues,
      "block.sourceUri",
      "source_uri",
      "source_reference requires a source URI",
    );
  }

  return result(issues, chars);
}

export function assertValidRichBlock(
  block: RichBlockInput,
  options: ValidationOptions = {},
): void {
  const validation = validateRichBlock(block, options);
  if (!validation.valid) throw qualityRejected(validation.issues);
}

function renderContent(block: RichBlockInput): string {
  const content = normalizeNewlines(block.content).trim();
  if (block.kind === "mermaid" && !/^```mermaid/m.test(content)) {
    return `\`\`\`mermaid\n${content}\n\`\`\``;
  }
  if (block.kind === "code_or_config" && !/^```/m.test(content)) {
    return `\`\`\`${oneLine(block.language ?? "text")}\n${content}\n\`\`\``;
  }
  return content;
}

export function renderRichBlock(
  block: RichBlockInput,
  options: ValidationOptions = {},
): string {
  assertValidRichBlock(block, options);
  const metadata: Record<string, unknown> = {
    taskdoc_block: "rich/v1",
    block_id: block.id,
    revision: block.revision,
    kind: block.kind,
    supports: block.supports,
    summary: block.summary,
  };
  if (block.checklistScope !== undefined)
    metadata.checklist_scope = block.checklistScope;
  if (block.sourceUri !== undefined) metadata.source_uri = block.sourceUri;
  if (block.language !== undefined) metadata.language = block.language;
  const frontmatter = stringifyYaml(metadata, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n\n# ${escapeHeading(block.title)}\n\n${renderContent(block)}\n`;
}

export function richBlockHash(
  block: RichBlockInput,
  options: ValidationOptions = {},
): string {
  return sha256(renderRichBlock(block, options));
}

export function createBlockManifest(
  block: RichBlockInput,
  options: ValidationOptions = {},
): BlockManifest {
  return {
    id: block.id,
    kind: block.kind,
    title: block.title,
    summary: block.summary,
    supports: block.supports,
    path: block.path,
    chars: unicodeLength(normalizeNewlines(block.content).trim()),
    contentHash: richBlockHash(block, options),
    revision: block.revision,
  };
}
