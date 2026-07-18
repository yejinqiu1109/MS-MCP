import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_INSTALL_ROOT =
  "C:\\Program Files\\BIOVIA\\Materials Studio";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function normalizePath(value) {
  if (!value) return value;
  return path.resolve(String(value));
}

function localDateFolder(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sessionFilePath(workRoot) {
  return path.join(workRoot, ".ms-mcp-session.json");
}

function readSession(workRoot) {
  const file = sessionFilePath(workRoot);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function nextSessionFolder(workRoot, prefix = localDateFolder()) {
  for (let index = 1; index < 10000; index += 1) {
    const name = `${prefix}-${index}`;
    if (!fs.existsSync(path.join(workRoot, name))) return name;
  }
  throw new Error(`Cannot allocate project session folder under ${workRoot}`);
}

function resolveProjectSession(workRoot) {
  if (process.env.MS_MCP_PROJECT_ROOT) {
    const projectRoot = assertInside(workRoot, normalizePath(process.env.MS_MCP_PROJECT_ROOT));
    return { projectRoot, projectFolderName: path.basename(projectRoot), projectSessionPinned: true };
  }
  if (process.env.MS_MCP_PROJECT_FOLDER) {
    const projectFolderName = process.env.MS_MCP_PROJECT_FOLDER;
    return {
      projectRoot: assertInside(workRoot, normalizePath(path.join(workRoot, projectFolderName))),
      projectFolderName,
      projectSessionPinned: true,
    };
  }
  const existing = readSession(workRoot);
  if (existing?.projectRoot && fs.existsSync(existing.projectRoot)) {
    return {
      projectRoot: normalizePath(existing.projectRoot),
      projectFolderName: existing.projectFolderName || path.basename(existing.projectRoot),
      projectSessionPinned: false,
    };
  }
  const projectFolderName = nextSessionFolder(workRoot);
  return {
    projectRoot: normalizePath(path.join(workRoot, projectFolderName)),
    projectFolderName,
    projectSessionPinned: false,
  };
}

export function loadConfig() {
  const installRoot = normalizePath(
    process.env.MS_INSTALL_ROOT || DEFAULT_INSTALL_ROOT,
  );
  const workRoot = normalizePath(
    process.env.MS_MCP_WORK_ROOT ||
      path.join(REPO_ROOT, "workspace"),
  );
  const timeoutMs = Number(process.env.MS_MCP_TIMEOUT_MS || 30 * 60 * 1000);
  const maxOutputBytes = Number(process.env.MS_MCP_MAX_OUTPUT_BYTES || 256000);
  const structureSourcePolicy = ["auto", "manual", "require_cif_first"].includes(process.env.MS_MCP_STRUCTURE_SOURCE_POLICY)
    ? process.env.MS_MCP_STRUCTURE_SOURCE_POLICY
    : "auto";
  fs.mkdirSync(workRoot, { recursive: true });
  const { projectRoot, projectFolderName, projectSessionPinned } = resolveProjectSession(workRoot);

  return {
    installRoot,
    binDir: path.join(installRoot, "bin"),
    runMatScript: path.join(installRoot, "etc", "Scripting", "bin", "RunMatScript.bat"),
    workRoot,
    projectFolderName,
    projectRoot,
    projectSessionPinned,
    queueDir: path.join(workRoot, ".mcp-queue"),
    sessionFile: sessionFilePath(workRoot),
    stateFile: path.join(projectRoot, ".ms-mcp-state.json"),
    timeoutMs,
    maxOutputBytes,
    structureSourcePolicy,
    // Fail closed. Arbitrary MaterialsScript must be enabled explicitly.
    allowArbitraryScript: process.env.MS_MCP_ALLOW_ARBITRARY_SCRIPT === "1",
    // Structured GUI tools may be enabled without exposing raw script bodies.
    allowGuiQueue: process.env.MS_MCP_ALLOW_GUI_QUEUE === "1",
    allowExternalInputs: process.env.MS_MCP_ALLOW_EXTERNAL_INPUTS === "1",
    allowedCifHosts: String(
      process.env.MS_MCP_ALLOWED_CIF_HOSTS || "www.crystallography.net,crystallography.net",
    )
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    maxCifBytes: Math.min(
      Math.max(Number(process.env.MS_MCP_MAX_CIF_BYTES || 10 * 1024 * 1024), 1024),
      100 * 1024 * 1024,
    ),
    repoRoot: REPO_ROOT,
  };
}

export function ensureWorkRoot(config) {
  fs.mkdirSync(config.workRoot, { recursive: true });
  fs.mkdirSync(config.queueDir, { recursive: true });
}

export function ensureProjectSession(config) {
  ensureWorkRoot(config);
  refreshProjectSession(config);
  fs.mkdirSync(config.projectRoot, { recursive: true });
  writeSession(config);
  return config;
}

export function refreshProjectSession(config) {
  if (config.projectSessionPinned) return config;
  const existing = readSession(config.workRoot);
  if (!existing?.projectRoot || !fs.existsSync(existing.projectRoot)) return config;
  const projectRoot = assertInside(config.workRoot, normalizePath(existing.projectRoot));
  if (projectRoot === config.projectRoot) return config;
  config.projectRoot = projectRoot;
  config.projectFolderName = existing.projectFolderName || path.basename(projectRoot);
  config.stateFile = path.join(projectRoot, ".ms-mcp-state.json");
  return config;
}

export function writeSession(config) {
  fs.writeFileSync(
    config.sessionFile,
    JSON.stringify(
      {
        projectFolderName: config.projectFolderName,
        projectRoot: config.projectRoot,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function startNewProjectSession(config, requestedName) {
  const rawName = requestedName || nextSessionFolder(config.workRoot);
  const projectFolderName = String(rawName)
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!projectFolderName) throw new Error("Project session folder name cannot be empty.");
  config.projectFolderName = projectFolderName;
  config.projectRoot = normalizePath(path.join(config.workRoot, projectFolderName));
  config.stateFile = path.join(config.projectRoot, ".ms-mcp-state.json");
  fs.mkdirSync(config.projectRoot, { recursive: true });
  writeSession(config);
  return config;
}

export function assertInside(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access path outside work root: ${target}`);
  }

  // Resolve the nearest existing ancestor so Windows junctions/symlinks cannot
  // redirect an apparently safe path outside the configured work root.
  if (fs.existsSync(base)) {
    const realBase = fs.realpathSync.native(base);
    let existing = target;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    if (fs.existsSync(existing)) {
      const realExisting = fs.realpathSync.native(existing);
      const realTarget = path.resolve(realExisting, path.relative(existing, target));
      const realRelative = path.relative(realBase, realTarget);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`Refusing to follow a path outside work root: ${target}`);
      }
    }
  }
  return target;
}

export function summarizeConfig(config) {
  const sessionExists = fs.existsSync(config.sessionFile);
  const projectRootExists = fs.existsSync(config.projectRoot);
  return {
    installRoot: config.installRoot,
    runMatScript: config.runMatScript,
    workRoot: config.workRoot,
    projectRoot: config.projectRoot,
    projectFolderName: config.projectFolderName,
    projectSessionPinned: config.projectSessionPinned,
    projectSessionActive: sessionExists && projectRootExists,
    sessionFileExists: sessionExists,
    projectRootExists,
    queueDir: config.queueDir,
    sessionFile: config.sessionFile,
    stateFile: config.stateFile,
    timeoutMs: config.timeoutMs,
    structureSourcePolicy: config.structureSourcePolicy,
    allowArbitraryScript: config.allowArbitraryScript,
    allowGuiQueue: config.allowGuiQueue,
    allowExternalInputs: config.allowExternalInputs,
    allowedCifHosts: config.allowedCifHosts,
    maxCifBytes: config.maxCifBytes,
    installRootExists: fs.existsSync(config.installRoot),
    runMatScriptExists: fs.existsSync(config.runMatScript),
  };
}
