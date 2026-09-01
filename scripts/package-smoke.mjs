import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const report = JSON.parse(execFileSync(
  npm,
  ["pack", "--json", "--dry-run", "--ignore-scripts"],
  { cwd: new URL("..", import.meta.url), encoding: "utf8" },
));

if (!Array.isArray(report) || report.length !== 1) {
  throw new Error("npm pack did not return exactly one package report");
}

const packedFiles = new Set(report[0].files.map((file) => file.path));
for (const [binName, binPath] of Object.entries(packageJson.bin)) {
  if (!packedFiles.has(binPath)) {
    throw new Error(`packed artifact is missing ${binName} bin target: ${binPath}`);
  }
}

for (const required of ["README.md", "README_CN.md", "LICENSE", "package.json"]) {
  if (!packedFiles.has(required)) {
    throw new Error(`packed artifact is missing required file: ${required}`);
  }
}

const cliVersion = execFileSync(
  process.execPath,
  [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "--version"],
  { encoding: "utf8" },
).trim();
if (cliVersion !== packageJson.version) {
  throw new Error(`CLI version ${cliVersion} does not match package version ${packageJson.version}`);
}

console.log(`package smoke passed: ${packedFiles.size} files, CLI ${cliVersion}`);
