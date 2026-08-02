import type { BoardConfig } from "../types.js";
import {
  BoardCardNotFoundError,
  BoardColumnNotFoundError,
  BoardRevisionConflictError,
  DuplicateBoardCardError
} from "./errors.js";
import { findFirstWikiLink, parseBoard } from "./parser.js";
import { taskLinkTarget, taskPathIdentity } from "./paths.js";
import type { BoardCard } from "./types.js";

export interface PureCreateCardInput {
  columnId: string;
  taskPath: string;
  title: string;
  checked?: boolean;
  indentedLines?: string[];
  expectedRevision?: string;
}

export interface PureUpdateCardInput {
  taskPath: string;
  columnId?: string;
  checked?: boolean;
  title?: string;
  expectedRevision?: string;
}

export function createLinkedCard(
  source: string,
  config: BoardConfig,
  input: PureCreateCardInput
): string {
  const board = parseBoard(source, config);
  assertRevision(board.revision, input.expectedRevision);
  const matchingCards = findTaskCards(board.columns.flatMap((column) => column.cards), input.taskPath);
  if (matchingCards.length > 0) throw new DuplicateBoardCardError(input.taskPath);
  const column = board.columns.find((candidate) => candidate.id === input.columnId);
  if (!column) throw new BoardColumnNotFoundError(config.id, input.columnId);
  const block = formatLinkedCard(input, board.eol);
  return insertCardBlock(source, column.endOffset, block, board.eol);
}

export function updateLinkedCard(
  source: string,
  config: BoardConfig,
  input: PureUpdateCardInput
): string {
  const board = parseBoard(source, config);
  assertRevision(board.revision, input.expectedRevision);
  const matchingCards = findTaskCards(board.columns.flatMap((column) => column.cards), input.taskPath);
  if (matchingCards.length === 0) throw new BoardCardNotFoundError(input.taskPath);
  if (matchingCards.length > 1) throw new DuplicateBoardCardError(input.taskPath);
  const card = matchingCards[0];
  if (!card) throw new BoardCardNotFoundError(input.taskPath);
  const updatedRaw = updateCardBlock(card.raw, input);

  if (!input.columnId || input.columnId === card.columnId) {
    return replaceRange(source, card.startOffset, card.endOffset, updatedRaw);
  }

  const target = board.columns.find((column) => column.id === input.columnId);
  if (!target) throw new BoardColumnNotFoundError(config.id, input.columnId);

  const withoutCard = replaceRange(source, card.startOffset, card.endOffset, "");
  const reparsed = parseBoard(withoutCard, config);
  const reparsedTarget = reparsed.columns.find((column) => column.id === input.columnId);
  if (!reparsedTarget) throw new BoardColumnNotFoundError(config.id, input.columnId);
  return insertCardBlock(withoutCard, reparsedTarget.endOffset, updatedRaw, reparsed.eol);
}

export function setLinkedCardChecked(
  source: string,
  config: BoardConfig,
  taskPath: string,
  checked: boolean,
  expectedRevision?: string
): string {
  const input: PureUpdateCardInput = { taskPath, checked };
  if (expectedRevision) input.expectedRevision = expectedRevision;
  return updateLinkedCard(source, config, input);
}

export function moveLinkedCard(
  source: string,
  config: BoardConfig,
  taskPath: string,
  columnId: string,
  expectedRevision?: string
): string {
  const input: PureUpdateCardInput = { taskPath, columnId };
  if (expectedRevision) input.expectedRevision = expectedRevision;
  return updateLinkedCard(source, config, input);
}

function formatLinkedCard(input: PureCreateCardInput, eol: string): string {
  const checkbox = input.checked ? "x" : " ";
  const target = escapeWikiLinkPart(taskLinkTarget(input.taskPath));
  const title = escapeWikiLinkPart(input.title.trim());
  const lines = [`- [${checkbox}] [[${target}|${title}]]`];
  for (const value of input.indentedLines ?? []) {
    for (const logicalLine of value.replaceAll("\r\n", "\n").split("\n")) {
      lines.push(/^[ \t]/.test(logicalLine) || logicalLine.length === 0 ? logicalLine : `  ${logicalLine}`);
    }
  }
  return `${lines.join(eol)}${eol}`;
}

function updateCardBlock(raw: string, input: PureUpdateCardInput): string {
  let updated = raw;
  if (input.checked !== undefined) {
    updated = updated.replace(
      /^(\s*[-*+]\s+\[)[ xX](\])/,
      `$1${input.checked ? "x" : " "}$2`
    );
  }
  if (input.title !== undefined) {
    const link = findFirstWikiLink(updated);
    if (!link) throw new BoardCardNotFoundError(input.taskPath);
    const replacement = `[[${escapeWikiLinkPart(link.target)}|${escapeWikiLinkPart(input.title.trim())}]]`;
    updated = replaceRange(updated, link.startOffset, link.endOffset, replacement);
  }
  return updated;
}

function insertCardBlock(source: string, offset: number, rawBlock: string, eol: string): string {
  const before = source.slice(0, offset);
  const after = source.slice(offset);
  const normalizedBlock = normalizeEol(rawBlock, eol).replace(/(?:\r?\n)*$/, eol);
  const leading = before.length === 0 || before.endsWith(`${eol}${eol}`)
    ? ""
    : before.endsWith(eol)
      ? eol
      : `${eol}${eol}`;
  const trailing = after.length === 0 || after.startsWith(eol) ? "" : eol;
  return `${before}${leading}${normalizedBlock}${trailing}${after}`;
}

function findTaskCards(cards: BoardCard[], taskPath: string): BoardCard[] {
  const identity = taskPathIdentity(taskPath);
  return cards.filter((card) => card.link && taskPathIdentity(card.link.documentPath) === identity);
}

function assertRevision(actual: string, expected: string | undefined): void {
  if (expected !== undefined && expected !== actual) {
    throw new BoardRevisionConflictError(expected, actual);
  }
}

function escapeWikiLinkPart(value: string): string {
  return value.replaceAll("|", "-").replaceAll("]]", "]");
}

function replaceRange(source: string, start: number, end: number, replacement: string): string {
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function normalizeEol(value: string, eol: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\n", eol);
}
