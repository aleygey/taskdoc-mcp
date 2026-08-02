export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function escapeHeading(value: string): string {
  return oneLine(value).replace(/(^|\s)#/g, "$1\\#");
}

export function escapeBackticks(value: string): string {
  return oneLine(value).replace(/`/g, "\\`");
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
