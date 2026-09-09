import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { BoardConfig } from "../types.js";
import type {
  BoardCard,
  BoardColumn,
  BoardFrontmatter,
  ParsedBoard,
  WikiLink,
} from "./types.js";
import { stripLinkSubpath } from "./paths.js";

interface SourceLine {
  text: string;
  start: number;
  contentEnd: number;
  end: number;
  eol: string;
}

interface HeadingLine {
  lineIndex: number;
  heading: string;
  raw: string;
}

const CARD_PATTERN = /^([-*+])\s+\[([ xX])\](?:\s+(.*))?$/;
const HEADING_PATTERN = /^##(?!#)(?:[ \t]+)(.*)$/;

export function hashBoardSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function boardRevision(source: string): string {
  return `sha256:${hashBoardSource(source)}`;
}

export function parseBoard(source: string, config?: BoardConfig): ParsedBoard {
  const lines = scanLines(source);
  const frontmatter = parseFrontmatter(source, lines);
  const firstBodyLine = frontmatter
    ? lineIndexAtOrAfter(lines, frontmatter.endOffset)
    : 0;
  const { visible, settingsLine } = visibleBodyLines(lines, firstBodyLine);
  const bodyEnd = settingsLine < 0 ? source.length : lines[settingsLine]!.start;
  const headings = findColumnHeadings(lines, firstBodyLine, visible).filter(
    (heading) => lines[heading.lineIndex]!.start < bodyEnd,
  );
  const archiveHeading = headings.find(
    (heading) =>
      /^(?:archive|归档|存档)$/i.test(heading.heading) &&
      previousDivider(lines, heading.lineIndex) !== undefined,
  );
  const archiveStart =
    archiveHeading === undefined
      ? undefined
      : previousDivider(lines, archiveHeading.lineIndex);
  const parsedColumns = headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const headingLine = lines[heading.lineIndex];
    if (!headingLine) {
      throw new Error("Internal Kanban parser error: missing heading line");
    }
    const endOffset = nextHeading
      ? nextHeading === archiveHeading
        ? archiveStart!
        : lines[nextHeading.lineIndex]!.start
      : bodyEnd;
    const mapped = config?.columns.find(
      (column) => column.heading === heading.heading,
    );
    const cards = parseCards(
      source,
      lines,
      heading.lineIndex + 1,
      nextHeading?.lineIndex ??
        (settingsLine < 0 ? lines.length : settingsLine),
      heading.heading,
      mapped?.id,
      visible,
    );

    const column: BoardColumn = {
      heading: heading.heading,
      headingRaw: heading.raw,
      startOffset: headingLine.start,
      headingEndOffset: headingLine.end,
      bodyStartOffset: headingLine.end,
      endOffset,
      cards,
    };
    if (mapped) {
      column.id = mapped.id;
      column.typeId = mapped.typeId;
      column.profile = mapped.profile;
    }
    return column;
  });
  const hash = hashBoardSource(source);
  const parsed: ParsedBoard = {
    source,
    eol: source.includes("\r\n") ? "\r\n" : "\n",
    columns: parsedColumns.filter(
      (column) =>
        column.startOffset !==
        (archiveHeading === undefined
          ? -1
          : lines[archiveHeading.lineIndex]!.start),
    ),
    hash,
    revision: `sha256:${hash}`,
  };
  if (archiveHeading !== undefined) {
    parsed.archive = parsedColumns.find(
      (column) => column.startOffset === lines[archiveHeading.lineIndex]!.start,
    )!;
    parsed.archiveStartOffset = archiveStart!;
  }
  if (settingsLine >= 0) parsed.settingsStartOffset = bodyEnd;
  if (frontmatter) parsed.frontmatter = frontmatter;
  return parsed;
}

export function findFirstWikiLink(
  text: string,
  baseOffset = 0,
): WikiLink | undefined {
  const pattern = /\[\[([^\[\]\r\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    if (start > 0 && text[start - 1] === "!") continue;
    const inner = match[1];
    if (!inner) continue;
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim();
    const documentPath = stripLinkSubpath(target);
    if (!documentPath) continue;

    const link: WikiLink = {
      raw: match[0],
      target,
      documentPath,
      startOffset: baseOffset + start,
      endOffset: baseOffset + start + match[0].length,
    };
    if (alias)
      link.alias = alias
        .replaceAll("&#91;", "[")
        .replaceAll("&#93;", "]")
        .replaceAll("&#124;", "|")
        .replaceAll("&amp;", "&");
    return link;
  }
  return undefined;
}

function parseFrontmatter(
  source: string,
  lines: SourceLine[],
): BoardFrontmatter | undefined {
  const first = lines[0];
  if (!first || first.text.replace(/^\uFEFF/, "").trim() !== "---")
    return undefined;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !/^(?:---|\.\.\.)\s*$/.test(line.text)) continue;
    const yamlStart = first.end;
    const yamlEnd = line.start;
    const value: unknown = parseYaml(source.slice(yamlStart, yamlEnd));
    const data = isRecord(value) ? value : {};
    return {
      data,
      raw: source.slice(first.start, line.end),
      startOffset: first.start,
      endOffset: line.end,
    };
  }
  return undefined;
}

function findColumnHeadings(
  lines: SourceLine[],
  startIndex: number,
  visible: boolean[],
): HeadingLine[] {
  const headings: HeadingLine[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !visible[index]) continue;
    const match = HEADING_PATTERN.exec(line.text);
    const rawHeading = match?.[1];
    if (rawHeading === undefined) continue;
    const heading = rawHeading.replace(/[ \t]+#+[ \t]*$/, "").trim();
    if (!heading) continue;
    headings.push({ lineIndex: index, heading, raw: line.text });
  }
  return headings;
}

function parseCards(
  source: string,
  lines: SourceLine[],
  startIndex: number,
  endIndex: number,
  columnHeading: string,
  columnId: string | undefined,
  visible: boolean[],
): BoardCard[] {
  const cards: BoardCard[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (!line || !visible[index] || /^[ \t]/.test(line.text)) continue;
    const match = CARD_PATTERN.exec(line.text);
    if (!match) continue;

    const lastLineIndex = continuationEnd(lines, index, endIndex);
    const lastLine = lines[lastLineIndex] ?? line;
    const raw = source.slice(line.start, lastLine.end);
    const firstLine = source.slice(line.start, line.contentEnd);
    const card: BoardCard = {
      marker: match[1] as "-" | "*" | "+",
      checked: match[2]?.toLocaleLowerCase() === "x",
      text: match[3]?.trim() ?? "",
      raw,
      firstLine,
      continuation: source.slice(line.end, lastLine.end),
      startOffset: line.start,
      endOffset: lastLine.end,
      firstLineEndOffset: line.contentEnd,
      columnHeading,
    };
    if (columnId) card.columnId = columnId;
    const link = findFirstWikiLink(raw, line.start);
    if (link) card.link = link;
    cards.push(card);
    index = lastLineIndex;
  }
  return cards;
}

function previousDivider(
  lines: SourceLine[],
  index: number,
): number | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.text.trim()) continue;
    return /^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$/.test(
      line.text.trim(),
    )
      ? line.start
      : undefined;
  }
  return undefined;
}

function continuationEnd(
  lines: SourceLine[],
  cardLineIndex: number,
  endIndex: number,
): number {
  let last = cardLineIndex;
  let index = cardLineIndex + 1;
  while (index < endIndex) {
    const line = lines[index];
    if (!line) break;
    if (/^[ \t]+\S/.test(line.text)) {
      last = index;
      index += 1;
      continue;
    }
    if (/^[ \t]*$/.test(line.text)) {
      let lookahead = index + 1;
      while (
        lookahead < endIndex &&
        /^[ \t]*$/.test(lines[lookahead]?.text ?? "")
      ) {
        lookahead += 1;
      }
      const next = lines[lookahead];
      if (next && /^[ \t]+\S/.test(next.text)) {
        last = lookahead;
        index = lookahead + 1;
        continue;
      }
    }
    break;
  }
  return last;
}

/** Shared lexical mask keeps example cards/headings/settings inside code and comments inert. */
function visibleBodyLines(
  lines: SourceLine[],
  start: number,
): { visible: boolean[]; settingsLine: number } {
  const visible = lines.map(() => false);
  let fence = "",
    fenceLength = 0,
    comment: "percent" | "html" | undefined;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i]!.text;
    if (fence) {
      const close = /^[ \t]*(`+|~+)[ \t]*$/.exec(text)?.[1];
      if (close?.[0] === fence && close.length >= fenceLength) fence = "";
      continue;
    }
    if (comment) {
      if (comment === "html" && text.includes("-->")) comment = undefined;
      else if (comment === "percent" && (text.match(/%%/g)?.length ?? 0) % 2)
        comment = undefined;
      continue;
    }
    if (/^%%\s*kanban:settings\b/i.test(text.trim()))
      return { visible, settingsLine: i };
    const open = /^[ \t]*(`{3,}|~{3,})/.exec(text)?.[1];
    if (open) {
      fence = open[0]!;
      fenceLength = open.length;
      continue;
    }
    if (text.includes("<!--")) {
      if (!text.includes("-->", text.indexOf("<!--") + 4)) comment = "html";
      continue;
    }
    if (text.includes("%%")) {
      if ((text.match(/%%/g)?.length ?? 0) % 2) comment = "percent";
      continue;
    }
    visible[i] = true;
  }
  return { visible, settingsLine: -1 };
}

function scanLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) {
      lines.push({
        text: source.slice(start),
        start,
        contentEnd: source.length,
        end: source.length,
        eol: "",
      });
      start = source.length;
      break;
    }
    const contentEnd =
      newline > start && source[newline - 1] === "\r" ? newline - 1 : newline;
    const eol = contentEnd === newline ? "\n" : "\r\n";
    lines.push({
      text: source.slice(start, contentEnd),
      start,
      contentEnd,
      end: newline + 1,
      eol,
    });
    start = newline + 1;
  }
  if (source.length === 0 || source.endsWith("\n")) {
    lines.push({
      text: "",
      start: source.length,
      contentEnd: source.length,
      end: source.length,
      eol: "",
    });
  }
  return lines;
}

function lineIndexAtOrAfter(lines: SourceLine[], offset: number): number {
  const index = lines.findIndex((line) => line.start >= offset);
  return index === -1 ? lines.length : index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
