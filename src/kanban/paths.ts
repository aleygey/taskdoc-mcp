export function normalizeVaultPath(path: string): string {
  const candidate = path.trim();
  if (/^(?:[a-zA-Z]:[\\/]|[\\/]{1,2})/.test(candidate)) {
    throw new Error(`Expected a vault-relative path: ${path}`);
  }
  const normalized = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");

  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Invalid vault-relative path: ${path}`);
  }

  return normalized;
}

export function taskDocumentPath(path: string): string {
  const normalized = normalizeVaultPath(stripLinkSubpath(path));
  return normalized.toLocaleLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

export function taskLinkTarget(path: string): string {
  const normalized = normalizeVaultPath(stripLinkSubpath(path));
  return normalized.toLocaleLowerCase().endsWith(".md") ? normalized.slice(0, -3) : normalized;
}

export function taskPathIdentity(path: string): string {
  return taskLinkTarget(path).normalize("NFC").toLowerCase();
}

export function stripLinkSubpath(target: string): string {
  const hash = target.indexOf("#");
  return (hash === -1 ? target : target.slice(0, hash)).trim();
}
