import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "README.md", "LICENSE", "NOTICE.md", "SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md", ".mcp.json", ".gitattributes",
  "package.json", "package-lock.json", "Configure-MS-MCP.bat", "Install-MS-MCP.bat",
  "Test-MS-MCP.bat", "Run-MS-MCP.bat", "Start-MS-MCP-Dashboard.bat",
  "config/ms-mcp.example.bat", "docs/INSTALLATION.zh-CN.md", "src/index.js",
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Required release file is missing: ${relative}`);
}

const jsFiles = [];
for (const folder of ["src", "scripts", "GUI-Dashboard"]) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) jsFiles.push(full);
    }
  };
  walk(path.join(root, folder));
}
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Syntax check failed for ${path.relative(root, file)}\n${result.stderr}`);
}

const excluded = ["node_modules", "workspace", "dashboard.stdout.log", "dashboard.stderr.log"];
for (const name of excluded) {
  if (required.includes(name)) throw new Error(`Release list incorrectly includes runtime artifact: ${name}`);
}

const textExtensions = new Set([".js", ".json", ".md", ".bat", ".ps1", ".vbs", ".toml", ".pl"]);
const publicFiles = [];
const collect = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "workspace"].includes(entry.name)) continue;
    if (/\.local\.(bat|toml|json)$/i.test(entry.name) || /\.log$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (textExtensions.has(path.extname(entry.name).toLowerCase()) || entry.name.startsWith(".")) publicFiles.push(full);
  }
};
collect(root);
const privatePatterns = [
  { pattern: new RegExp(["D:", "\\\\CodexInstall"].join(""), "i"), label: "author install root" },
  { pattern: new RegExp(["192", "\\.168\\.3\\.51"].join(""), "i"), label: "author server address" },
  { pattern: new RegExp(["bu", "han@"].join(""), "i"), label: "author SSH account" },
  { pattern: new RegExp(["/home/", "bu", "han"].join(""), "i"), label: "author remote home" },
];
for (const file of publicFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const item of privatePatterns) {
    if (item.pattern.test(content)) throw new Error(`Public file contains ${item.label}: ${path.relative(root, file)}`);
  }
}

const pluginMcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
if (pluginMcp?.mcpServers?.["MS-MCP"]?.args?.at(-1) !== "Run-MS-MCP.bat") {
  throw new Error(".mcp.json must launch the configured relative Run-MS-MCP.bat entry point.");
}

console.log(JSON.stringify({
  ok: true,
  requiredFiles: required.length,
  javascriptFilesChecked: jsFiles.length,
  publicTextFilesScanned: publicFiles.length,
}, null, 2));

