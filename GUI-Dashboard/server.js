#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureWorkRoot, summarizeConfig, startNewProjectSession, assertInside, refreshProjectSession } from "../src/config.js";
import { queueScript } from "../src/guiScripts.js";
import { readState, writeState } from "../src/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const config = loadConfig();
ensureWorkRoot(config);

const requestedPort = Number(process.env.MS_MCP_DASHBOARD_PORT || 4877);
const dashboardWritesEnabled = process.env.MS_MCP_DASHBOARD_WRITE === "1";
const dashboardToken = String(process.env.MS_MCP_DASHBOARD_TOKEN || "");
const externalModelRoot = path.resolve(process.env.MS_MCP_MODEL_ROOT || config.workRoot);
const remoteSshTarget = String(process.env.MS_MCP_REMOTE_SSH_TARGET || "");
const remoteGatewayJobsRoot = String(process.env.MS_MCP_REMOTE_JOBS_ROOT || "");
const remoteSshTimeoutMs = Math.max(3000, Number(process.env.MS_MCP_REMOTE_SSH_TIMEOUT_MS || 12000));
const remoteSshKeyFile = path.resolve(
  process.env.MS_MCP_REMOTE_SSH_KEY || path.join(os.homedir(), ".ssh", "id_ed25519_ms_mcp"),
);

if (dashboardWritesEnabled && dashboardToken.length < 24) {
  throw new Error("MS_MCP_DASHBOARD_WRITE=1 requires MS_MCP_DASHBOARD_TOKEN with at least 24 characters.");
}

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    ...extra,
  };
}

function json(res, status, payload) {
  res.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(payload, null, 2));
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function listQueue() {
  const names = ["pending", "running", "done", "failed"];
  const result = {};
  for (const name of names) {
    const dir = path.join(config.queueDir, name);
    fs.mkdirSync(dir, { recursive: true });
    result[name] = fs.readdirSync(dir).filter((file) => file.toLowerCase().endsWith(".pl")).sort();
  }
  return result;
}

function latestQueueActivity() {
  const folders = ["running", "done", "failed"];
  let latest = null;
  for (const folder of folders) {
    const dir = path.join(config.queueDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.toLowerCase().endsWith(".pl")) continue;
      const full = path.join(dir, file);
      const stat = fs.statSync(full);
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { folder, file, mtimeMs: stat.mtimeMs, modifiedAt: stat.mtime.toISOString() };
      }
    }
  }
  return latest;
}

function latestStatusLine() {
  refreshProjectSession(config);
  const files = [
    path.join(config.projectRoot, "gui_loop_status.txt"),
    path.join(config.workRoot, "gui_loop_status.txt"),
  ];
  const file = files
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ file: candidate, stat: fs.statSync(candidate) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
  if (!file) return null;
  const lines = fs.readFileSync(file.file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const line = lines.at(-1);
  if (!line) return null;
  const [time, status, job, detail] = line.split("\t");
  return {
    time,
    status,
    job,
    detail,
    file: file.file,
    modifiedAt: file.stat.mtime.toISOString(),
    ageMs: Math.max(0, Date.now() - file.stat.mtimeMs),
  };
}

function listSessions() {
  refreshProjectSession(config);
  if (!fs.existsSync(config.workRoot)) return [];
  return fs
    .readdirSync(config.workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== ".mcp-queue")
    .map((entry) => {
      const folder = path.join(config.workRoot, entry.name);
      return {
        name: entry.name,
        path: folder,
        active: path.resolve(folder).toLowerCase() === path.resolve(config.projectRoot).toLowerCase(),
        modifiedAt: fs.statSync(folder).mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function switchSession(folderName) {
  const clean = String(folderName || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^_+|_+$/g, "");
  if (!clean) throw new Error("Session folder name is required.");
  const projectRoot = assertInside(config.workRoot, path.join(config.workRoot, clean));
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error(`Session folder does not exist: ${clean}`);
  }
  config.projectFolderName = clean;
  config.projectRoot = projectRoot;
  config.stateFile = path.join(projectRoot, ".ms-mcp-state.json");
  fs.writeFileSync(
    config.sessionFile,
    JSON.stringify({ projectFolderName: clean, projectRoot, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
  return summarizeConfig(config);
}

function isLoopRunning() {
  const stopFile = path.join(config.queueDir, "stop");
  if (fs.existsSync(stopFile)) return { running: false, reason: "stop requested", latest: latestStatusLine() };
  const latest = latestStatusLine();
  const activity = latestQueueActivity();
  if (!latest) return { running: false, reason: "no heartbeat yet", latest: activity };
  const staleAfterMs = Math.max(30_000, Number(process.env.MS_MCP_GUI_HEARTBEAT_STALE_MS || 90_000));
  if (latest.ageMs > staleAfterMs) {
    return {
      running: false,
      reason: `heartbeat expired ${Math.floor(latest.ageMs / 1000)}s ago`,
      latest,
    };
  }
  if (latest.status === "stopped") return { running: false, reason: "stopped", latest };
  if (latest.status === "running" || latest.status === "heartbeat" || latest.status === "started") {
    return { running: true, reason: latest.status, latest };
  }
  return { running: false, reason: latest.status || "unknown", latest };
}

function findCalculationFolders() {
  if (!fs.existsSync(config.projectRoot)) return [];
  return fs
    .readdirSync(config.projectRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^(Forcite|DMol3|CASTEP)[_-]/i.test(entry.name))
    .map((entry) => {
      const dir = path.join(config.projectRoot, entry.name);
      const files = fs.readdirSync(dir).sort();
      const moduleName = entry.name.split(/[_-]/)[0];
      const hasFailed = files.some((file) => /failed|error/i.test(file));
      const summary = files.find((file) => /summary\.txt$/i.test(file));
      const report = files.find((file) => /\.(txt|outmol)$/i.test(file) && !/settings|summary/i.test(file));
      const xsd = files.find((file) => /\.xsd$/i.test(file));
      return {
        name: entry.name,
        module: moduleName,
        status: hasFailed ? "failed" : summary || report || xsd ? "done/available" : "created",
        files,
        folder: dir,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function attrs(tag) {
  const out = {};
  for (const match of tag.matchAll(/([A-Za-z0-9_:-]+)\s*=\s*"([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

function parsePoint(value) {
  if (!value) return null;
  const nums = String(value).match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)?.map(Number);
  return nums && nums.length >= 3 ? [nums[0], nums[1], nums[2]] : null;
}

function parseXsd(file) {
  const xml = fs.readFileSync(file, "utf8");
  const spaceGroupTag = xml.match(/<SpaceGroup\b[^>]*>/)?.[0] || "";
  const spaceGroup = attrs(spaceGroupTag);
  const lattice = {
    a: parsePoint(spaceGroup.AVector),
    b: parsePoint(spaceGroup.BVector),
    c: parsePoint(spaceGroup.CVector),
  };
  const fractionalToCartesian = (point) => {
    if (!lattice.a || !lattice.b || !lattice.c) return point;
    return [0, 1, 2].map(
      (axis) => point[0] * lattice.a[axis] + point[1] * lattice.b[axis] + point[2] * lattice.c[axis],
    );
  };
  const atoms = [];
  const idToIndex = new Map();
  const connectionRefs = [];
  for (const match of xml.matchAll(/<Atom3d\b[^>]*>/g)) {
    const data = attrs(match[0]);
    const fractional = parsePoint(data.XYZ || data.FractionalXYZ);
    const element = data.Components || data.ElementSymbol || data.ElementType || "X";
    if (!fractional) continue;
    const xyz = fractionalToCartesian(fractional);
    const atom = { id: data.ID || data.Name || String(atoms.length + 1), element: element.replace(/[^A-Za-z]/g, "") || "X", x: xyz[0], y: xyz[1], z: xyz[2] };
    idToIndex.set(atom.id, atoms.length);
    if (data.Connections) connectionRefs.push([atom.id, data.Connections]);
    atoms.push(atom);
  }
  const bonds = [];
  const bondOrder = (data) => {
    const raw = String(data.Type || data.Order || data.BondType || "").toLowerCase();
    if (raw.includes("triple") || raw === "3") return 3;
    if (raw.includes("double") || raw === "2") return 2;
    return 1;
  };
  for (const match of xml.matchAll(/<Bond\b[^>]*>/g)) {
    const data = attrs(match[0]);
    const refs = String(data.Connects || data.Atoms || data.Components || "").match(/[A-Za-z0-9_.:-]+/g) || [];
    if (refs.length >= 2 && idToIndex.has(refs[0]) && idToIndex.has(refs[1])) {
      bonds.push([idToIndex.get(refs[0]), idToIndex.get(refs[1]), bondOrder(data)]);
    }
  }
  for (const [fromId, value] of connectionRefs) {
    const from = idToIndex.get(fromId);
    const refs = String(value).match(/[A-Za-z0-9_.:-]+/g) || [];
    for (const ref of refs) {
      if (!idToIndex.has(ref)) continue;
      const to = idToIndex.get(ref);
      if (from === to) continue;
      const a = Math.min(from, to);
      const b = Math.max(from, to);
      if (!bonds.some(([x, y]) => x === a && y === b)) bonds.push([a, b, 1]);
    }
  }
  if (!bonds.length && atoms.length < 300) {
    for (let i = 0; i < atoms.length; i += 1) {
      for (let j = i + 1; j < atoms.length; j += 1) {
        const dx = atoms[i].x - atoms[j].x;
        const dy = atoms[i].y - atoms[j].y;
        const dz = atoms[i].z - atoms[j].z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > 0.3 && d < 1.9) bonds.push([i, j]);
      }
    }
  }
  return { file, atoms, bonds };
}

function findXsdFiles(root, maxDepth = 4) {
  const files = [];
  function walk(dir, depth) {
    if (depth > maxDepth || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.xsd$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  walk(root, 0);
  return files;
}

function xsdRoots() {
  const roots = [{ name: "session", root: config.projectRoot }];
  if (fs.existsSync(externalModelRoot) && path.resolve(externalModelRoot).toLowerCase() !== path.resolve(config.projectRoot).toLowerCase()) {
    roots.push({ name: "Chapter3/model", root: externalModelRoot });
  }
  return roots;
}

function listXsdDocuments() {
  return xsdRoots()
    .flatMap(({ name, root }) => findXsdFiles(root, 6).map((file) => ({ name, root, file })))
    .map(({ name, root, file }) => {
      const stat = fs.statSync(file);
      const relative = path.relative(root, file);
      return {
        name: path.basename(file),
        relativePath: `${name}:${relative}`,
        path: file,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function readStructureSnapshot() {
  const file = path.join(config.projectRoot, "dashboard_structure_snapshot.json");
  const snapshot = readJson(file);
  if (!snapshot?.atoms?.length) return null;
  const atoms = snapshot.atoms.map((atom, index) => ({
    id: atom.id || String(index + 1),
    element: atom.element || "X",
    x: Number(atom.x) || 0,
    y: Number(atom.y) || 0,
    z: Number(atom.z) || 0,
  }));
  return { file, atoms, bonds: snapshot.bonds || [] };
}

function findStructureFile(state) {
  const candidates = [];
  if (state.dashboardSelectedXsd) candidates.push(state.dashboardSelectedXsd);
  if (state.currentExport) candidates.push(state.currentExport);
  if (state.currentDocument) candidates.push(path.join(config.projectRoot, state.currentDocument));
  const xsdFiles = xsdRoots().flatMap(({ root }) => findXsdFiles(root, 6));
  const currentBase = state.currentDocument ? String(state.currentDocument).replace(/\.xsd$/i, "").toLowerCase() : "";
  if (currentBase) {
    candidates.push(...xsdFiles.filter((file) => path.basename(file, ".xsd").toLowerCase() === currentBase));
    candidates.push(...xsdFiles.filter((file) => path.basename(file, ".xsd").toLowerCase().includes(currentBase)));
  }
  candidates.push(...xsdFiles);
  for (const folder of findCalculationFolders()) {
    for (const file of folder.files) {
      if (/\.xsd$/i.test(file)) candidates.push(path.join(folder.folder, file));
    }
  }
  for (const file of candidates) {
    if (!file) continue;
    try {
      const resolved = path.resolve(file);
      const allowed = xsdRoots().some(({ root }) => {
        const rel = path.relative(path.resolve(root), resolved);
        return rel && !rel.startsWith("..") && !path.isAbsolute(rel) || resolved === path.resolve(root);
      });
      if (allowed && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Ignore stale or tampered state entries that point outside the workspace.
    }
  }
  return null;
}

function findStructureData(state) {
  if (state.dashboardSelectedXsd) {
    try {
      const selected = path.resolve(state.dashboardSelectedXsd);
      const allowed = xsdRoots().some(({ root }) => {
        const rel = path.relative(path.resolve(root), selected);
        return (!rel.startsWith("..") && !path.isAbsolute(rel)) || selected === path.resolve(root);
      });
      if (allowed && fs.existsSync(selected) && fs.statSync(selected).isFile()) return parseXsd(selected);
    } catch {
      // Ignore unsafe state and continue with workspace discovery.
    }
  }
  const snapshot = readStructureSnapshot();
  if (snapshot) return snapshot;
  const structureFile = findStructureFile(state);
  return structureFile ? parseXsd(structureFile) : null;
}

function perlLiteral(value) {
  return `"${String(value)
    .replace(/\\/g, "/")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/@/g, "\\@")}"`;
}

function resolverSnippet(documentName) {
  const docName = documentName ? String(documentName) : "";
  if (!docName) throw new Error("No current document is set.");
  return `
my $doc;
sub dash_try_doc {
  my ($name) = @_;
  my $candidate;
  eval { $candidate = $Documents{$name}; };
  return $candidate if $candidate;
  eval { $candidate = Documents->Item($name); };
  return $candidate if $candidate;
  return undef;
}
$doc = dash_try_doc(${perlLiteral(docName)});
if (!$doc && ${perlLiteral(docName)} !~ /\\.xsd$/i) {
  $doc = dash_try_doc(${perlLiteral(`${docName}.xsd`)});
}
if (!$doc && ${perlLiteral(docName)} =~ /^(.*)\\.xsd$/i) {
  $doc = dash_try_doc($1);
}
die "Document not found: ${docName}" unless $doc;
`;
}

function stateWritePerl(type) {
  const stateFile = String(config.stateFile).replace(/\\/g, "/");
  return `
open(my $state_fh, ">", ${perlLiteral(stateFile)}) or die "Cannot write dashboard state: $!";
my $name = "";
eval { $name = $doc->Name; };
print $state_fh "{\\n  \\"currentDocument\\": \\"" . $name . "\\",\\n  \\"currentExport\\": null,\\n  \\"lastJob\\": { \\"type\\": \\"${type}\\" },\\n  \\"updatedAt\\": \\"" . scalar(localtime()) . "\\"\\n}\\n";
close($state_fh);
`;
}

function enqueueStructureSnapshot() {
  const state = readState(config);
  const target = state.currentDocument;
  if (!target) throw new Error("No current document is set.");
  const snapshotPath = path.join(config.projectRoot, "dashboard_structure_snapshot.json");
  const stateFile = String(config.stateFile).replace(/\\/g, "/");
  const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${resolverSnippet(target)}
sub dash_json_escape {
  my ($value) = @_;
  $value = "" unless defined $value;
  $value =~ s/\\\\/\\\\\\\\/g;
  $value =~ s/"/\\\\"/g;
  $value =~ s/\\r/\\\\r/g;
  $value =~ s/\\n/\\\\n/g;
  return $value;
}
open(my $snap_fh, ">", ${perlLiteral(snapshotPath)}) or die "Cannot write dashboard structure snapshot: $!";
print $snap_fh "{\\n  \\"sourceDocument\\": \\"" . dash_json_escape($doc->Name) . "\\",\\n  \\"atoms\\": [\\n";
my $first_atom = 1;
foreach my $atom (@{$doc->Atoms}) {
  my $p = $atom->XYZ;
  my $element = "";
  eval { $element = $atom->ElementSymbol; };
  eval { $element = $atom->Element->Symbol if !$element; };
  eval { $element = $atom->ElementName if !$element; };
  $element = "X" unless $element;
  print $snap_fh ",\\n" unless $first_atom;
  $first_atom = 0;
  print $snap_fh "    {\\"id\\":\\"" . dash_json_escape($atom->Name) . "\\",\\"element\\":\\"" . dash_json_escape($element) . "\\",\\"x\\":" . $p->X . ",\\"y\\":" . $p->Y . ",\\"z\\":" . $p->Z . "}";
}
print $snap_fh "\\n  ],\\n  \\"bonds\\": []\\n}\\n";
close($snap_fh);
open(my $state_fh, ">", ${perlLiteral(stateFile)}) or die "Cannot write dashboard state: $!";
my $name = "";
eval { $name = $doc->Name; };
print $state_fh "{\\n  \\"currentDocument\\": \\"" . $name . "\\",\\n  \\"currentExport\\": null,\\n  \\"lastJob\\": { \\"type\\": \\"dashboard_structure_snapshot\\" },\\n  \\"updatedAt\\": \\"" . scalar(localtime()) . "\\"\\n}\\n";
close($state_fh);
print "Dashboard structure preview data refreshed without exporting an xsd file\\n";
`;
  return queueScript(config, "dashboard_structure_snapshot", script);
}

function enqueueModelAction(action) {
  const state = readState(config);
  const target = state.currentDocument;
  if (!target) throw new Error("No current document is set.");
  const operations = {
    clean: "$doc->Clean;",
    adjust_hydrogen: "$doc->AdjustHydrogen;",
    calculate_bonds: `if ($doc->Lattice3D) {
  die "Refusing broad CalculateBonds on a periodic document from Dashboard. Use explicit bonding or an MCP tool call that explicitly allows periodic bond guessing.";
}
$doc->CalculateBonds;`,
    clean_adjust_hydrogen: "$doc->AdjustHydrogen;\n$doc->Clean;\n$doc->AdjustHydrogen;",
  };
  if (!operations[action]) throw new Error(`Unknown modeling action: ${action}`);
  const script = `use strict;\nuse warnings;\nuse MaterialsScript qw(:all);\n${resolverSnippet(target)}${operations[action]}\neval { $doc->Save; };\n${stateWritePerl(`dashboard_${action}`)}\nprint "Dashboard action ${action} finished\\n";\n`;
  return queueScript(config, `dashboard_${action}`, script);
}

function enqueueCalculation(moduleName) {
  const state = readState(config);
  const target = state.currentDocument;
  if (!target) throw new Error("No current document is set.");
  const calcName = `${moduleName}_dashboard_geomopt`;
  fs.mkdirSync(path.join(config.projectRoot, calcName), { recursive: true });
  const settings = moduleName === "Forcite"
    ? 'Quality => "Medium", CurrentForcefield => "Universal", ChargeAssignment => "Use current", MaxIterations => 500'
    : moduleName === "DMol3"
      ? 'Quality => "Medium", TheoryLevel => "GGA", GeometryOptimizationQuality => "Medium", Charge => 0, UseSymmetry => "No", CreateEnergyEvolutionChart => "Yes"'
      : 'Quality => "Medium"';
  const runLine = moduleName === "CASTEP"
    ? `my $results = Modules->CASTEP->GeometryOptimization->Run($copy, Settings(${settings}));`
    : `my $results = Modules->${moduleName}->GeometryOptimization->Run($copy, Settings(${settings}));`;
  const script = `use strict;\nuse warnings;\nuse MaterialsScript qw(:all);\n${resolverSnippet(target)}my $copy = $doc->SaveAs("/${calcName}/${moduleName}.xsd");\n${runLine}\nmy $result = $results->Structure;\n$doc = $result if $result;\neval { $doc->Export(${perlLiteral(path.join(config.projectRoot, calcName, `${moduleName}.xsd`))}); };\n${stateWritePerl(`dashboard_${moduleName.toLowerCase()}_geomopt`)}\nprint "Dashboard ${moduleName} geometry optimization finished\\n";\n`;
  return queueScript(config, `dashboard_${moduleName.toLowerCase()}_geomopt`, script);
}

function listRemoteCastepBatches() {
  const root = path.join(config.projectRoot, "remote-castep");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const receipt = readJson(path.join(dir, `${entry.name}_submission.json`), null);
      const manifest = readJson(path.join(dir, `${entry.name}_manifest.json`), null);
      if (!receipt && !manifest) return null;
      return {
        batchName: entry.name,
        jobId: receipt?.jobId || null,
        gateway: receipt?.gateway || null,
        submittedAt: receipt?.submittedAt || null,
        lastObservedStatus: receipt?.lastObservedStatus || "unknown",
        taskCount: manifest?.tasks?.length || 0,
        tasks: (manifest?.tasks || []).map((task, index) => ({
          index: index + 1,
          calculationName: task.calculationName || task.documentName || `Task ${index + 1}`,
          documentName: task.documentName || null,
          metal: task.metal || null,
          initialSpin: task.initialSpin ?? null,
        })),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runSsh(command) {
  return new Promise((resolve, reject) => {
    const identityArgs = fs.existsSync(remoteSshKeyFile) ? ["-i", remoteSshKeyFile, "-o", "IdentitiesOnly=yes"] : [];
    execFile(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=6",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=1",
        ...identityArgs,
        remoteSshTarget,
        `sh -lc ${shellQuote(command)}`,
      ],
      { timeout: remoteSshTimeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.remoteStderr = String(stderr || "").trim();
          reject(error);
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted && char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseRemoteMonitorOutput(output) {
  const sections = { META: [], CSV: [], PROCESS: [], CASTEP: [] };
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const marker = line.match(/^__([A-Z]+)__$/)?.[1];
    if (marker && Object.hasOwn(sections, marker)) {
      current = marker;
      continue;
    }
    if (current && line) sections[current].push(line);
  }
  const meta = Object.fromEntries(
    sections.META.map((line) => {
      const at = line.indexOf("=");
      return at >= 0 ? [line.slice(0, at), line.slice(at + 1)] : [line, ""];
    }),
  );
  const csvRows = sections.CSV.filter((line) => line.trim()).map(parseCsvLine);
  const header = csvRows[0] || [];
  const results = csvRows.slice(1).map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""])));
  return {
    meta,
    results,
    processLine: sections.PROCESS.join(" ").trim(),
    castepTail: sections.CASTEP,
  };
}

async function readRemoteBatchProgress(batch) {
  if (!batch?.jobId || !/^[A-Za-z0-9_-]+$/.test(batch.jobId)) {
    throw new Error("批次没有有效的远程 Job ID。");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(batch.batchName)) {
    throw new Error("批次名称包含不支持的字符。");
  }
  const jobDir = `${remoteGatewayJobsRoot.replace(/\/$/, "")}/${batch.jobId}`;
  const expectedCsv = `${batch.batchName}_results.csv`;
  const script = `
job_dir=${shellQuote(jobDir)}
job_id=${shellQuote(batch.jobId)}
expected_csv=${shellQuote(expectedCsv)}
csv=""
if [ -d "$job_dir" ]; then
  csv=$(find "$job_dir" -maxdepth 3 -type f -name "$expected_csv" -print 2>/dev/null | head -n 1)
fi
process_line=$(ps -eo pid=,etimes=,args= 2>/dev/null | grep '[c]astepe.exe' | grep "/tmp/$job_id/" | head -n 1 || true)
current_file=""
if [ -d "/tmp/$job_id" ]; then
  current_file=$(find "/tmp/$job_id" -type f -name '*.castep' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
fi
printf '__META__\n'
printf 'job_dir_exists=%s\n' "$([ -d "$job_dir" ] && printf yes || printf no)"
printf 'job_dir=%s\n' "$job_dir"
printf 'csv=%s\n' "$csv"
printf 'current_file=%s\n' "$current_file"
printf 'checked_at=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
printf '__CSV__\n'
if [ -n "$csv" ] && [ -f "$csv" ]; then cat "$csv"; fi
printf '__PROCESS__\n'
printf '%s\n' "$process_line"
printf '__CASTEP__\n'
if [ -n "$current_file" ] && [ -f "$current_file" ]; then tail -n 40 "$current_file"; fi
`;
  try {
    const parsed = parseRemoteMonitorOutput(await runSsh(script));
    const processCalculation = parsed.processLine.match(/\b(BLG_[A-Za-z0-9_]+_48c)\b/)?.[1] || null;
    const completedCount = parsed.results.length;
    const inferredCurrent =
      batch.tasks.find((task) => task.calculationName === processCalculation) ||
      (completedCount < batch.tasks.length ? batch.tasks[completedCount] : null);
    const resultsByName = new Map(parsed.results.map((row) => [row.CalculationName, row]));
    const taskStates = batch.tasks.map((task) => {
      const result = resultsByName.get(task.calculationName);
      if (result) return { ...task, state: result.ConvergenceStatus || "completed", result };
      if (processCalculation === task.calculationName) return { ...task, state: "running" };
      if (task.index <= completedCount) return { ...task, state: "processed" };
      return { ...task, state: "queued" };
    });
    return {
      ok: true,
      connected: true,
      sshTarget: remoteSshTarget,
      batch: { ...batch, tasks: undefined },
      completedCount,
      totalCount: batch.tasks.length,
      currentCalculation: processCalculation || inferredCurrent?.calculationName || null,
      currentIndex: processCalculation
        ? batch.tasks.findIndex((task) => task.calculationName === processCalculation) + 1
        : inferredCurrent?.index || null,
      taskStates,
      results: parsed.results,
      processLine: parsed.processLine,
      castepTail: parsed.castepTail,
      remote: parsed.meta,
    };
  } catch (error) {
    const detail = error.remoteStderr || error.message;
    return {
      ok: false,
      connected: false,
      sshTarget: remoteSshTarget,
      batch: { ...batch, tasks: undefined },
      totalCount: batch.tasks.length,
      taskStates: batch.tasks.map((task) => ({ ...task, state: "queued" })),
      error: detail,
      needsKeyAuthentication: /permission denied|publickey|password/i.test(detail),
    };
  }
}

async function bodyJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("Dashboard request body exceeds 1 MiB.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function api(req, res, url) {
  // Selecting a preview only updates the dashboard's local view state. It is
  // intentionally available in read-only mode; model-building and calculation
  // actions remain protected by the write flag and bearer token.
  const localPreviewSelection = req.method === "POST" && url.pathname === "/api/document/select";
  if (req.method !== "GET" && !localPreviewSelection) {
    if (!dashboardWritesEnabled) {
      return json(res, 403, { error: "Dashboard mutations are disabled. Set MS_MCP_DASHBOARD_WRITE=1 and a strong token to enable them." });
    }
    if (req.headers.authorization !== `Bearer ${dashboardToken}`) {
      return json(res, 401, { error: "A valid dashboard bearer token is required." });
    }
    const origin = req.headers.origin;
    if (origin) {
      const parsed = new URL(origin);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
        return json(res, 403, { error: "Dashboard requests must originate from the local dashboard." });
      }
    }
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    const state = readState(config);
    const structure = findStructureData(state);
    return json(res, 200, {
      config: summarizeConfig(config),
      state,
      queue: listQueue(),
      loop: isLoopRunning(),
      sessions: listSessions(),
      xsdDocuments: listXsdDocuments(),
      calculations: findCalculationFolders(),
      structure,
      mcp: { connected: true, reason: "Dashboard can read the MS-MCP workspace and queue." },
    });
  }
  if (req.method === "GET" && url.pathname === "/api/remote-batches") {
    return json(res, 200, {
      sshTarget: remoteSshTarget,
      sshKeyFile: remoteSshKeyFile,
      sshKeyExists: fs.existsSync(remoteSshKeyFile),
      remoteJobsRoot: remoteGatewayJobsRoot,
      batches: listRemoteCastepBatches(),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/remote-monitor") {
    const batchName = String(url.searchParams.get("batch") || "");
    const batches = listRemoteCastepBatches();
    const batch = batches.find((item) => item.batchName === batchName) || batches.find((item) => item.jobId === "NSMA4") || batches[0];
    if (!batch) return json(res, 404, { error: "没有找到已提交的远程 CASTEP 批次。" });
    return json(res, 200, await readRemoteBatchProgress(batch));
  }
  if (req.method === "POST" && url.pathname === "/api/loop/stop") {
    fs.mkdirSync(config.queueDir, { recursive: true });
    fs.writeFileSync(path.join(config.queueDir, "stop"), "");
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/session/new") {
    const body = await bodyJson(req);
    startNewProjectSession(config, body.folderName);
    writeState(config, { currentDocument: null, currentExport: null, lastJob: { type: "dashboard_start_project_session" }, history: [] });
    return json(res, 200, summarizeConfig(config));
  }
  if (req.method === "POST" && url.pathname === "/api/session/select") {
    const body = await bodyJson(req);
    return json(res, 200, switchSession(body.folderName));
  }
  if (req.method === "POST" && url.pathname === "/api/document/select") {
    const body = await bodyJson(req);
    const relativePath = String(body.relativePath || "");
    if (!relativePath || !/\.xsd$/i.test(relativePath)) throw new Error("An XSD file is required.");
    const separator = relativePath.indexOf(":");
    const rootName = separator >= 0 ? relativePath.slice(0, separator) : "session";
    const localPath = separator >= 0 ? relativePath.slice(separator + 1) : relativePath;
    const rootEntry = xsdRoots().find(({ name }) => name === rootName);
    if (!rootEntry) throw new Error(`Unknown XSD root: ${rootName}`);
    const selected = assertInside(rootEntry.root, path.join(rootEntry.root, localPath));
    if (!fs.existsSync(selected) || !fs.statSync(selected).isFile()) {
      throw new Error(`XSD file does not exist: ${relativePath}`);
    }
    writeState(config, {
      dashboardSelectedXsd: selected,
      lastJob: { type: "dashboard_select_xsd", relativePath, path: selected },
    });
    return json(res, 200, { ok: true, selected, relativePath });
  }
  if (req.method === "POST" && url.pathname === "/api/action/model") {
    const body = await bodyJson(req);
    return json(res, 200, { ok: true, queued: enqueueModelAction(body.action) });
  }
  if (req.method === "POST" && url.pathname === "/api/action/calc") {
    const body = await bodyJson(req);
    return json(res, 200, { ok: true, queued: enqueueCalculation(body.module) });
  }
  if (req.method === "POST" && url.pathname === "/api/structure/snapshot") {
    return json(res, 200, { ok: true, queued: enqueueStructureSnapshot() });
  }
  return json(res, 404, { error: "Not found" });
}

function serveStatic(res, requestPath) {
  const file = requestPath === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, requestPath);
  const safe = assertInside(publicDir, file);
  if (!fs.existsSync(safe) || fs.statSync(safe).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(safe).toLowerCase();
  const type = ext === ".html" ? "text/html" : ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "application/octet-stream";
  res.writeHead(200, securityHeaders({ "content-type": `${type}; charset=utf-8` }));
  fs.createReadStream(safe).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    api(req, res, url).catch((error) => json(res, 500, { error: error.message }));
  } else {
    serveStatic(res, decodeURIComponent(url.pathname));
  }
});

function listen(port, attempts = 0) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempts < 20) {
      listen(port + 1, attempts + 1);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const actual = server.address().port;
    if (actual !== requestedPort) {
      console.log(`Port ${requestedPort} is busy; using ${actual} instead.`);
    }
    console.log(`MS-MCP Dashboard: http://127.0.0.1:${actual}`);
  });
}

listen(requestedPort);

