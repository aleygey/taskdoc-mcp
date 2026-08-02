import { createHash, randomUUID } from "node:crypto";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createStableId(): string {
  return randomUUID();
}

export const uuid = createStableId;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalValue(entry));
  }

  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        output[key] = canonicalValue(entry);
      }
    }
    return output;
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function encodeBase64Json(value: unknown): string {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}

export function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}
