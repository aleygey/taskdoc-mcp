import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const releaseRoot = path.resolve(root, "release");
const pluginDir = path.join(releaseRoot, "taskdoc-mcp");
const archive = path.join(releaseRoot, `taskdoc-mcp-${manifest.version}.zip`);

if (!releaseRoot.startsWith(path.resolve(root) + path.sep)) {
  throw new Error("Release path escaped the repository root.");
}

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await cp(path.join(root, file), path.join(pluginDir, file));
}

if (process.platform === "win32") {
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${pluginDir.replaceAll("'", "''")}\\*' -DestinationPath '${archive.replaceAll("'", "''")}' -Force`
  ], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-q", "-r", archive, "."], { cwd: pluginDir, stdio: "inherit" });
}

console.log(archive);
