import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const apply = process.argv.includes("--apply");
const workRoot = path.resolve(process.env.MS_MCP_WORK_ROOT || path.join(process.cwd(), "workspace"));
const projectModelRootValue = process.env.MS_MCP_MODEL_ROOT;
if (!projectModelRootValue) throw new Error("MS_MCP_MODEL_ROOT is required for Chapter 3 model synchronization.");
const projectModelRoot = path.resolve(projectModelRootValue);
const stagingRoot = path.resolve(
  process.env.MS_MCP_MODEL_STAGING_ROOT || path.join(workRoot, "chapter3-model-staging"),
);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walkXsd(root) {
  const result = [];
  function walk(folder) {
    if (!fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.xsd$/i.test(entry.name)) result.push(full);
    }
  }
  walk(root);
  return result;
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function atomCounts(file) {
  const text = fs.readFileSync(file, "utf8");
  const counts = {};
  for (const match of text.matchAll(/<Atom3d\b([^>]*)>/g)) {
    const attrs = match[1];
    const component = attrs.match(/\bComponents="([^"]+)"/i)?.[1];
    const xyz = attrs.match(/\bXYZ="([^"]+)"/i)?.[1];
    if (!component || !xyz) continue;
    counts[component] = (counts[component] || 0) + 1;
  }
  return counts;
}

function expectedComposition(file) {
  const name = path.basename(file);
  const metal = name.match(/^BLG_([A-Z][a-z]?)_C3(?:O_ax)?\.xsd$/)?.[1];
  if (!metal) return null;
  return /_C3O_ax\.xsd$/i.test(name)
    ? { C: 255, [metal]: 1, O: 1 }
    : { C: 255, [metal]: 1 };
}

function sameCounts(actual, expected) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every((key) => (actual[key] || 0) === (expected[key] || 0));
}

if (!fs.existsSync(projectModelRoot)) throw new Error(`Chapter3 model root not found: ${projectModelRoot}`);
if (!inside(workRoot, stagingRoot)) throw new Error(`Staging root must remain inside MS_MCP_WORK_ROOT: ${stagingRoot}`);

const sourceFiles = walkXsd(projectModelRoot).filter((file) => expectedComposition(file));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = path.join(workRoot, "sync-backups", `chapter3-models-${stamp}`);
const actions = [];

for (const source of sourceFiles) {
  const relative = path.relative(projectModelRoot, source);
  const target = path.join(stagingRoot, relative);
  if (!inside(stagingRoot, target)) throw new Error(`Unsafe target path: ${target}`);
  const expected = expectedComposition(source);
  const sourceCounts = atomCounts(source);
  if (!sameCounts(sourceCounts, expected)) {
    actions.push({ relative, status: "rejected_invalid_project_source", expected, sourceCounts });
    continue;
  }
  const targetExists = fs.existsSync(target);
  const sameHash = targetExists && hash(source) === hash(target);
  const targetCounts = targetExists ? atomCounts(target) : {};
  if (sameHash) {
    actions.push({ relative, status: "already_synced", expected, sourceCounts, targetCounts });
    continue;
  }
  if (apply) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (targetExists) {
      const backup = path.join(backupRoot, relative);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(target, backup);
    }
    fs.copyFileSync(source, target);
  }
  actions.push({
    relative,
    status: apply ? "synced_project_to_workspace" : "would_sync_project_to_workspace",
    expected,
    sourceCounts,
    targetCounts,
    targetExists,
  });
}

const manifest = {
  mode: apply ? "apply" : "dry-run",
  direction: "Chapter3 project model -> MS-MCP workspace staging",
  projectModelRoot,
  stagingRoot,
  backupRoot: apply && fs.existsSync(backupRoot) ? backupRoot : null,
  generatedAt: new Date().toISOString(),
  actions,
};

if (apply) {
  const manifestDir = path.join(workRoot, "sync-manifests");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, `chapter3-models-${stamp}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  manifest.manifestPath = manifestPath;
}

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
