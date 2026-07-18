#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, ensureWorkRoot, assertInside, summarizeConfig, startNewProjectSession, refreshProjectSession } from "./config.js";
import {
  buildCastepScript,
  buildForciteEnergyScript,
  buildMoleculeScript,
  newJobDir,
  runMatScript,
  writeScript,
} from "./materialsScript.js";
import {
  ballStickSnippet,
  documentResolverSnippet,
  queueScript,
  saveExportSnippet,
  stateWriteRuntimeDocSnippet,
  stateWriteSnippet,
  traceSnippet,
} from "./guiScripts.js";
import { appendHistory, readState, writeState } from "./state.js";
import { buildRemoteCastepBatchScript, legacyCarbonCastepSettings, normalizeRemoteCastepTasks } from "./remoteCastep.js";

const config = loadConfig();
ensureWorkRoot(config);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function dashboardListening(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function openDashboard(url) {
  if (process.platform !== "win32") return;
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
}

async function ensureDashboardStarted() {
  const autoStart = process.env.MS_MCP_DASHBOARD_AUTOSTART !== "0";
  // Opening a browser is opt-in. Starting or reconnecting the MCP server must
  // not interrupt the user by foregrounding the Dashboard unexpectedly.
  const autoOpen = process.env.MS_MCP_DASHBOARD_AUTO_OPEN === "1";
  if (!autoStart && !autoOpen) return;

  const port = Number(process.env.MS_MCP_DASHBOARD_PORT || 4877);
  const url = `http://127.0.0.1:${port}`;
  let listening = await dashboardListening(port);

  if (!listening && autoStart) {
    const dashboardScript = path.resolve(__dirname, "../GUI-Dashboard/server.js");
    const child = spawn(process.execPath, [dashboardScript], {
      cwd: path.dirname(dashboardScript),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    for (let attempt = 0; attempt < 25 && !listening; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      listening = await dashboardListening(port);
    }
  }

  if (listening && autoOpen) openDashboard(url);
}

const server = new McpServer({
  name: "MS-MCP",
  version: "0.2.0",
});

function text(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function ensureGuiQueueAllowed() {
  if (!config.allowGuiQueue) {
    throw new Error("Structured GUI queueing is disabled. Set MS_MCP_ALLOW_GUI_QUEUE=1 to enable it.");
  }
}

function ensureRawScriptAllowed() {
  if (!config.allowArbitraryScript) {
    throw new Error("Raw MaterialsScript bodies are disabled. Set MS_MCP_ALLOW_ARBITRARY_SCRIPT=1 only for fully trusted local use.");
  }
}

function workspacePath(relativePath) {
  return assertInside(config.workRoot, path.resolve(config.workRoot, relativePath));
}

function projectOutputPath(relativePath) {
  refreshProjectSession(config);
  if (path.isAbsolute(relativePath)) return assertInside(config.workRoot, path.resolve(relativePath));
  return assertInside(config.workRoot, path.resolve(config.projectRoot, relativePath));
}

function readableInputPath(file) {
  const resolved = path.isAbsolute(file) ? path.resolve(file) : workspacePath(file);
  if (config.allowExternalInputs) return resolved;
  return assertInside(config.workRoot, resolved);
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isInsidePath(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureXsdName(value) {
  const name = path.basename(String(value || "model.xsd")).replace(/\s+\(\d+\)(?=\.xsd$|$)/i, "");
  return /\.xsd$/i.test(name) ? name : `${name}.xsd`;
}

function stripModelingWorkSuffix(fileName) {
  return ensureXsdName(fileName).replace(/_current\.xsd$/i, ".xsd");
}

function normalizeVisibleDocumentName(value) {
  return ensureXsdName(value).replace(/\s+\(\d+\)(?=\.xsd$|$)/i, "");
}

function guiImportDocumentName(file, documentName) {
  if (documentName) return stripModelingWorkSuffix(documentName);
  const base = path.basename(file, path.extname(file));
  return stripModelingWorkSuffix(base);
}

function safeStructureStem(value, fallback = "structure") {
  return String(value || fallback)
    .replace(/\.cif$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

function cifUrlFromSource({ source, url, codId }) {
  if (source === "cod") {
    const clean = String(codId || "").replace(/[^0-9]+/g, "");
    if (!/^[0-9]{6,9}$/.test(clean)) throw new Error("COD id must be a 6-9 digit numeric id.");
    return `https://www.crystallography.net/cod/${clean}.cif`;
  }
  if (!url) throw new Error("A CIF URL is required for source=url.");
  const parsed = new URL(String(url));
  if (parsed.protocol !== "https:") {
    throw new Error("CIF URLs must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new Error("CIF URLs cannot contain credentials or a custom port.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!config.allowedCifHosts.includes(host)) {
    throw new Error(
      `CIF host ${host} is not allowed. Configure MS_MCP_ALLOWED_CIF_HOSTS explicitly if this trusted source is required.`,
    );
  }
  return parsed.toString();
}

async function downloadCifToProject({ source, url, codId, fileName }) {
  refreshProjectSession(config);
  const cifUrl = cifUrlFromSource({ source, url, codId });
  const stem = safeStructureStem(fileName || codId || path.basename(new URL(cifUrl).pathname, ".cif"), "structure");
  const cifPath = assertInside(config.workRoot, path.join(config.projectRoot, "cif", `${stem}.cif`));
  const response = await fetch(cifUrl, { headers: { "user-agent": "MS-MCP/0.2.0" } });
  if (!response.ok) throw new Error(`CIF download failed (${response.status}) from ${cifUrl}`);
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > config.maxCifBytes) {
    throw new Error(`CIF download is too large (${declaredBytes} bytes; limit ${config.maxCifBytes}).`);
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > config.maxCifBytes) {
    throw new Error(`CIF download is too large (${body.byteLength} bytes; limit ${config.maxCifBytes}).`);
  }
  const textBody = new TextDecoder("utf-8", { fatal: false }).decode(body);
  if (!/(^|\n)\s*data_/i.test(textBody) && !/(^|\n)\s*_cell_length_/i.test(textBody)) {
    throw new Error(`Downloaded content from ${cifUrl} does not look like a CIF file.`);
  }
  fs.mkdirSync(path.dirname(cifPath), { recursive: true });
  fs.writeFileSync(cifPath, textBody, "utf8");
  return { cifUrl, cifPath };
}

function normalizeFormula(value) {
  return String(value || "")
    .replace(/[-+()[\]{}.,;:_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formulaElements(value) {
  const elements = new Set();
  const text = String(value || "");
  for (const match of text.matchAll(/\b([A-Z][a-z]?)(?:[0-9.]+)?\b/g)) {
    elements.add(match[1]);
  }
  return [...elements].sort();
}

function formulaElementSetEqual(left, right) {
  const a = formulaElements(left);
  const b = formulaElements(right);
  return a.length > 0 && a.length === b.length && a.every((element, index) => element === b[index]);
}

function codCandidateScore(row, { query, formula }) {
  const haystack = [
    row.commonname,
    row.chemname,
    row.mineral,
    row.title,
    row.formula,
    row.calcformula,
    row.cellformula,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const queryTerms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2);
  const matchedTerms = queryTerms.filter((term) => haystack.includes(term)).length;
  const termScore = queryTerms.length ? matchedTerms / queryTerms.length : 0;
  const normalizedExpected = normalizeFormula(formula);
  const formulaText = normalizeFormula(row.calcformula || row.formula || row.cellformula || "");
  const exactFormula = normalizedExpected && formulaText.includes(normalizedExpected);
  const elementMatch = normalizedExpected && formulaElementSetEqual(formula, row.calcformula || row.formula || row.cellformula);
  const nameHit = termScore >= 0.6 ? 0.35 : termScore * 0.35;
  const formulaHit = exactFormula ? 0.45 : elementMatch ? 0.25 : 0;
  const hasPublication = row.title || row.authors || row.journal ? 0.12 : 0;
  const hasCell = row.a && row.b && row.c ? 0.08 : 0;
  return Math.min(1, nameHit + formulaHit + hasPublication + hasCell);
}

function codCandidateSummary(row, score = 0) {
  return {
    source: "cod",
    codId: row.file,
    confidence: Number(score.toFixed(3)),
    formula: row.calcformula || row.formula || row.cellformula || null,
    commonname: row.commonname || null,
    chemname: row.chemname || null,
    mineral: row.mineral || null,
    title: row.title || null,
    authors: row.authors || null,
    journal: row.journal || null,
    year: row.year || null,
    spaceGroup: row.sg || null,
    cell: {
      a: row.a || null,
      b: row.b || null,
      c: row.c || null,
      alpha: row.alpha || null,
      beta: row.beta || null,
      gamma: row.gamma || null,
    },
    cifUrl: row.file ? cifUrlFromSource({ source: "cod", codId: row.file }) : null,
  };
}

async function searchCodOpenCif({ query, formula, maxResults = 10 }) {
  const params = new URLSearchParams({
    format: "json",
    count: String(Math.min(Math.max(maxResults, 1), 50)),
  });
  if (query) params.set("text1", query);
  if (formula) params.set("formula", formula);
  const url = `https://www.crystallography.net/cod/result.php?${params.toString()}`;
  const response = await fetch(url, { headers: { "user-agent": "MS-MCP/0.2.0" } });
  if (!response.ok) throw new Error(`COD search failed (${response.status}) from ${url}`);
  const rows = await response.json();
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.file)
    .map((row) => {
      const score = codCandidateScore(row, { query, formula });
      return codCandidateSummary(row, score);
    })
    .sort((a, b) => b.confidence - a.confidence);
  return { searchUrl: url, candidates };
}

async function trySearchCodOpenCif({ query, formula, maxResults = 10 }) {
  try {
    return await searchCodOpenCif({ query, formula, maxResults });
  } catch (error) {
    return {
      searchUrl: null,
      candidates: [],
      searchError: error instanceof Error ? error.message : String(error),
    };
  }
}

function currentExportImportGuard({ inputPath, state }) {
  if (!state?.currentDocument) return null;
  if (state.currentExport && sameResolvedPath(inputPath, state.currentExport)) {
    return {
      ok: false,
      error:
        `Refusing to import ${inputPath} because it is the workspace export of current GUI document ${state.currentDocument}. ` +
        "Continue with ms_gui_*_current tools on the current document; do not re-import exported work copies.",
    };
  }
  if (/\.xsd$/i.test(inputPath) && isInsidePath(config.projectRoot, inputPath)) {
    return {
      ok: false,
      error:
        `Refusing to import project-session XSD ${inputPath} while currentDocument is ${state.currentDocument}. ` +
        "Project-session XSD files are work/output copies; importing them creates duplicate GUI documents.",
    };
  }
  return null;
}

function inPlaceDocumentNameGuard({ state, documentName, exportFile, operation }) {
  if (!documentName || !state?.currentDocument) return null;
  const requested = normalizeVisibleDocumentName(documentName);
  const current = normalizeVisibleDocumentName(state.currentDocument);
  if (requested === current) return null;
  const exportName = exportFile ? normalizeVisibleDocumentName(path.basename(exportFile)) : null;
  const currentExportName = state.currentExport ? normalizeVisibleDocumentName(path.basename(state.currentExport)) : null;
  if (requested === exportName || requested === currentExportName) {
    return {
      ok: false,
      error:
        `${operation} edits an existing GUI document in place. documentName is a selector, not an output name. ` +
        `Current document is ${state.currentDocument}; requested documentName ${documentName} looks like an exported work/output copy. ` +
        "Omit documentName and keep exportFile only if Codex needs a workspace copy, or use a create/import tool only for a truly new structure.",
    };
  }
  return null;
}

function createDocumentNameGuard({ state, documentName, forceNew, operation }) {
  if (!state?.currentDocument || forceNew) return null;
  const requested = normalizeVisibleDocumentName(documentName);
  const current = normalizeVisibleDocumentName(state.currentDocument);
  if (requested === current) return null;
  return {
    ok: false,
    error:
      `${operation} would create or replace ${documentName}, but the current GUI document is ${state.currentDocument}. ` +
      "This MCP keeps one active GUI structure per session to prevent stray XSD files. " +
      "Use the current document name to rebuild in place, start a new project session for a separate structure, or set forceNew=true only when the user explicitly wants a separate GUI document.",
  };
}

function calculationDocumentName(value, fallback) {
  const clean = String(value || fallback)
    .replace(/[/\\:*?"<>|]+/g, "_")
    .replace(/\s+\(\d+\)(?=\.xsd$|$)/i, "");
  return ensureXsdName(clean);
}

function modelingExportPath({ exportFile, state, documentName }) {
  if (!exportFile) return null;
  const normalized = exportFile.replace(/\\/g, "/");
  if (/_current\.xsd$/i.test(path.basename(normalized))) {
    return assertInside(config.workRoot, path.join(path.dirname(projectOutputPath(normalized)), stripModelingWorkSuffix(normalized)));
  }
  return projectOutputPath(exportFile);
}

function safeCalcName(value) {
  return String(value || "DMol3_Calculation")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "DMol3_Calculation";
}

function compactSubject(value, { moduleName, taskName = "geomopt", fallback = "calculation", maxLength = 24 }) {
  const raw = safeCalcName(value || fallback)
    .replace(new RegExp(`^${moduleName}[_-]*`, "i"), "")
    .replace(new RegExp(`[_-]*${moduleName}$`, "i"), "");
  const stopWords = new Set([
    "",
    "calculation",
    "calc",
    "geometry",
    "optimization",
    "geometryoptimization",
    "geomopt",
    "opt",
    "optimize",
    "current",
    "gui",
    "coarse",
    "medium",
    "fine",
    "ultra",
    "universal",
    "compass",
    "compassii",
    "compassiii",
    "dreiding",
    "uff",
    taskName.toLowerCase(),
    moduleName.toLowerCase(),
  ]);
  const subject = raw
    .split(/[_\-.]+/)
    .filter((part) => !stopWords.has(part.toLowerCase()))
    .join("_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength)
    .replace(/_+$/g, "");
  return subject || fallback;
}

function compactCalculationName(value, { moduleName, taskName = "geomopt", fallback = "calculation" }) {
  const subject = compactSubject(value, { moduleName, taskName, fallback });
  return `${moduleName}_${subject}_${taskName}`;
}

function perlLiteral(value) {
  return `"${String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/@/g, "\\@")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")}"`;
}

function perlPathLiteral(value) {
  return perlLiteral(String(value).replace(/\\/g, "/"));
}

function perlSettings(settings = {}) {
  const entries = Object.entries(settings || {}).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return "Settings()";
  return `Settings(${entries
    .map(([key, value]) => {
      if (typeof value === "number") return `${key} => ${value}`;
      if (typeof value === "boolean") return `${key} => ${value ? '"Yes"' : '"No"'}`;
      return `${key} => ${perlLiteral(value)}`;
    })
    .join(", ")})`;
}

function latticeVectorExpression({ a, b, c, alpha, beta, gamma }) {
  const deg = Math.PI / 180;
  const cosAlpha = Math.cos(alpha * deg);
  const cosBeta = Math.cos(beta * deg);
  const cosGamma = Math.cos(gamma * deg);
  const sinGamma = Math.sin(gamma * deg);
  if (Math.abs(sinGamma) < 1e-8) {
    throw new Error("gamma angle is too close to 0 or 180 degrees.");
  }
  const ax = a;
  const ay = 0;
  const az = 0;
  const bx = b * cosGamma;
  const by = b * sinGamma;
  const bz = 0;
  const cx = c * cosBeta;
  const cy = (c * (cosAlpha - cosBeta * cosGamma)) / sinGamma;
  const cz2 = c * c - cx * cx - cy * cy;
  if (cz2 < -1e-6) {
    throw new Error("Cell parameters do not form a valid 3D lattice.");
  }
  const cz = Math.sqrt(Math.max(0, cz2));
  return {
    ax,
    ay,
    az,
    bx,
    by,
    bz,
    cx,
    cy,
    cz,
  };
}

function crystalAtomBuildSnippet({ atoms, coordinateType, cell }) {
  const vectors = coordinateType === "fractional" ? latticeVectorExpression(cell) : null;
  return atoms
    .map((atom, index) => {
      const label = atom.label ? String(atom.label).replace(/[^A-Za-z0-9_]+/g, "_") : `${atom.element}${index + 1}`;
      let x = Number(atom.x);
      let y = Number(atom.y);
      let z = Number(atom.z);
      if (coordinateType === "fractional") {
        x = atom.x * vectors.ax + atom.y * vectors.bx + atom.z * vectors.cx;
        y = atom.x * vectors.ay + atom.y * vectors.by + atom.z * vectors.cy;
        z = atom.x * vectors.az + atom.y * vectors.bz + atom.z * vectors.cz;
      }
      return `my $atom_${index} = $doc->CreateAtom(${perlLiteral(atom.element)}, Point(X => ${x}, Y => ${y}, Z => ${z}));
$atom_${index}->Name = ${perlLiteral(label)};
`;
    })
    .join("");
}

function moleculeAtomBuildSnippet({ atoms, bonds }) {
  const labelToVar = new Map();
  const atomLines = atoms
    .map((atom, index) => {
      const label = atom.label ? String(atom.label).replace(/[^A-Za-z0-9_]+/g, "_") : `${atom.element}${index + 1}`;
      if (labelToVar.has(label)) throw new Error(`Duplicate atom label: ${label}`);
      const varName = `atom_${index}`;
      labelToVar.set(label, varName);
      return `my $${varName} = $doc->CreateAtom(${perlLiteral(atom.element)}, Point(X => ${Number(atom.x)}, Y => ${Number(atom.y)}, Z => ${Number(atom.z)}));
$${varName}->Name = ${perlLiteral(label)};
`;
    })
    .join("");
  const bondLines = (bonds || [])
    .map((bond) => {
      const from = labelToVar.get(bond.from);
      const to = labelToVar.get(bond.to);
      if (!from || !to) throw new Error(`Bond references unknown atom label: ${bond.from}-${bond.to}`);
      return `$doc->CreateBond($${from}, $${to}, ${perlLiteral(bond.order || "Single")});\n`;
    })
    .join("");
  return `${atomLines}${bondLines}`;
}

function defaultStructureDocumentName(query, documentName) {
  if (documentName) return stripModelingWorkSuffix(documentName);
  return `${safeStructureStem(query, "structure")}.xsd`;
}

function shouldSearchOpenCif({ policy, kind }) {
  if (policy === "manual") return false;
  return kind !== "molecule";
}

function credentialedSourceResponse({ query, formula, minConfidence, search, reason }) {
  return {
    ok: false,
    imported: false,
    reason,
    query,
    formula: formula || null,
    minConfidence,
    searchUrl: search?.searchUrl || null,
    searchError: search?.searchError || null,
    candidates: search?.candidates || [],
    nextStep:
      "Provide an existing CIF, provide configured ICSD/CSD/Materials Project/OQMD access, or pass manual modeling parameters so MS-MCP can create the structure through the GUI.",
    credentialedSourcesMayHelp: ["ICSD", "CSD", "Materials Project API", "OQMD API"],
  };
}

function atomLookupSnippet() {
  return `
sub find_atom {
    my ($doc, $selector) = @_;
    die "Atom selector is required" unless defined $selector && length($selector);
    my $atoms = $doc->AsymmetricUnit->Atoms;
    if ($selector =~ /^\\d+$/) {
        my $index = int($selector) - 1;
        die "Atom index out of range: $selector" if $index < 0 || $index >= $atoms->Count;
        return $atoms->Item($index);
    }
    foreach my $atom (@$atoms) {
        return $atom if $atom->Name eq $selector;
    }
    die "Atom not found: $selector";
}

sub find_bond_between {
    my ($doc, $atom1, $atom2) = @_;
    my $name1 = $atom1->Name;
    my $name2 = $atom2->Name;
    foreach my $bond (@{$doc->Bonds}) {
        my $b1 = $bond->Atom1;
        my $b2 = $bond->Atom2;
        my $b1_name = $b1->Name;
        my $b2_name = $b2->Name;
        return $bond if (($b1_name eq $name1 && $b2_name eq $name2) || ($b1_name eq $name2 && $b2_name eq $name1));
    }
    return undef;
}
`;
}

function guiEditActionSnippet({ operation, atom, atom1, atom2, element, bondType, x, y, z, name, cleanIterations, allowPeriodicBondGuess }) {
  const op = operation;
  if (op === "Clean") {
    return `my $converged = 0;
for (my $i = 0; $i < ${cleanIterations}; $i++) {
    $converged = $doc->Clean;
    last if $converged;
}
`;
  }
  if (op === "AdjustHydrogen") {
    return "$doc->AdjustHydrogen;\n";
  }
  if (op === "CleanAndAdjustHydrogen") {
    return `$doc->AdjustHydrogen;
my $converged = 0;
for (my $i = 0; $i < ${cleanIterations}; $i++) {
    $converged = $doc->Clean;
    last if $converged;
}
$doc->AdjustHydrogen;
`;
  }
  if (op === "CalculateBonds") {
    return `${allowPeriodicBondGuess ? "" : `if ($doc->Lattice3D) {
    die "Refusing broad CalculateBonds on a periodic document. Use explicit AddBond/SetBondType steps or pass allowPeriodicBondGuess=true only when the user explicitly accepts periodic bond guessing.";
}
`}$doc->CalculateBonds;\n`;
  }
  if (op === "ChangeElement") {
    if (!atom || !element) throw new Error("ChangeElement requires atom and element.");
    return `my $atom = find_atom($doc, ${perlLiteral(atom)});
$atom->ElementSymbol = ${perlLiteral(element)};
`;
  }
  if (op === "AddBond") {
    if (!atom1 || !atom2) throw new Error("AddBond requires atom1 and atom2.");
    return `my $atom1 = find_atom($doc, ${perlLiteral(atom1)});
my $atom2 = find_atom($doc, ${perlLiteral(atom2)});
my $existing = find_bond_between($doc, $atom1, $atom2);
if ($existing) {
    $existing->BondType = ${perlLiteral(bondType || "Single")};
} else {
    $doc->CreateBond($atom1, $atom2, ${perlLiteral(bondType || "Single")});
}
`;
  }
  if (op === "DeleteBond") {
    if (!atom1 || !atom2) throw new Error("DeleteBond requires atom1 and atom2.");
    return `my $atom1 = find_atom($doc, ${perlLiteral(atom1)});
my $atom2 = find_atom($doc, ${perlLiteral(atom2)});
my $bond = find_bond_between($doc, $atom1, $atom2);
die "Bond not found between ${atom1} and ${atom2}" unless $bond;
$bond->Delete;
`;
  }
  if (op === "SetBondType") {
    if (!atom1 || !atom2 || !bondType) throw new Error("SetBondType requires atom1, atom2, and bondType.");
    return `my $atom1 = find_atom($doc, ${perlLiteral(atom1)});
my $atom2 = find_atom($doc, ${perlLiteral(atom2)});
my $bond = find_bond_between($doc, $atom1, $atom2);
die "Bond not found between ${atom1} and ${atom2}" unless $bond;
$bond->BondType = ${perlLiteral(bondType)};
`;
  }
  if (op === "DeleteAtom") {
    if (!atom) throw new Error("DeleteAtom requires atom.");
    return `my $atom = find_atom($doc, ${perlLiteral(atom)});
$atom->Delete;
`;
  }
  if (op === "AddAtom") {
    if (!element || x === undefined || y === undefined || z === undefined) {
      throw new Error("AddAtom requires element, x, y, and z.");
    }
    const rename = name ? `$new_atom->Name = ${perlLiteral(name)};\n` : "";
    const connect = atom1
      ? `my $anchor = find_atom($doc, ${perlLiteral(atom1)});
$doc->CreateBond($anchor, $new_atom, ${perlLiteral(bondType || "Single")});
`
      : "";
    return `my $new_atom = $doc->CreateAtom(${perlLiteral(element)}, Point(X => ${x}, Y => ${y}, Z => ${z}));
${rename}${connect}`;
  }
  if (op === "RenameAtom") {
    if (!atom || !name) throw new Error("RenameAtom requires atom and name.");
    return `my $atom = find_atom($doc, ${perlLiteral(atom)});
$atom->Name = ${perlLiteral(name)};
`;
  }
  throw new Error(`Unsupported GUI edit operation: ${operation}`);
}

const castepBaseTasks = ["Energy", "GeometryOptimization", "Dynamics", "ElasticConstants", "Properties"];
const castepCalculationTypes = [
  "Energy",
  "GeometryOptimization",
  "Frequency",
  "DensityOfStates",
  "PartialDensityOfStates",
  "BandStructure",
  "BandStructureAndDOS",
  "ChargeDensity",
  "DensityDifference",
];

function castepPreset(calculationType) {
  switch (calculationType) {
    case "Energy":
      return { task: "Energy", settings: {} };
    case "GeometryOptimization":
      return { task: "GeometryOptimization", settings: {} };
    case "Frequency":
      return {
        task: "Energy",
        settings: {
          CalculatePhononDOS: "Full",
          CalculatePhononDispersion: "DispersionAndDos",
        },
      };
    case "DensityOfStates":
      return { task: "Energy", settings: { CalculateDOS: "Full" } };
    case "PartialDensityOfStates":
      return { task: "Energy", settings: { CalculateDOS: "Partial" } };
    case "BandStructure":
      return { task: "Energy", settings: { CalculateBandStructure: "Dispersion" } };
    case "BandStructureAndDOS":
      return {
        task: "Energy",
        settings: {
          CalculateBandStructure: "DispersionAndDos",
          CalculateDOS: "Full",
        },
      };
    case "ChargeDensity":
      return { task: "Energy", settings: { CalculateChargeDensity: "FieldAndIsosurface" } };
    case "DensityDifference":
      return { task: "Energy", settings: { CalculateDensityDifference: "FieldAndIsosurface" } };
    default:
      if (castepBaseTasks.includes(calculationType)) return { task: calculationType, settings: {} };
      throw new Error(`Unsupported CASTEP calculation type: ${calculationType}`);
  }
}

function mergeSettings(...settingsObjects) {
  return Object.assign({}, ...settingsObjects.filter(Boolean));
}

function settingsToPerl(settings) {
  return Object.entries(settings)
    .map(([key, value]) => {
      const encoded = typeof value === "number"
        ? String(value)
        : typeof value === "boolean"
          ? perlLiteral(value ? "Yes" : "No")
          : perlLiteral(value);
      return `${perlLiteral(key)} => ${encoded}`;
    })
    .join(",\n        ");
}

function assertGuiBodyIsInPlace(body, toolName) {
  const forbidden = [
    { pattern: /\bDocuments\s*->\s*New\b/i, label: "Documents->New" },
    { pattern: /\bDocuments\s*->\s*Import\b/i, label: "Documents->Import" },
    { pattern: /->\s*SaveAs\s*\(/i, label: "SaveAs" },
    { pattern: /->\s*Export\s*\(/i, label: "Export" },
  ];
  const hit = forbidden.find(({ pattern }) => pattern.test(body));
  if (hit) {
    throw new Error(`${toolName} body must modify the current $doc in place. Do not use ${hit.label}; import once with ms_gui_import_current, then edit/expand the current document.`);
  }
}

function guiDocumentReuseSnippet(nameExpression) {
  return `
sub ms_mcp_doc_base_name {
  my ($name) = @_;
  $name = "" unless defined $name;
  $name =~ s/\\.xsd$//i;
  $name =~ s/\\s+\\(\\d+\\)$//;
  return $name;
}
sub ms_mcp_try_project_doc {
  my ($name) = @_;
  my $candidate;
  eval { $candidate = $Documents{$name}; };
  return $candidate if $candidate;
  eval { $candidate = Documents->Item($name); };
  return $candidate if $candidate;
  if ($name =~ /^(.*)\\.xsd$/i) {
    my $stem = $1;
    eval { $candidate = $Documents{$stem}; };
    return $candidate if $candidate;
    eval { $candidate = Documents->Item($stem); };
    return $candidate if $candidate;
  }
  return undef;
}
sub ms_mcp_is_3d_document {
  my ($candidate) = @_;
  return 0 unless $candidate;
  my $ok = 0;
  eval { my $atoms = $candidate->Atoms; $ok = 1 if $atoms; };
  return $ok;
}
sub ms_mcp_find_named_3d_doc {
  my ($name) = @_;
  my $base = ms_mcp_doc_base_name($name);
  my $canonical = ms_mcp_find_canonical_3d_doc($name);
  return $canonical if ms_mcp_is_3d_document($canonical);
  my $doc = ms_mcp_try_project_doc($name);
  return $doc if ms_mcp_is_3d_document($doc);
  my $count = 0;
  eval { $count = Documents->Count; };
  for (my $i = $count - 1; $i >= 0; $i--) {
    my $candidate = Documents->Item($i);
    next unless ms_mcp_is_3d_document($candidate);
    my $candidate_name = "";
    eval { $candidate_name = $candidate->Name; };
    return $candidate if ms_mcp_doc_base_name($candidate_name) eq $base;
  }
  return undef;
}
sub ms_mcp_find_canonical_3d_doc {
  my ($name) = @_;
  my $base = ms_mcp_doc_base_name($name);
  my $fallback;
  my $count = 0;
  eval { $count = Documents->Count; };
  for (my $i = $count - 1; $i >= 0; $i--) {
    my $candidate = Documents->Item($i);
    next unless ms_mcp_is_3d_document($candidate);
    my $candidate_name = "";
    eval { $candidate_name = $candidate->Name; };
    next unless ms_mcp_doc_base_name($candidate_name) eq $base;
    $fallback = $candidate unless $fallback;
    return $candidate unless $candidate_name =~ /\\s+\\(\\d+\\)(\\.xsd)?$/i;
  }
  return $fallback;
}
sub ms_mcp_clear_3d_doc {
  my ($target) = @_;
  return unless $target;
  eval { $target->Bonds->Delete; };
  eval { $target->Atoms->Delete; };
  eval { $target->AsymmetricUnit->Bonds->Delete; };
  eval { $target->AsymmetricUnit->Atoms->Delete; };
}
sub ms_mcp_delete_numbered_duplicates {
  my ($keep_doc, $name) = @_;
  my $base = ms_mcp_doc_base_name($name);
  my $keep_name = "";
  eval { $keep_name = $keep_doc->Name if $keep_doc; };
  my $count = 0;
  eval { $count = Documents->Count; };
  for (my $i = $count - 1; $i >= 0; $i--) {
    my $candidate = Documents->Item($i);
    next unless $candidate;
    my $candidate_name = "";
    eval { $candidate_name = $candidate->Name; };
    next if length($keep_name) && $candidate_name eq $keep_name;
    next unless ms_mcp_doc_base_name($candidate_name) eq $base;
    next unless $candidate_name =~ /\\s+\\(\\d+\\)(\\.xsd)?$/i;
    eval { $candidate->Delete; };
  }
}
my $ms_mcp_requested_doc_name = ${nameExpression};
`;
}

function guiCalculationCleanupSnippet({ calcNameExpression, sourceNameExpression }) {
  return `
sub ms_mcp_cleanup_failed_calculation_folder {
  my ($folder_name) = @_;
  return unless defined $folder_name && length($folder_name);
  my $count = 0;
  eval { $count = Documents->Count; };
  for (my $i = $count - 1; $i >= 0; $i--) {
    my $candidate = Documents->Item($i);
    next unless $candidate;
    my $path = "";
    my $name = "";
    eval { $path = $candidate->Path; };
    eval { $name = $candidate->Name; };
    if ($path =~ m{/$folder_name(?:/|$)}i || $name =~ /^\\Q$folder_name\\E(?:\\s*[-_].*)?$/i) {
      eval { $candidate->Delete; };
    }
  }
}
sub ms_mcp_cleanup_root_calculation_artifacts {
  my ($source_name) = @_;
  my $base = ms_mcp_doc_base_name($source_name);
  return unless length($base);
  my $count = 0;
  eval { $count = Documents->Count; };
  for (my $i = $count - 1; $i >= 0; $i--) {
    my $candidate = Documents->Item($i);
    next unless $candidate;
    my $name = "";
    my $path = "";
    eval { $name = $candidate->Name; };
    eval { $path = $candidate->Path; };
    next if $path =~ m{/[^/]+/[^/]+$};
    next unless $name =~ /^\\Q$base\\E\\s+(Convergence|Energies)\\.xcd$/i
             || $name =~ /^Status\\.txt$/i
             || $name =~ /^\\Q$base\\E\\.(txt|outmol)$/i;
    eval { $candidate->Delete; };
  }
}
my $ms_mcp_calc_folder_name = ${calcNameExpression};
my $ms_mcp_calc_source_name = ${sourceNameExpression};
`;
}

server.tool(
  "ms_status",
  "Check Materials Studio paths, RunMatScript availability, and MS-MCP workspace.",
  {},
  async () => text(summarizeConfig(config)),
);

server.tool(
  "ms_codex_config",
  "Return an MCP server config snippet that can be pasted into Codex settings.",
  {},
  async () =>
    text({
      mcpServers: {
        "MS-MCP": {
          command: "node",
          args: [path.join(config.repoRoot, "src", "index.js")],
          env: {
            MS_INSTALL_ROOT: config.installRoot,
            MS_MCP_WORK_ROOT: config.workRoot,
          },
        },
      },
      note: "If this repository is cloned elsewhere, replace args[0] with the cloned src/index.js path.",
    }),
);

server.tool(
  "ms_run_materialscript",
  "Run a MaterialsScript Perl script through RunMatScript. Disabled by default unless MS_MCP_ALLOW_ARBITRARY_SCRIPT=1.",
  {
    name: z.string().default("custom_job"),
    script: z.string().min(1),
    args: z.array(z.string()).default([]),
    project: z.boolean().default(false),
    cores: z.number().int().positive().optional(),
  },
  async ({ name, script, args, project, cores }) => {
    if (!config.allowArbitraryScript) {
      return text({
        ok: false,
        error:
          "Arbitrary MaterialsScript execution is disabled. Set MS_MCP_ALLOW_ARBITRARY_SCRIPT=1 only when you trust the requester.",
      });
    }
    const jobDir = newJobDir(config, name);
    const scriptFile = writeScript(jobDir, name, script);
    const result = await runMatScript(config, scriptFile, args, { project, cores });
    return text({ ...result, jobDir, scriptFile });
  },
);

server.tool(
  "ms_enqueue_materialscript",
  "Queue a MaterialsScript Perl command for the optional in-Materials-Studio mcp_loop_gui.pl runner. Disabled unless MS_MCP_ALLOW_ARBITRARY_SCRIPT=1.",
  {
    name: z.string().default("queued_job"),
    script: z.string().min(1),
  },
  async ({ name, script }) => {
    if (!config.allowArbitraryScript) {
      return text({
        ok: false,
        error:
          "Queueing arbitrary MaterialsScript is disabled. Set MS_MCP_ALLOW_ARBITRARY_SCRIPT=1 only when you trust the requester.",
      });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
    const pendingDir = assertInside(config.queueDir, path.join(config.queueDir, "pending"));
    fs.mkdirSync(pendingDir, { recursive: true });
    const file = assertInside(pendingDir, path.join(pendingDir, `${stamp}_${safe}.pl`));
    fs.writeFileSync(file, script, "utf8");
    return text({ ok: true, queued: file });
  },
);

server.tool(
  "ms_queue_status",
  "Inspect the optional MS-MCP GUI queue folders.",
  {},
  async () => {
    const folders = ["pending", "running", "done", "failed", "held"];
    const status = {};
    for (const folder of folders) {
      const dir = path.join(config.queueDir, folder);
      fs.mkdirSync(dir, { recursive: true });
      status[folder] = fs.readdirSync(dir).sort();
    }
    return text({ queueDir: config.queueDir, ...status });
  },
);

server.tool(
  "ms_gui_state",
  "Get the stateful GUI session target: current document, current exported file, last job, and history.",
  {},
  async () => text({ ...readState(config), projectRoot: config.projectRoot, projectFolderName: config.projectFolderName }),
);

server.tool(
  "ms_gui_project_dir",
  "Ensure and return the current MS-MCP task/session output directory under the workspace.",
  {},
  async () => {
    refreshProjectSession(config);
    fs.mkdirSync(config.projectRoot, { recursive: true });
    return text({
      workRoot: config.workRoot,
      projectRoot: config.projectRoot,
      projectFolderName: config.projectFolderName,
      note: "Modeling exports and standalone calculation job folders are written here by default. Queue and state files stay at the workspace root.",
    });
  },
);

server.tool(
  "ms_gui_start_project_session",
  "Start a new MS-MCP task/session folder under the workspace, such as YYYY-MM-DD-1, for subsequent GUI modeling and calculation outputs. Use only when the user explicitly asks for a new task/session; normal modeling should reuse the Dashboard/current session.",
  {
    folderName: z.string().optional().describe("Optional explicit folder name. If omitted, MS-MCP chooses the next YYYY-MM-DD-N folder."),
    allowExistingSessionSwitch: z.boolean().default(false).describe("Required when a session already exists. Prevents accidental folder creation/switching during normal modeling."),
  },
  async ({ folderName, allowExistingSessionSwitch }) => {
    refreshProjectSession(config);
    const existingState = readState(config);
    const hasExistingSession = fs.existsSync(config.projectRoot) || fs.existsSync(config.stateFile) || existingState.currentDocument || existingState.lastJob;
    if (hasExistingSession && !allowExistingSessionSwitch) {
      return text({
        ok: false,
        error:
          "A current MS-MCP session already exists. Refusing to start/switch project session during normal modeling because it creates extra workspace folders. " +
          "Use the existing session, select a session in Dashboard, or call ms_gui_start_project_session with allowExistingSessionSwitch=true only when the user explicitly wants a new task folder.",
        currentProjectRoot: config.projectRoot,
        currentProjectFolderName: config.projectFolderName,
        state: existingState,
      });
    }
    startNewProjectSession(config, folderName);
    writeState(config, {
      currentDocument: null,
      currentExport: null,
      lastJob: {
        type: "start_project_session",
        projectFolderName: config.projectFolderName,
        projectRoot: config.projectRoot,
        at: new Date().toISOString(),
      },
      history: [],
    });
    return text({
      ok: true,
      workRoot: config.workRoot,
      projectRoot: config.projectRoot,
      projectFolderName: config.projectFolderName,
      stateFile: config.stateFile,
      note: "Subsequent GUI modeling exports, trace files, settings files, and calculation folders will use this session folder. The hidden .mcp-queue remains at the workspace root for the GUI loop.",
    });
  },
);

server.tool(
  "ms_gui_set_current_document",
  "Set the current Materials Studio GUI document for subsequent stateful operations. This does not create a file.",
  {
    documentName: z.string().min(1),
    exportFile: z.string().optional(),
  },
  async ({ documentName, exportFile }) => {
    const finalDocumentName = stripModelingWorkSuffix(documentName);
    const exportPath = exportFile ? modelingExportPath({ exportFile, state: null, documentName: finalDocumentName }) : null;
    const next = writeState(config, {
      currentDocument: finalDocumentName,
      currentExport: exportPath,
      lastJob: {
        type: "set_current_document",
        documentName: finalDocumentName,
        exportPath,
        at: new Date().toISOString(),
      },
    });
    appendHistory(config, { type: "set_current_document", documentName: finalDocumentName, exportPath });
    return text(next);
  },
);

server.tool(
  "ms_gui_import_current",
  "Queue an import into the open Materials Studio GUI project and make the imported document the current document. Import external source files only; do not import XSD files that MS-MCP just exported from the current GUI document.",
  {
    file: z.string().min(1),
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    ballAndStick: z.boolean().default(true),
  },
  async ({ file, documentName, exportFile, ballAndStick }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const inputPath = readableInputPath(file);
    const importGuard = currentExportImportGuard({ inputPath, state });
    if (importGuard) return text(importGuard);
    const finalName = guiImportDocumentName(inputPath, documentName);
    const exportPath = modelingExportPath({ exportFile, state: null, documentName: finalName });
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Import current ${finalName}`)}
my $doc;
${guiDocumentReuseSnippet(`"${finalName.replace(/"/g, '\\"')}"`)}
$doc = ms_mcp_find_named_3d_doc($ms_mcp_requested_doc_name);
if (!$doc) {
  $doc = Documents->Import("${inputPath.replace(/\\/g, "/")}");
}
my $canonical_doc = ms_mcp_find_canonical_3d_doc($ms_mcp_requested_doc_name);
$doc = $canonical_doc if $canonical_doc;
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save: false })}
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "import_current", requestedDocumentName: finalName, exportPath },
})}
print "Imported ${finalName} as current document\\n";
`;
    const queued = queueScript(config, "gui_import_current", script);
    writeState(config, { currentDocument: finalName, currentExport: exportPath, lastJob: { type: "queued_import", queued } });
    appendHistory(config, { type: "queued_import", documentName: finalName, exportPath, queued });
    return text({ ok: true, queued, currentDocument: finalName, exportPath });
  },
);

server.tool(
  "ms_gui_download_cif_import_current",
  "Download a CIF from an open supported source or direct CIF URL, store it once in the active task session, optionally import it into the open GUI project, and make it current. Use this before modeling when a reliable database CIF is available. Do not use this to bypass login/license walls; credentialed databases require user-provided existing credentials/API configuration.",
  {
    source: z.enum(["cod", "url"]).default("url").describe("CIF source. Use cod for Crystallography Open Database numeric IDs, or url for a direct CIF link."),
    codId: z.string().optional().describe("COD numeric id, required when source=cod."),
    url: z.string().url().optional().describe("Direct CIF URL, required when source=url."),
    fileName: z.string().optional().describe("Optional local CIF base name without path."),
    documentName: z.string().optional().describe("Optional Materials Studio document name. Defaults to the CIF file name with .xsd."),
    importToGui: z.boolean().default(true).describe("If true, queue an import into the current GUI project after download."),
    ballAndStick: z.boolean().default(true),
  },
  async ({ source, codId, url, fileName, documentName, importToGui, ballAndStick }) => {
    ensureGuiQueueAllowed();
    const { cifUrl, cifPath } = await downloadCifToProject({ source, url, codId, fileName });
    const finalName = guiImportDocumentName(cifPath, documentName);
    if (!importToGui) {
      writeState(config, {
        currentDocument: null,
        currentExport: null,
        lastJob: { type: "download_cif", cifUrl, cifPath, at: new Date().toISOString() },
      });
      appendHistory(config, { type: "download_cif", cifUrl, cifPath });
      return text({ ok: true, cifUrl, cifPath, imported: false });
    }
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Download CIF import ${finalName}`)}
my $doc;
${guiDocumentReuseSnippet(`"${finalName.replace(/"/g, '\\"')}"`)}
$doc = ms_mcp_find_named_3d_doc($ms_mcp_requested_doc_name);
if (!$doc) {
  $doc = Documents->Import("${cifPath.replace(/\\/g, "/")}");
}
my $canonical_doc = ms_mcp_find_canonical_3d_doc($ms_mcp_requested_doc_name);
$doc = $canonical_doc if $canonical_doc;
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${ballAndStick ? ballStickSnippet() : ""}
${stateWriteRuntimeDocSnippet(config, {
  currentExport: null,
  lastJob: { type: "download_cif_import_current", requestedDocumentName: finalName, cifPath, cifUrl },
})}
print "Downloaded and imported CIF ${finalName}\\n";
`;
    const queued = queueScript(config, "gui_download_cif_import_current", script);
    writeState(config, { currentDocument: finalName, currentExport: null, lastJob: { type: "queued_download_cif_import", queued, cifUrl, cifPath } });
    appendHistory(config, { type: "queued_download_cif_import", documentName: finalName, cifUrl, cifPath, queued });
    return text({ ok: true, cifUrl, cifPath, imported: true, queued, currentDocument: finalName });
  },
);

server.tool(
  "ms_gui_find_cif_import_current",
  "Search open crystallographic databases for a reliable CIF, download it once, import it into the current GUI project, and make it current. Use this before manually building a new crystal or molecular crystal. It only uses open sources; if the requested structure appears to require credentialed databases such as ICSD/CSD/Materials Project API, return candidates/reason so the user can provide access instead of bypassing login walls.",
  {
    query: z.string().min(1).describe("Material, mineral, compound, molecule, or structure name to search for."),
    formula: z.string().optional().describe("Optional chemical formula used to raise confidence and reject unrelated search hits."),
    maxResults: z.number().int().positive().max(50).default(10),
    minConfidence: z.number().min(0).max(1).default(0.72),
    documentName: z.string().optional().describe("Optional Materials Studio document name. Defaults to the CIF file name with .xsd."),
    fileName: z.string().optional().describe("Optional local CIF base name without path."),
    importToGui: z.boolean().default(true),
    ballAndStick: z.boolean().default(true),
  },
  async ({ query, formula, maxResults, minConfidence, documentName, fileName, importToGui, ballAndStick }) => {
    ensureGuiQueueAllowed();
    let search = await trySearchCodOpenCif({ query, formula, maxResults });
    if (search.candidates.length === 0 && formula) {
      search = await trySearchCodOpenCif({ query, maxResults });
    }
    const [best, second] = search.candidates;
    const ambiguous = best && second && best.confidence - second.confidence < 0.05;
    if (!best || best.confidence < minConfidence || ambiguous) {
      return text({
        ok: false,
        imported: false,
        reason: search.searchError ? "open_cif_search_failed" : !best ? "no_open_cif_found" : ambiguous ? "ambiguous_open_cif_candidates" : "no_reliable_open_cif",
        searchError: search.searchError || null,
        searchUrl: search.searchUrl,
        query,
        formula: formula || null,
        minConfidence,
        candidates: search.candidates,
        nextStep:
          "Ask the user for an ICSD/CSD/Materials Project API credential or a specific CIF if those sources are required; otherwise manually build the structure with ms_gui_create_crystal_current or ms_gui_create_current.",
        credentialedSourcesMayHelp: ["ICSD", "CSD", "Materials Project API", "OQMD API"],
      });
    }
    const { cifUrl, cifPath } = await downloadCifToProject({
      source: "cod",
      codId: best.codId,
      fileName: fileName || safeStructureStem(`${safeStructureStem(query, "structure")}_${best.codId}`, "structure"),
    });
    const finalName = guiImportDocumentName(cifPath, documentName);
    if (!importToGui) {
      writeState(config, {
        currentDocument: null,
        currentExport: null,
        lastJob: { type: "find_cif", source: "cod", query, formula: formula || null, selected: best, cifUrl, cifPath, at: new Date().toISOString() },
      });
      appendHistory(config, { type: "find_cif", source: "cod", query, formula: formula || null, selected: best, cifUrl, cifPath });
      return text({ ok: true, imported: false, source: "cod", selected: best, cifUrl, cifPath, candidates: search.candidates });
    }
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Find CIF import ${finalName} from COD ${best.codId}`)}
my $doc;
${guiDocumentReuseSnippet(`"${finalName.replace(/"/g, '\\"')}"`)}
$doc = ms_mcp_find_named_3d_doc($ms_mcp_requested_doc_name);
if (!$doc) {
  $doc = Documents->Import("${cifPath.replace(/\\/g, "/")}");
}
my $canonical_doc = ms_mcp_find_canonical_3d_doc($ms_mcp_requested_doc_name);
$doc = $canonical_doc if $canonical_doc;
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${ballAndStick ? ballStickSnippet() : ""}
${stateWriteRuntimeDocSnippet(config, {
  currentExport: null,
  lastJob: { type: "find_cif_import_current", source: "cod", query, formula: formula || null, selected: best, requestedDocumentName: finalName, cifPath, cifUrl },
})}
print "Found, downloaded, and imported CIF ${finalName} from COD ${best.codId}\\n";
`;
    const queued = queueScript(config, "gui_find_cif_import_current", script);
    writeState(config, { currentDocument: finalName, currentExport: null, lastJob: { type: "queued_find_cif_import", queued, source: "cod", query, formula: formula || null, selected: best, cifUrl, cifPath } });
    appendHistory(config, { type: "queued_find_cif_import", source: "cod", query, formula: formula || null, documentName: finalName, selected: best, cifUrl, cifPath, queued });
    return text({ ok: true, imported: true, queued, currentDocument: finalName, source: "cod", selected: best, cifUrl, cifPath, candidates: search.candidates });
  },
);

server.tool(
  "ms_gui_new_structure_current",
  "Unified entry point for creating a new GUI structure. Decision order: if an open and reliable CIF can be found, download it and import it as the initial XSD/current GUI document; if a likely source exists but requires an account/API such as ICSD/CSD/Materials Project/OQMD, return candidates and ask the user for access instead of bypassing authentication; if no usable CIF source is available, fall back to controlled MCP GUI manual creation when manual atoms/cell data are provided. Build the primitive/base document first; do not name the initial document after a planned supercell size. Prefer this tool over direct create/import tools for first-time structure creation.",
  {
    query: z.string().min(1).describe("Material, molecule, crystal, or structure name."),
    kind: z.enum(["auto", "molecule", "crystal", "molecular_crystal", "two_d_material", "surface"]).default("auto"),
    formula: z.string().optional().describe("Optional formula used to raise CIF search confidence."),
    sourcePolicy: z.enum(["auto", "manual", "require_cif_first"]).optional().describe("Overrides MS_MCP_STRUCTURE_SOURCE_POLICY for this call."),
    documentName: z.string().optional().describe("Target Materials Studio document name. Defaults to a sanitized query plus .xsd."),
    fileName: z.string().optional().describe("Optional local CIF base name when a CIF is downloaded."),
    maxResults: z.number().int().positive().max(50).default(10),
    minConfidence: z.number().min(0).max(1).default(0.72),
    manualMode: z.enum(["none", "molecule", "crystal"]).default("none").describe("Manual fallback mode if no reliable open CIF is imported."),
    atoms: z
      .array(
        z.object({
          element: z.string().regex(/^[A-Z][a-z]?$/),
          label: z.string().optional(),
          x: z.number(),
          y: z.number(),
          z: z.number(),
        }),
      )
      .default([])
      .describe("Manual atoms. For crystal mode, coordinates are fractional or Cartesian according to coordinateType."),
    bonds: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          order: z.enum(["Single", "Double", "Triple", "Aromatic"]).default("Single"),
        }),
      )
      .default([])
      .describe("Manual molecule bonds by atom label."),
    a: z.number().positive().optional(),
    b: z.number().positive().optional(),
    c: z.number().positive().optional(),
    alpha: z.number().gt(0).lt(180).default(90),
    beta: z.number().gt(0).lt(180).default(90),
    gamma: z.number().gt(0).lt(180).default(90),
    spaceGroup: z.string().min(1).default("P1"),
    spaceGroupQualifier: z.string().default(""),
    coordinateType: z.enum(["fractional", "cartesian"]).default("fractional"),
    calculateBonds: z.boolean().default(false),
    useSpecialPositions: z.boolean().default(false),
    specialPositionTolerance: z.number().positive().default(0.05),
    exportFile: z.string().optional(),
    ballAndStick: z.boolean().default(true),
    forceNew: z.boolean().default(false).describe("Create a separate GUI document only when the user explicitly asks for one."),
  },
  async ({
    query,
    kind,
    formula,
    sourcePolicy,
    documentName,
    fileName,
    maxResults,
    minConfidence,
    manualMode,
    atoms,
    bonds,
    a,
    b,
    c,
    alpha,
    beta,
    gamma,
    spaceGroup,
    spaceGroupQualifier,
    coordinateType,
    calculateBonds,
    useSpecialPositions,
    specialPositionTolerance,
    exportFile,
    ballAndStick,
    forceNew,
  }) => {
    ensureGuiQueueAllowed();
    const policy = sourcePolicy || config.structureSourcePolicy || "auto";
    const finalDocumentName = defaultStructureDocumentName(query, documentName);
    const inferredManualMode = manualMode !== "none" ? manualMode : atoms.length > 0 ? (a && b && c ? "crystal" : "molecule") : "none";
    const state = readState(config);
    let search = null;
    if (shouldSearchOpenCif({ policy, kind })) {
      search = await trySearchCodOpenCif({ query, formula, maxResults });
      if (search.candidates.length === 0 && formula) {
        search = await trySearchCodOpenCif({ query, maxResults });
      }
      const [best, second] = search.candidates;
      const ambiguous = best && second && best.confidence - second.confidence < 0.05;
      if (best && best.confidence >= minConfidence && !ambiguous) {
        const { cifUrl, cifPath } = await downloadCifToProject({
          source: "cod",
          codId: best.codId,
          fileName: fileName || safeStructureStem(`${safeStructureStem(query, "structure")}_${best.codId}`, "structure"),
        });
        const importName = guiImportDocumentName(cifPath, finalDocumentName);
        const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `New structure import ${importName} from COD ${best.codId}`)}
my $doc;
${guiDocumentReuseSnippet(`"${importName.replace(/"/g, '\\"')}"`)}
$doc = ms_mcp_find_named_3d_doc($ms_mcp_requested_doc_name);
if (!$doc) {
  $doc = Documents->Import("${cifPath.replace(/\\/g, "/")}");
}
my $canonical_doc = ms_mcp_find_canonical_3d_doc($ms_mcp_requested_doc_name);
$doc = $canonical_doc if $canonical_doc;
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${ballAndStick ? ballStickSnippet() : ""}
${stateWriteRuntimeDocSnippet(config, {
  currentExport: null,
  lastJob: { type: "new_structure_current", path: "open_cif", source: "cod", query, kind, formula: formula || null, selected: best, requestedDocumentName: importName, cifPath, cifUrl },
})}
print "Created new structure ${importName} from COD ${best.codId}\\n";
`;
        const queued = queueScript(config, "gui_new_structure_current_cif", script);
        writeState(config, { currentDocument: importName, currentExport: null, lastJob: { type: "queued_new_structure", path: "open_cif", queued, source: "cod", query, kind, formula: formula || null, selected: best, cifUrl, cifPath } });
        appendHistory(config, { type: "queued_new_structure", path: "open_cif", source: "cod", query, kind, formula: formula || null, documentName: importName, selected: best, cifUrl, cifPath, queued });
        return text({ ok: true, path: "open_cif", imported: true, queued, currentDocument: importName, source: "cod", selected: best, cifUrl, cifPath, candidates: search.candidates, policy });
      }
      if (policy === "require_cif_first" || inferredManualMode === "none") {
        const reason = search.searchError ? "open_cif_search_failed" : !best ? "no_open_cif_found" : ambiguous ? "ambiguous_open_cif_candidates" : "no_reliable_open_cif";
        return text(credentialedSourceResponse({ query, formula, minConfidence, search, reason }));
      }
    }

    if (inferredManualMode === "none") {
      return text({
        ok: false,
        path: "needs_manual_model",
        policy,
        query,
        kind,
        formula: formula || null,
        search,
        error: "No reliable open CIF was imported and no manual modeling parameters were provided.",
        nextStep: "Pass manualMode='molecule' with atoms/bonds, manualMode='crystal' with cell+atoms, provide a CIF/API credential, or start a new session if this should be a separate structure.",
      });
    }

    const createGuard = createDocumentNameGuard({ state, documentName: finalDocumentName, forceNew, operation: "ms_gui_new_structure_current" });
    if (createGuard) return text({ ...createGuard, path: "manual_model", policy, search });
    const exportPath = modelingExportPath({ exportFile, state: null, documentName: finalDocumentName });

    let body = "";
    let manualMeta = {};
    const sourceDecision = search
      ? {
          sourcePolicy: policy,
          openCifSearch: {
            attempted: true,
            searchUrl: search.searchUrl || null,
            searchError: search.searchError || null,
            candidateCount: search.candidates?.length || 0,
            bestCandidate: search.candidates?.[0] || null,
            fallbackReason: search.searchError
              ? "open_cif_search_failed"
              : search.candidates?.length
                ? "no_reliable_open_cif"
                : "no_open_cif_found",
          },
        }
      : {
          sourcePolicy: policy,
          openCifSearch: {
            attempted: false,
            skippedReason: policy === "manual" ? "policy_manual" : kind === "molecule" ? "kind_molecule" : "not_required",
          },
        };
    if (inferredManualMode === "molecule") {
      if (atoms.length === 0) {
        return text({ ok: false, path: "manual_model", error: "manualMode='molecule' requires at least one atom.", policy, search });
      }
      try {
        body = moleculeAtomBuildSnippet({ atoms, bonds });
      } catch (error) {
        return text({ ok: false, path: "manual_model", error: error.message, policy, search });
      }
      manualMeta = { manualMode: "molecule", atomCount: atoms.length, bondCount: bonds.length };
    } else if (inferredManualMode === "crystal") {
      if (!a || !b || !c) {
        return text({ ok: false, path: "manual_model", error: "manualMode='crystal' requires a, b, and c lattice lengths.", policy, search });
      }
      body = `${crystalAtomBuildSnippet({
        atoms,
        coordinateType,
        cell: { a, b, c, alpha, beta, gamma },
      })}
Tools->CrystalBuilder->SetSpaceGroup(${perlLiteral(spaceGroup)}, ${perlLiteral(spaceGroupQualifier)});
Tools->CrystalBuilder->SetCellParameters(${a}, ${b}, ${c}, ${alpha}, ${beta}, ${gamma});
Tools->CrystalBuilder->ChangeSettings(${perlSettings({
        UseSpecialPositions: useSpecialPositions ? "Yes" : "No",
        SpecialPositionTolerance: specialPositionTolerance,
        CalculateBonding: calculateBonds ? "Yes" : "No",
      })});
Tools->CrystalBuilder->Build($doc);
`;
      manualMeta = { manualMode: "crystal", atomCount: atoms.length, cell: { a, b, c, alpha, beta, gamma }, spaceGroup };
    } else {
      return text({ ok: false, path: "manual_model", error: `Unsupported manualMode: ${inferredManualMode}`, policy, search });
    }

    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `New structure manual ${inferredManualMode} ${finalDocumentName}`)}
${guiDocumentReuseSnippet(`"${finalDocumentName.replace(/"/g, '\\"')}"`)}
my $doc;
if (${forceNew ? "1" : "0"}) {
  $doc = Documents->New($ms_mcp_requested_doc_name);
} else {
  $doc = ms_mcp_find_named_3d_doc($ms_mcp_requested_doc_name);
  if ($doc) {
    ms_mcp_clear_3d_doc($doc);
  } else {
    ${state.currentDocument ? `die "Expected existing current GUI document ${String(state.currentDocument).replace(/"/g, '\\"')} but could not resolve it. Start a new project session or set forceNew=true only for a separate document.";` : ""}
    $doc = Documents->New($ms_mcp_requested_doc_name);
  }
}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${body}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "new_structure_current", path: "manual_model", query, kind, formula: formula || null, requestedDocumentName: finalDocumentName, exportPath, ...manualMeta, sourceDecision },
})}
print "Created new structure ${finalDocumentName} by manual ${inferredManualMode} modeling\\n";
`;
    const queued = queueScript(config, `gui_new_structure_current_${inferredManualMode}`, script);
    writeState(config, { currentDocument: finalDocumentName, currentExport: exportPath, lastJob: { type: "queued_new_structure", path: "manual_model", queued, query, kind, formula: formula || null, ...manualMeta, sourceDecision } });
    appendHistory(config, { type: "queued_new_structure", path: "manual_model", query, kind, formula: formula || null, documentName: finalDocumentName, exportPath, queued, ...manualMeta, sourceDecision });
    return text({ ok: true, path: "manual_model", queued, currentDocument: finalDocumentName, exportPath, policy, sourceDecision, search, ...manualMeta });
  },
);

server.tool(
  "ms_gui_create_current",
  "Create or replace the current GUI document from a MaterialsScript body. Before using this for a new structure, first try ms_gui_find_cif_import_current against open CIF sources; use manual construction only when no reliable open CIF is found or the user provides credentials/API access for a restricted source. By default it reuses the existing current/same-name document and rebuilds it in place to avoid duplicate .xsd files.",
  {
    documentName: z.string().regex(/^[^\\/:*?"<>|]+\.xsd$/),
    body: z.string().min(1).describe("MaterialsScript body. A variable named $doc is already created."),
    exportFile: z.string().optional(),
    ballAndStick: z.boolean().default(true),
    forceNew: z.boolean().default(false).describe("Create a new GUI document even if a current or same-name document exists. Use only when the user explicitly asks for a separate new document."),
  },
  async ({ documentName, body, exportFile, ballAndStick, forceNew }) => {
    ensureGuiQueueAllowed();
    ensureRawScriptAllowed();
    try {
      assertGuiBodyIsInPlace(body, "ms_gui_create_current");
    } catch (error) {
      return text({ ok: false, error: error.message });
    }
    const state = readState(config);
    const finalDocumentName = stripModelingWorkSuffix(documentName);
    const createGuard = createDocumentNameGuard({ state, documentName: finalDocumentName, forceNew, operation: "ms_gui_create_current" });
    if (createGuard) return text(createGuard);
    const exportPath = modelingExportPath({ exportFile, state: null, documentName: finalDocumentName });
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Create current ${finalDocumentName}`)}
${guiDocumentReuseSnippet(`"${finalDocumentName.replace(/"/g, '\\"')}"`)}
my $doc;
if (${forceNew ? "1" : "0"}) {
  $doc = Documents->New($ms_mcp_requested_doc_name);
} else {
  $doc = ms_mcp_find_named_3d_doc($ms_mcp_requested_doc_name);
  if ($doc) {
    ms_mcp_clear_3d_doc($doc);
  } else {
    ${state.currentDocument ? `die "Expected existing current GUI document ${String(state.currentDocument).replace(/"/g, '\\"')} but could not resolve it. Start a new project session or set forceNew=true only for a separate document.";` : ""}
    $doc = Documents->New($ms_mcp_requested_doc_name);
  }
}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${body}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath })}
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "create_current", requestedDocumentName: finalDocumentName, exportPath },
})}
print "Created current document ${finalDocumentName}\\n";
`;
    const queued = queueScript(config, "gui_create_current", script);
    writeState(config, { currentDocument: finalDocumentName, currentExport: exportPath, lastJob: { type: "queued_create", queued } });
    appendHistory(config, { type: "queued_create", documentName: finalDocumentName, exportPath, queued });
    return text({ ok: true, queued, currentDocument: finalDocumentName, exportPath });
  },
);

server.tool(
  "ms_gui_create_crystal_current",
  "Create or replace the current GUI document as a periodic crystal/unit cell from lattice parameters and atom coordinates. Before using this for a new crystal, first try ms_gui_find_cif_import_current against open CIF sources; use manual construction only when no reliable open CIF is found or the user provides credentials/API access for a restricted source. Do not add vacuum here unless the user explicitly requested vacuum in the initial cell parameters.",
  {
    documentName: z.string().regex(/^[^\\/:*?"<>|]+\.xsd$/),
    a: z.number().positive().describe("Lattice length a in Angstrom."),
    b: z.number().positive().describe("Lattice length b in Angstrom."),
    c: z.number().positive().describe("Lattice length c in Angstrom."),
    alpha: z.number().gt(0).lt(180).default(90),
    beta: z.number().gt(0).lt(180).default(90),
    gamma: z.number().gt(0).lt(180).default(90),
    spaceGroup: z.string().min(1).default("P1"),
    spaceGroupQualifier: z.string().default(""),
    coordinateType: z.enum(["fractional", "cartesian"]).default("fractional"),
    atoms: z
      .array(
        z.object({
          element: z.string().regex(/^[A-Z][a-z]?$/),
          label: z.string().optional(),
          x: z.number(),
          y: z.number(),
          z: z.number(),
        }),
      )
      .min(0)
      .describe("Atoms in fractional or Cartesian coordinates depending on coordinateType."),
    calculateBonds: z.boolean().default(false).describe("For periodic crystals this defaults to false to avoid incorrect cross-boundary bonding; use explicit bonding or a later targeted bond calculation when needed."),
    useSpecialPositions: z.boolean().default(false),
    specialPositionTolerance: z.number().positive().default(0.05),
    exportFile: z.string().optional(),
    ballAndStick: z.boolean().default(true),
    forceNew: z.boolean().default(false),
  },
  async ({
    documentName,
    a,
    b,
    c,
    alpha,
    beta,
    gamma,
    spaceGroup,
    spaceGroupQualifier,
    coordinateType,
    atoms,
    calculateBonds,
    useSpecialPositions,
    specialPositionTolerance,
    exportFile,
    ballAndStick,
    forceNew,
  }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const finalDocumentName = stripModelingWorkSuffix(documentName);
    const createGuard = createDocumentNameGuard({ state, documentName: finalDocumentName, forceNew, operation: "ms_gui_create_crystal_current" });
    if (createGuard) return text(createGuard);
    const exportPath = modelingExportPath({ exportFile, state: null, documentName: finalDocumentName });
    const buildAtoms = crystalAtomBuildSnippet({
      atoms,
      coordinateType,
      cell: { a, b, c, alpha, beta, gamma },
    });
    const settings = perlSettings({
      UseSpecialPositions: useSpecialPositions ? "Yes" : "No",
      SpecialPositionTolerance: specialPositionTolerance,
      CalculateBonding: calculateBonds ? "Yes" : "No",
    });
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Create crystal current ${finalDocumentName}`)}
${guiDocumentReuseSnippet(`"${finalDocumentName.replace(/"/g, '\\"')}"`)}
my $doc;
if (${forceNew ? "1" : "0"}) {
  $doc = Documents->New($ms_mcp_requested_doc_name);
} else {
  $doc = ms_mcp_find_named_3d_doc($ms_mcp_requested_doc_name);
  if ($doc) {
    ms_mcp_clear_3d_doc($doc);
  } else {
    ${state.currentDocument ? `die "Expected existing current GUI document ${String(state.currentDocument).replace(/"/g, '\\"')} but could not resolve it. Start a new project session or set forceNew=true only for a separate document.";` : ""}
    $doc = Documents->New($ms_mcp_requested_doc_name);
  }
}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${buildAtoms}
Tools->CrystalBuilder->SetSpaceGroup(${perlLiteral(spaceGroup)}, ${perlLiteral(spaceGroupQualifier)});
Tools->CrystalBuilder->SetCellParameters(${a}, ${b}, ${c}, ${alpha}, ${beta}, ${gamma});
Tools->CrystalBuilder->ChangeSettings(${settings});
Tools->CrystalBuilder->Build($doc);
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: {
    type: "create_crystal_current",
    requestedDocumentName: finalDocumentName,
    exportPath,
    cell: { a, b, c, alpha, beta, gamma },
    spaceGroup,
    atomCount: atoms.length,
  },
})}
print "Created periodic crystal ${finalDocumentName}\\n";
`;
    const queued = queueScript(config, "gui_create_crystal_current", script);
    writeState(config, { currentDocument: finalDocumentName, currentExport: exportPath, lastJob: { type: "queued_create_crystal", queued } });
    appendHistory(config, { type: "queued_create_crystal", documentName: finalDocumentName, exportPath, queued, cell: { a, b, c, alpha, beta, gamma }, spaceGroup, atomCount: atoms.length });
    return text({ ok: true, queued, currentDocument: finalDocumentName, exportPath, cell: { a, b, c, alpha, beta, gamma }, spaceGroup, atomCount: atoms.length });
  },
);

server.tool(
  "ms_gui_set_lattice_current",
  "Set lattice parameters on the current GUI crystal document in place.",
  {
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    a: z.number().positive().optional(),
    b: z.number().positive().optional(),
    c: z.number().positive().optional(),
    alpha: z.number().gt(0).lt(180).optional(),
    beta: z.number().gt(0).lt(180).optional(),
    gamma: z.number().gt(0).lt(180).optional(),
    ballAndStick: z.boolean().default(true),
  },
  async ({ documentName, exportFile, a, b, c, alpha, beta, gamma, ballAndStick }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for lattice operation." });
    }
    const nameGuard = inPlaceDocumentNameGuard({ state, documentName, exportFile, operation: "ms_gui_set_lattice_current" });
    if (nameGuard) return text(nameGuard);
    const exportPath = modelingExportPath({ exportFile, state, documentName: targetDocument });
    const updates = [
      a !== undefined ? `$doc->Lattice3D->LengthA = ${a};` : "",
      b !== undefined ? `$doc->Lattice3D->LengthB = ${b};` : "",
      c !== undefined ? `$doc->Lattice3D->LengthC = ${c};` : "",
      alpha !== undefined ? `$doc->Lattice3D->AngleAlpha = ${alpha};` : "",
      beta !== undefined ? `$doc->Lattice3D->AngleBeta = ${beta};` : "",
      gamma !== undefined ? `$doc->Lattice3D->AngleGamma = ${gamma};` : "",
    ].join("\n");
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Set lattice on ${targetDocument}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
die "Current document has no 3D lattice." unless $doc->Lattice3D;
${updates}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save: true })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "set_lattice_current", requestedDocumentName: targetDocument, exportPath, a, b, c, alpha, beta, gamma },
})}
print "Updated lattice on current document ${targetDocument}\\n";
`;
    const queued = queueScript(config, "gui_set_lattice_current", script);
    const normalizedTarget = normalizeVisibleDocumentName(targetDocument);
    writeState(config, { currentDocument: normalizedTarget, currentExport: exportPath, lastJob: { type: "queued_set_lattice", queued } });
    appendHistory(config, { type: "queued_set_lattice", documentName: normalizedTarget, exportPath, queued, a, b, c, alpha, beta, gamma });
    return text({ ok: true, queued, currentDocument: normalizedTarget, exportPath, a, b, c, alpha, beta, gamma });
  },
);

server.tool(
  "ms_gui_make_supercell_current",
  "Build a supercell from the current GUI periodic document in place, using Materials Studio BuildSuperCell.",
  {
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    a: z.number().int().positive().default(1).describe("Multiplier along lattice A."),
    b: z.number().int().positive().default(1).describe("Multiplier along lattice B."),
    c: z.number().int().positive().default(1).describe("Multiplier along lattice C. Use 1 for 2D slabs/surfaces."),
    surface2D: z.boolean().default(false).describe("Use the two-parameter surface form BuildSuperCell(a,b)."),
    calculateBonds: z.boolean().default(false).describe("For periodic supercells this defaults to false to avoid incorrect cross-boundary bonding; use explicit bonding or a later targeted bond calculation when needed."),
    ballAndStick: z.boolean().default(true),
  },
  async ({ documentName, exportFile, a, b, c, surface2D, calculateBonds, ballAndStick }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for supercell operation." });
    }
    const nameGuard = inPlaceDocumentNameGuard({ state, documentName, exportFile, operation: "ms_gui_make_supercell_current" });
    if (nameGuard) return text(nameGuard);
    const exportPath = modelingExportPath({ exportFile, state, documentName: targetDocument });
    const buildLine = surface2D ? `$doc->BuildSuperCell(${a}, ${b});` : `$doc->BuildSuperCell(${a}, ${b}, ${c});`;
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Build supercell on ${targetDocument}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${buildLine}
${calculateBonds ? "eval { $doc->CalculateBonds; };\n" : ""}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save: true })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "make_supercell_current", requestedDocumentName: targetDocument, exportPath, a, b, c, surface2D },
})}
print "Built supercell on current document ${targetDocument}\\n";
`;
    const queued = queueScript(config, "gui_make_supercell_current", script);
    const normalizedTarget = normalizeVisibleDocumentName(targetDocument);
    writeState(config, { currentDocument: normalizedTarget, currentExport: exportPath, lastJob: { type: "queued_make_supercell", queued } });
    appendHistory(config, { type: "queued_make_supercell", documentName: normalizedTarget, exportPath, queued, a, b, c, surface2D });
    return text({ ok: true, queued, currentDocument: normalizedTarget, exportPath, a, b, c, surface2D });
  },
);

server.tool(
  "ms_gui_add_vacuum_current",
  "Add vacuum to the current GUI periodic document in place only when the user explicitly asks for vacuum. For an already-built 3D cell, extend_lattice increases the chosen lattice length while preserving Cartesian atom positions; for 2D surfaces, vacuum_slab uses CrystalBuilder VacuumSlab.",
  {
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    thickness: z.number().positive().describe("Vacuum thickness to add in Angstrom."),
    axis: z.enum(["A", "B", "C"]).default("C"),
    mode: z.enum(["extend_lattice", "vacuum_slab"]).default("extend_lattice"),
    slabPosition: z.number().optional(),
    transferSymmetry: z.boolean().default(true),
    reorientAfterVacuumSlab: z.boolean().default(false),
    ballAndStick: z.boolean().default(true),
  },
  async ({ documentName, exportFile, thickness, axis, mode, slabPosition, transferSymmetry, reorientAfterVacuumSlab, ballAndStick }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for vacuum operation." });
    }
    const nameGuard = inPlaceDocumentNameGuard({ state, documentName, exportFile, operation: "ms_gui_add_vacuum_current" });
    if (nameGuard) return text(nameGuard);
    const exportPath = modelingExportPath({ exportFile, state, documentName: targetDocument });
    const lengthProperty = axis === "A" ? "LengthA" : axis === "B" ? "LengthB" : "LengthC";
    const settings = perlSettings({
      VacuumOrientation: axis,
      VacuumThickness: thickness,
      SlabPosition: slabPosition,
      TransferSymmetry: transferSymmetry ? "Yes" : "No",
      ReorientAfterVacuumSlab: reorientAfterVacuumSlab ? "Yes" : "No",
    });
    const action =
      mode === "vacuum_slab"
        ? `Tools->CrystalBuilder->ChangeSettings(${settings});
Tools->CrystalBuilder->VacuumSlab->Build($doc);
`
        : `die "Current document has no 3D lattice." unless $doc->Lattice3D;
my @ms_mcp_xyz;
foreach my $atom (@{$doc->AsymmetricUnit->Atoms}) {
    my $p = $atom->XYZ;
    push @ms_mcp_xyz, [$atom, $p->X, $p->Y, $p->Z];
}
my $old_length = $doc->Lattice3D->${lengthProperty};
$doc->Lattice3D->${lengthProperty} = $old_length + ${thickness};
foreach my $entry (@ms_mcp_xyz) {
    my ($atom, $x, $y, $z) = @$entry;
    $atom->XYZ = Point(X => $x, Y => $y, Z => $z);
}
`;
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Add vacuum on ${targetDocument}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${action}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save: true })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "add_vacuum_current", requestedDocumentName: targetDocument, exportPath, thickness, axis, mode },
})}
print "Added vacuum to current document ${targetDocument}\\n";
`;
    const queued = queueScript(config, "gui_add_vacuum_current", script);
    writeState(config, { currentDocument: targetDocument, currentExport: exportPath, lastJob: { type: "queued_add_vacuum", queued } });
    appendHistory(config, { type: "queued_add_vacuum", documentName: targetDocument, exportPath, queued, thickness, axis, mode });
    return text({ ok: true, queued, currentDocument: targetDocument, exportPath, thickness, axis, mode });
  },
);

server.tool(
  "ms_gui_cleave_surface_vacuum_current",
  "Cleave a surface from the current GUI crystal and build a vacuum slab through Materials Studio SurfaceBuilder + CrystalBuilder. Use only when the user explicitly asks to cleave/build a surface or create a vacuum slab by the manual surface workflow.",
  {
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    h: z.number().int().default(0),
    k: z.number().int().default(0),
    l: z.number().int().default(1),
    slabThickness: z.number().positive().describe("Thickness of the cleaved slab in Angstrom."),
    vacuumThickness: z.number().positive().describe("Vacuum thickness in Angstrom."),
    vacuumAxis: z.enum(["A", "B", "C"]).default("C"),
    cleaveRule: z.string().optional(),
    capBonds: z.boolean().default(false),
    capType: z.string().default("Hydrogen"),
    transferSymmetry: z.boolean().default(true),
    reorientAfterVacuumSlab: z.boolean().default(false),
    ballAndStick: z.boolean().default(true),
  },
  async ({
    documentName,
    exportFile,
    h,
    k,
    l,
    slabThickness,
    vacuumThickness,
    vacuumAxis,
    cleaveRule,
    capBonds,
    capType,
    transferSymmetry,
    reorientAfterVacuumSlab,
    ballAndStick,
  }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for cleave/vacuum slab operation." });
    }
    const nameGuard = inPlaceDocumentNameGuard({ state, documentName, exportFile, operation: "ms_gui_cleave_surface_vacuum_current" });
    if (nameGuard) return text(nameGuard);
    if (h === 0 && k === 0 && l === 0) {
      return text({ ok: false, error: "Miller index cannot be (0,0,0)." });
    }
    const exportPath = modelingExportPath({ exportFile, state, documentName: targetDocument });
    const cleaveSettings = perlSettings({
      CapBonds: capBonds ? "Both" : "Neither",
      CapType: capType,
      CleaveRule: cleaveRule,
    });
    const vacuumSettings = perlSettings({
      VacuumOrientation: vacuumAxis,
      VacuumThickness: vacuumThickness,
      TransferSymmetry: transferSymmetry ? "Yes" : "No",
      ReorientAfterVacuumSlab: reorientAfterVacuumSlab ? "Yes" : "No",
    });
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Cleave surface and build vacuum slab on ${targetDocument}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
my $cleaver = Tools->SurfaceBuilder->CleaveSurface;
Tools->SurfaceBuilder->ChangeSettings(${cleaveSettings});
$cleaver->DefineCleave($doc, MillerIndex(H => ${h}, K => ${k}, L => ${l}));
$cleaver->SetThickness(${slabThickness}, "Angstrom");
my $surface_doc = $cleaver->Cleave;
$doc = $surface_doc if $surface_doc;
Tools->CrystalBuilder->ChangeSettings(${vacuumSettings});
Tools->CrystalBuilder->VacuumSlab->Build($doc);
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save: true })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: {
    type: "cleave_surface_vacuum_current",
    requestedDocumentName: targetDocument,
    exportPath,
    miller: { h, k, l },
    slabThickness,
    vacuumThickness,
    vacuumAxis,
  },
})}
print "Cleaved surface and built vacuum slab for current document ${targetDocument}\\n";
`;
    const queued = queueScript(config, "gui_cleave_surface_vacuum_current", script);
    writeState(config, { currentDocument: targetDocument, currentExport: exportPath, lastJob: { type: "queued_cleave_surface_vacuum", queued } });
    appendHistory(config, { type: "queued_cleave_surface_vacuum", documentName: targetDocument, exportPath, queued, miller: { h, k, l }, slabThickness, vacuumThickness, vacuumAxis });
    return text({ ok: true, queued, currentDocument: targetDocument, exportPath, miller: { h, k, l }, slabThickness, vacuumThickness, vacuumAxis });
  },
);

server.tool(
  "ms_gui_apply_current",
  "Queue a MaterialsScript body that modifies the current GUI document in place. Use this for 'on this molecule...' edits.",
  {
    body: z.string().min(1).describe("MaterialsScript body. A variable named $doc is bound to the current target document."),
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    save: z.boolean().default(true),
    ballAndStick: z.boolean().default(true),
    label: z.string().default("apply_current"),
  },
  async ({ body, documentName, exportFile, save, ballAndStick, label }) => {
    ensureGuiQueueAllowed();
    ensureRawScriptAllowed();
    try {
      assertGuiBodyIsInPlace(body, "ms_gui_apply_current");
    } catch (error) {
      return text({ ok: false, error: error.message });
    }
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set. Use ms_gui_set_current_document, ms_gui_import_current, or ms_gui_create_current first." });
    }
    const nameGuard = inPlaceDocumentNameGuard({ state, documentName, exportFile, operation: "ms_gui_apply_current" });
    if (nameGuard) return text(nameGuard);
    const exportPath = modelingExportPath({ exportFile, state, documentName: targetDocument });
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Apply ${label} to ${targetDocument}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${body}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "apply_current", label, requestedDocumentName: targetDocument, exportPath },
})}
print "Applied ${label} to current document ${targetDocument}\\n";
`;
    const queued = queueScript(config, label, script);
    writeState(config, { currentDocument: targetDocument, currentExport: exportPath, lastJob: { type: "queued_apply", label, queued } });
    appendHistory(config, { type: "queued_apply", label, documentName: targetDocument, exportPath, queued });
    return text({ ok: true, queued, currentDocument: targetDocument, exportPath });
  },
);

server.tool(
  "ms_gui_dmol3_optimize_current",
  "Queue a DMol3 GeometryOptimization on the current GUI document and organize calculation outputs under a dedicated calculation name/folder.",
  {
    documentName: z.string().optional(),
    calculationName: z.string().default("DMol3_GeometryOptimization"),
    resultDocument: z.string().default("dmol3_optimized.xsd"),
    exportFile: z.string().optional(),
    quality: z.enum(["Coarse", "Medium", "Fine"]).default("Medium"),
    theoryLevel: z.string().default("GGA"),
    charge: z.number().int().default(0),
    cores: z.number().int().positive().max(256).optional(),
    extraSettings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  },
  async ({ documentName, calculationName, resultDocument, exportFile, quality, theoryLevel, charge, cores, extraSettings }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for DMol3 optimization." });
    }
    const calcName = compactCalculationName(calculationName, { moduleName: "DMol3", taskName: "geomopt", fallback: "calculation" });
    const calcDir = assertInside(config.workRoot, path.join(config.projectRoot, calcName));
    fs.mkdirSync(calcDir, { recursive: true });
    const workingDocument = resultDocument === "dmol3_optimized.xsd" ? "DMol3.xsd" : calculationDocumentName(resultDocument, "DMol3.xsd");
    const calculationSettingsDocument = "DMol3 - Calculation";
    const outputDocument = workingDocument;
    const exportPath = exportFile ? projectOutputPath(exportFile) : assertInside(config.workRoot, path.join(calcDir, outputDocument));
    const settingsJsonPath = assertInside(config.workRoot, path.join(calcDir, "DMol3_settings.json"));
    const settingsTextPath = assertInside(config.workRoot, path.join(calcDir, "DMol3_settings.txt"));
    const summaryPath = assertInside(config.workRoot, path.join(calcDir, "DMol3_summary.txt"));
    const outmolPath = assertInside(config.workRoot, path.join(calcDir, "DMol3.outmol"));
    const settings = {
      Quality: quality,
      TheoryLevel: theoryLevel,
      GeometryOptimizationQuality: quality,
      Charge: charge,
      UseSymmetry: "No",
      CreateEnergyEvolutionChart: "Yes",
      ...extraSettings,
    };
    fs.writeFileSync(
      settingsJsonPath,
      JSON.stringify({ module: "DMol3", task: "GeometryOptimization", calculationName: calcName, sourceDocument: targetDocument, workingDocument, outputDocument, calculationSettingsDocument, cores: cores || null, settings }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      settingsTextPath,
      [
        `Module: DMol3`,
        `Task: GeometryOptimization`,
        `CalculationName: ${calcName}`,
        `SourceDocument: ${targetDocument}`,
        `WorkingDocument: ${workingDocument}`,
        `CalculationSettingsDocument: ${calculationSettingsDocument}`,
        `OutputDocument: ${outputDocument}`,
        cores ? `RequestedCores: ${cores}` : `RequestedCores: default`,
        ``,
        ...Object.entries(settings).map(([key, value]) => `${key} = ${value}`),
        ``,
      ].join("\n"),
      "utf8",
    );
    const settingsText = Object.entries(settings)
      .map(([key, value]) => `${key} => ${JSON.stringify(value)}`)
      .join(",\n        ");
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${cores ? `$ENV{DSD_NumProc} = ${cores};` : ""}
${traceSnippet(config, `DMol3 optimize ${targetDocument} as ${calcName}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${guiCalculationCleanupSnippet({
  calcNameExpression: `"${calcName.replace(/"/g, '\\"')}"`,
  sourceNameExpression: `"${String(targetDocument).replace(/"/g, '\\"')}"`,
})}
ms_mcp_cleanup_root_calculation_artifacts($ms_mcp_calc_source_name);
eval { Modules->DMol3->ChangeSettings(Settings(
        ${settingsText}
    )); };
my $calc_doc = $doc;
my $ms_mcp_error = "";
eval {
    my $copy = $doc->SaveAs("/${calcName}/${workingDocument}");
    $calc_doc = $copy if $copy;
    eval { Modules->DMol3->SaveSettings("/${calcName}/DMol3"); };
    if ($@) {
        print "Warning: could not save DMol3 calculation settings document /${calcName}/${calculationSettingsDocument}. $@\\n";
    }
    my $results = Modules->DMol3->GeometryOptimization->Run($calc_doc,
        Settings(
        ${settingsText}
        )
    );
    my $opt = $results->Structure;
    $doc = $opt;
    ${ballStickSnippet()}
    $doc->Export(${perlPathLiteral(exportPath)});
    eval {
        my $report = $results->Report;
        $report->Export(${perlPathLiteral(outmolPath)});
    };
    open(my $summary_fh, ">>", ${perlPathLiteral(summaryPath)}) or die "Cannot write DMol3 summary: $!";
    print $summary_fh "DMol3 optimization finished for ${targetDocument} as ${calcName} at " . scalar(localtime()) . "\\n";
    ${cores ? `print $summary_fh "RequestedCores: ${cores}\\n";` : ""}
    eval { print $summary_fh "Converged: " . $results->Converged . "\\n"; };
    eval { print $summary_fh "TotalEnergy: " . $results->TotalEnergy . "\\n"; };
    close($summary_fh);
};
if ($@) {
    $ms_mcp_error = $@;
    ms_mcp_cleanup_failed_calculation_folder($ms_mcp_calc_folder_name);
    ms_mcp_cleanup_root_calculation_artifacts($ms_mcp_calc_source_name);
    die "DMol3 GeometryOptimization failed and MS-MCP cleaned the failed calculation artifacts: $ms_mcp_error";
}
${stateWriteSnippet(config, {
  currentDocument: workingDocument,
  currentExport: exportPath,
  lastJob: { type: "dmol3_geometry_optimization", calculationName: calcName, sourceDocument: targetDocument, workingDocument, resultDocument: outputDocument, calculationSettingsDocument, exportPath, calcDir, cores: cores || null, settings },
})}
print "Queued DMol3 optimization completed for ${targetDocument}\\n";
`;
    const queued = queueScript(config, "gui_dmol3_optimize_current", script);
    writeState(config, { lastJob: { type: "queued_dmol3", queued, calculationName: calcName, sourceDocument: targetDocument, workingDocument, resultDocument: outputDocument, calculationSettingsDocument, calcDir, cores: cores || null } });
    appendHistory(config, { type: "queued_dmol3", queued, calculationName: calcName, sourceDocument: targetDocument, workingDocument, resultDocument: outputDocument, calculationSettingsDocument, exportPath, calcDir, cores: cores || null, settings });
    return text({ ok: true, queued, calculationName: calcName, sourceDocument: targetDocument, workingDocument, resultDocument: outputDocument, calculationSettingsDocument, calcDir, exportPath, cores: cores || null, settings, settingsJsonPath, settingsTextPath });
  },
);

server.tool(
  "ms_gui_forcite_optimize_current",
  "Queue a Forcite GeometryOptimization on the current GUI document using a manual-like calculation folder layout.",
  {
    documentName: z.string().optional(),
    calculationName: z.string().default("Forcite_GeometryOptimization"),
    resultDocument: z.string().default("Forcite.xsd"),
    exportFile: z.string().optional(),
    quality: z.enum(["Coarse", "Medium", "Fine"]).default("Medium"),
    forcefield: z.string().default("Universal"),
    chargeAssignment: z.string().default("Use current"),
    maxIterations: z.number().int().positive().max(100000).default(500),
    optimizeCell: z.boolean().default(false),
    cores: z.number().int().positive().max(256).optional(),
    extraSettings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  },
  async ({
    documentName,
    calculationName,
    resultDocument,
    exportFile,
    quality,
    forcefield,
    chargeAssignment,
    maxIterations,
    optimizeCell,
    cores,
    extraSettings,
  }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for Forcite optimization." });
    }
    const calcName = compactCalculationName(calculationName, { moduleName: "Forcite", taskName: "geomopt", fallback: "calculation" });
    const calcDir = assertInside(config.workRoot, path.join(config.projectRoot, calcName));
    fs.mkdirSync(calcDir, { recursive: true });
    const workingDocument = calculationDocumentName(resultDocument, "Forcite.xsd");
    const calculationSettingsDocument = "Forcite - Calculation";
    const exportPath = exportFile ? projectOutputPath(exportFile) : assertInside(config.workRoot, path.join(calcDir, workingDocument));
    const settingsTextPath = assertInside(config.workRoot, path.join(calcDir, "Forcite_settings.txt"));
    const settingsJsonPath = assertInside(config.workRoot, path.join(calcDir, "Forcite_settings.json"));
    const summaryPath = assertInside(config.workRoot, path.join(calcDir, "Forcite_summary.txt"));
    const reportPath = assertInside(config.workRoot, path.join(calcDir, "Forcite.txt"));
    const settings = {
      Quality: quality,
      CurrentForcefield: forcefield,
      ChargeAssignment: chargeAssignment,
      MaxIterations: maxIterations,
      OptimizeCell: optimizeCell ? "Yes" : "No",
      ...extraSettings,
    };
    fs.writeFileSync(
      settingsJsonPath,
      JSON.stringify({ module: "Forcite", task: "GeometryOptimization", calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, cores: cores || null, settings }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      settingsTextPath,
      [
        "Module: Forcite",
        "Task: GeometryOptimization",
        `CalculationName: ${calcName}`,
        `SourceDocument: ${targetDocument}`,
        `WorkingDocument: ${workingDocument}`,
        `CalculationSettingsDocument: ${calculationSettingsDocument}`,
        cores ? `RequestedCores: ${cores}` : `RequestedCores: default`,
        "",
        ...Object.entries(settings).map(([key, value]) => `${key} = ${value}`),
        "",
      ].join("\n"),
      "utf8",
    );
    const settingsText = Object.entries(settings)
      .map(([key, value]) => `${key} => ${JSON.stringify(value)}`)
      .join(",\n        ");
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${cores ? `$ENV{DSD_NumProc} = ${cores};` : ""}
${traceSnippet(config, `Forcite optimize ${targetDocument} as ${calcName}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${guiCalculationCleanupSnippet({
  calcNameExpression: `"${calcName.replace(/"/g, '\\"')}"`,
  sourceNameExpression: `"${String(targetDocument).replace(/"/g, '\\"')}"`,
})}
ms_mcp_cleanup_root_calculation_artifacts($ms_mcp_calc_source_name);
my $settings = Settings(
        ${settingsText}
    );
my $calc_doc = $doc;
my $ms_mcp_error = "";
eval {
    my $copy = $doc->SaveAs("/${calcName}/${workingDocument}");
    $calc_doc = $copy if $copy;
    Modules->Forcite->ChangeSettings($settings);
    eval { Modules->Forcite->SaveSettings("/${calcName}/Forcite"); };
    if ($@) {
        print "Warning: could not save Forcite calculation settings document /${calcName}/${calculationSettingsDocument}. $@\\n";
    }
    my $results = Modules->Forcite->GeometryOptimization->Run($calc_doc, $settings);
    my $opt = $results->Structure;
    $doc = $opt;
    ${ballStickSnippet()}
    $doc->Export(${perlPathLiteral(exportPath)});
    eval {
        my $report = $results->Report;
        $report->Export(${perlPathLiteral(reportPath)});
    };
    open(my $summary_fh, ">>", ${perlPathLiteral(summaryPath)}) or die "Cannot write Forcite summary: $!";
    print $summary_fh "Forcite optimization finished for ${targetDocument} as ${calcName} at " . scalar(localtime()) . "\\n";
    eval { print $summary_fh "Converged: " . $results->Converged . "\\n"; };
    eval { print $summary_fh "TotalEnergy: " . $results->TotalEnergy . "\\n"; };
    close($summary_fh);
};
if ($@) {
    $ms_mcp_error = $@;
    ms_mcp_cleanup_failed_calculation_folder($ms_mcp_calc_folder_name);
    ms_mcp_cleanup_root_calculation_artifacts($ms_mcp_calc_source_name);
    die "Forcite GeometryOptimization failed and MS-MCP cleaned the failed calculation artifacts: $ms_mcp_error";
}
${stateWriteSnippet(config, {
  currentDocument: workingDocument,
  currentExport: exportPath,
  lastJob: { type: "forcite_geometry_optimization", calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, exportPath, calcDir, cores: cores || null, settings },
})}
print "Queued Forcite optimization completed for ${targetDocument}\\n";
`;
    const queued = queueScript(config, "gui_forcite_optimize_current", script);
    writeState(config, { lastJob: { type: "queued_forcite", queued, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, calcDir, cores: cores || null } });
    appendHistory(config, { type: "queued_forcite", queued, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, exportPath, calcDir, cores: cores || null, settings });
    return text({ ok: true, queued, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, calcDir, exportPath, cores: cores || null, settings, settingsJsonPath, settingsTextPath });
  },
);

server.tool(
  "ms_gui_prepare_remote_castep_batch",
  "Prepare independent native CASTEP geometry-optimization jobs or compatibility Script Job drivers. The default native_castep mode stages one XSD plus one CASTEP settings document per structure/spin task for separate submission from the CASTEP Calculation dialog, giving each calculation its own CASTEP Job Control entry and native convergence graphs.",
  {
    batchName: z.string().regex(/^[A-Za-z0-9._-]+$/).default("remote_castep_batch"),
    tasks: z.array(z.object({
      documentName: z.string().min(1),
      calculationName: z.string().optional(),
      metal: z.string().regex(/^[A-Z][a-z]?$/).optional(),
      initialSpin: z.number().nullable().optional(),
      settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    })).min(1).max(100),
    commonSettings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    submissionMode: z.enum(["native_castep", "individual_script", "combined_batch"]).default("native_castep"),
    stopGuiLoopAfterPrepare: z.boolean().default(true),
  },
  async ({ batchName, tasks, commonSettings, submissionMode, stopGuiLoopAfterPrepare }) => {
    ensureGuiQueueAllowed();
    refreshProjectSession(config);
    let normalizedTasks;
    try {
      normalizedTasks = normalizeRemoteCastepTasks(tasks);
    } catch (error) {
      return text({ ok: false, error: error.message });
    }

    const stagedNames = new Map();
    for (const task of normalizedTasks) {
      const stagedName = path.basename(task.documentName).replace(/\s+\(\d+\)(?=\.xsd$|$)/i, "");
      const key = stagedName.toLowerCase();
      const prior = stagedNames.get(key);
      if (prior && prior !== task.documentName) {
        return text({
          ok: false,
          error: `Remote batch input basename collision: ${prior} and ${task.documentName} both stage as ${stagedName}.`,
        });
      }
      stagedNames.set(key, task.documentName);
    }
    const stagedTasks = normalizedTasks.map((task) => ({
      ...task,
      sourceDocumentName: task.documentName,
      documentName: path.basename(task.documentName).replace(/\s+\(\d+\)(?=\.xsd$|$)/i, ""),
    }));

    const batchDir = assertInside(config.workRoot, path.join(config.projectRoot, "remote-castep", batchName));
    fs.mkdirSync(batchDir, { recursive: true });
    const manifestPath = assertInside(config.workRoot, path.join(batchDir, `${batchName}_manifest.json`));
    const readyPath = assertInside(config.workRoot, path.join(batchDir, `${batchName}_ready.json`));
    const requestedCores = 48;

    const nativeEntries = submissionMode === "native_castep"
      ? stagedTasks.map((task) => ({
          jobName: task.calculationName,
          calculationName: task.calculationName,
          sourceDocumentName: task.sourceDocumentName,
          stagedName: task.documentName,
          projectFolder: `${batchName}/${task.calculationName}`,
          structureDocument: `/${batchName}/${task.calculationName}/${task.calculationName}.xsd`,
          settingsDocument: `/${batchName}/${task.calculationName}/CASTEP - Calculation`,
          task,
        }))
      : [];

    const driverEntries = submissionMode === "individual_script"
      ? stagedTasks.map((task) => {
          const jobName = task.calculationName;
          const jobDir = assertInside(config.workRoot, path.join(batchDir, "jobs", jobName));
          fs.mkdirSync(jobDir, { recursive: true });
          const driverName = `run_${jobName}.pl`;
          const driverPath = assertInside(config.workRoot, path.join(jobDir, driverName));
          const projectFolder = `${batchName}/${jobName}`;
          const stagedDocument = `/${batchName}/inputs/${task.documentName}`;
          const driverTask = { ...task, documentName: stagedDocument };
          fs.writeFileSync(
            driverPath,
            buildRemoteCastepBatchScript({
              batchName: jobName,
              tasks: [driverTask],
              commonSettings,
              cores: requestedCores,
            }),
            "utf8",
          );
          return {
            jobName,
            calculationName: task.calculationName,
            sourceDocumentName: task.sourceDocumentName,
            stagedName: task.documentName,
            projectFolder,
            stagedDocument,
            driverName,
            driverPath,
            driverDocument: `/${projectFolder}/${driverName}`,
          };
        })
      : submissionMode === "combined_batch" ? (() => {
          const driverName = `run_${batchName}.pl`;
          const driverPath = assertInside(config.workRoot, path.join(batchDir, driverName));
          const projectFolder = batchName;
          const combinedTasks = stagedTasks.map((task) => ({
            ...task,
            documentName: `/${projectFolder}/${task.documentName}`,
          }));
          fs.writeFileSync(
            driverPath,
            buildRemoteCastepBatchScript({
              batchName,
              tasks: combinedTasks,
              commonSettings,
              cores: requestedCores,
            }),
            "utf8",
          );
          return [{
            jobName: batchName,
            calculationName: null,
            sourceDocumentName: null,
            stagedName: null,
            projectFolder,
            stagedDocument: null,
            driverName,
            driverPath,
            driverDocument: `/${projectFolder}/${driverName}`,
          }];
        })() : [];

    const preparedEntries = submissionMode === "native_castep" ? nativeEntries : driverEntries;

    fs.writeFileSync(manifestPath, JSON.stringify({
      batchName,
      preparedAt: new Date().toISOString(),
      submissionMode,
      executionMode: submissionMode === "native_castep"
        ? "Independent native CASTEP Geometry Optimization jobs"
        : submissionMode === "individual_script"
          ? "Independent Materials Studio Script Jobs / Run on Server"
          : "Combined Materials Studio Script Job / Run on Server",
      gatewaySelection: "Use the existing Materials Studio Job Control configuration",
      requestedCores,
      tasks: stagedTasks,
      drivers: driverEntries.map((entry) => ({
        jobName: entry.jobName,
        calculationName: entry.calculationName,
        driverDocument: entry.driverDocument,
        driverPath: entry.driverPath,
      })),
      nativeJobs: nativeEntries.map((entry) => ({
        jobName: entry.jobName,
        calculationName: entry.calculationName,
        structureDocument: entry.structureDocument,
        settingsDocument: entry.settingsDocument,
      })),
      commonSettings,
    }, null, 2), "utf8");

    const sourceBlocks = submissionMode === "native_castep"
      ? nativeEntries.map((entry) => {
          const task = entry.task;
          const sourceName = entry.sourceDocumentName;
          const importFallbackPath = path.join(config.workRoot, "imports", entry.stagedName);
          const spinSettings = task.initialSpin === null || task.initialSpin === undefined
            ? { SpinTreatment: "Non-polarized" }
            : {
                SpinTreatment: "Collinear",
                UseFormalSpin: "No",
                InitialSpin: Number(task.initialSpin),
                OptimizeTotalSpin: "Yes",
              };
          const nativeSettings = {
            ...legacyCarbonCastepSettings,
            ...commonSettings,
            ...spinSettings,
            ...(task.settings || {}),
          };
          return `
{
    my $source_name = ${perlLiteral(sourceName)};
    my $source_doc;
    eval { $source_doc = $Documents{$source_name}; };
    if (!$source_doc) { eval { $source_doc = $Documents{"/" . $source_name}; }; }
    if (!$source_doc && $source_name !~ /\\.xsd$/i) { eval { $source_doc = $Documents{$source_name . ".xsd"}; }; }
    if (!$source_doc && -e ${perlPathLiteral(importFallbackPath)}) { eval { $source_doc = Documents->Import(${perlPathLiteral(importFallbackPath)}); }; }
    die "Native CASTEP input document not found in GUI project: $source_name" unless $source_doc;
    my $native_structure = $source_doc->SaveAs(${perlLiteral(entry.structureDocument)});
    my $native_settings = Settings(
        ${settingsToPerl(nativeSettings)}
    );
    Modules->CASTEP->ChangeSettings($native_settings);
    eval { Modules->CASTEP->SaveSettings(${perlLiteral(`/${entry.projectFolder}/CASTEP`)}); };
    die "Could not save native CASTEP settings for ${entry.calculationName}: $@" if $@;
    push @ms_mcp_native_structures, $native_structure;
}
`;
        }).join("\n")
      : submissionMode === "individual_script"
      ? (() => {
          const uniqueSources = [...new Map(stagedTasks.map((task) => [task.sourceDocumentName, task])).values()];
          const stageBlocks = uniqueSources.map((task) => {
            const sourceName = task.sourceDocumentName;
            const stagedDocument = `/${batchName}/inputs/${task.documentName}`;
            const importFallbackPath = path.join(config.workRoot, "imports", task.documentName);
            return `
{
    my $source_name = ${perlLiteral(sourceName)};
    my $source_doc;
    eval { $source_doc = $Documents{$source_name}; };
    if (!$source_doc) {
        eval { $source_doc = $Documents{"/" . $source_name}; };
    }
    if (!$source_doc && $source_name !~ /\\.xsd$/i) {
        eval { $source_doc = $Documents{$source_name . ".xsd"}; };
    }
    if (!$source_doc && -e ${perlPathLiteral(importFallbackPath)}) {
        eval { $source_doc = Documents->Import(${perlPathLiteral(importFallbackPath)}); };
    }
    die "Remote CASTEP input document not found in GUI project: $source_name" unless $source_doc;
    $source_doc->SaveAs(${perlLiteral(stagedDocument)});
}
`;
          }).join("\n");
          const driverBlocks = driverEntries.map((entry) => `
{
    my $driver_doc = Documents->Import(${perlPathLiteral(entry.driverPath)});
    my $saved_driver = $driver_doc->SaveAs(${perlLiteral(entry.driverDocument)});
    push @ms_mcp_remote_drivers, $saved_driver;
}
`).join("\n");
          return `${stageBlocks}\n${driverBlocks}`;
        })()
      : (() => {
          const uniqueSources = [...new Set(stagedTasks.map((task) => task.sourceDocumentName))];
          const entry = driverEntries[0];
          const blocks = uniqueSources.map((sourceName) => {
            const stagedName = path.basename(sourceName).replace(/\s+\(\d+\)(?=\.xsd$|$)/i, "");
            const importFallbackPath = path.join(config.workRoot, "imports", stagedName);
            return `
{
    my $source_name = ${perlLiteral(sourceName)};
    my $source_doc;
    eval { $source_doc = $Documents{$source_name}; };
    if (!$source_doc) { eval { $source_doc = $Documents{"/" . $source_name}; }; }
    if (!$source_doc && $source_name !~ /\\.xsd$/i) { eval { $source_doc = $Documents{$source_name . ".xsd"}; }; }
    if (!$source_doc && -e ${perlPathLiteral(importFallbackPath)}) { eval { $source_doc = Documents->Import(${perlPathLiteral(importFallbackPath)}); }; }
    die "Remote CASTEP input document not found in GUI project: $source_name" unless $source_doc;
    $source_doc->SaveAs("/${batchName}/${stagedName}");
}
`;
          }).join("\n");
          return `${blocks}
{
    my $driver_doc = Documents->Import(${perlPathLiteral(entry.driverPath)});
    my $saved_driver = $driver_doc->SaveAs(${perlLiteral(entry.driverDocument)});
    push @ms_mcp_remote_drivers, $saved_driver;
}
`;
        })();

    const readyPayload = JSON.stringify({
      batchName,
      submissionMode,
      status: submissionMode === "native_castep"
        ? "ready_for_individual_native_castep_submission"
        : submissionMode === "individual_script"
          ? "ready_for_individual_run_on_server"
          : "ready_for_run_on_server",
      requestedCores,
      driverDocuments: driverEntries.map((entry) => entry.driverDocument),
      structureDocuments: nativeEntries.map((entry) => entry.structureDocument),
      settingsDocuments: nativeEntries.map((entry) => entry.settingsDocument),
      preparedAt: "written_by_materials_studio_client",
    }, null, 2);
    const stopPath = path.join(config.queueDir, "stop");
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);

${traceSnippet(config, `Prepare remote CASTEP Script Job ${batchName}`)}
my @ms_mcp_remote_drivers;
my @ms_mcp_native_structures;
${sourceBlocks}
eval {
    if (@ms_mcp_native_structures) {
        Documents->ActiveDocument = $ms_mcp_native_structures[0];
    } elsif (@ms_mcp_remote_drivers) {
        Documents->ActiveDocument = $ms_mcp_remote_drivers[0];
    }
};

open(my $ready_fh, ">", ${perlPathLiteral(readyPath)}) or die "Cannot write remote batch ready marker: $!";
print $ready_fh ${perlLiteral(readyPayload)};
close($ready_fh);
${stopGuiLoopAfterPrepare ? `open(my $stop_fh, ">", ${perlPathLiteral(stopPath)}) or die "Cannot request GUI loop stop: $!"; close($stop_fh);` : ""}
print "Prepared ${preparedEntries.length} independent CASTEP submission entries for ${batchName}.\\n";
`;
    const queued = queueScript(config, `prepare_remote_castep_${batchName}`, script);
    writeState(config, {
      lastJob: {
        type: "prepare_remote_castep_batch",
        batchName,
        queued,
        driverPaths: driverEntries.map((entry) => entry.driverPath),
        driverDocuments: driverEntries.map((entry) => entry.driverDocument),
        manifestPath,
        readyPath,
        taskCount: normalizedTasks.length,
        structureDocuments: nativeEntries.map((entry) => entry.structureDocument),
        settingsDocuments: nativeEntries.map((entry) => entry.settingsDocument),
        jobCount: preparedEntries.length,
        submissionMode,
        stopGuiLoopAfterPrepare,
      },
    });
    appendHistory(config, {
      type: "prepare_remote_castep_batch",
      batchName,
      queued,
      driverPaths: driverEntries.map((entry) => entry.driverPath),
      driverDocuments: driverEntries.map((entry) => entry.driverDocument),
      manifestPath,
      readyPath,
      taskCount: normalizedTasks.length,
      structureDocuments: nativeEntries.map((entry) => entry.structureDocument),
      settingsDocuments: nativeEntries.map((entry) => entry.settingsDocument),
      jobCount: preparedEntries.length,
      submissionMode,
      stopGuiLoopAfterPrepare,
    });
    return text({
      ok: true,
      queued,
      batchName,
      taskCount: normalizedTasks.length,
      jobCount: preparedEntries.length,
      submissionMode,
      driverPaths: driverEntries.map((entry) => entry.driverPath),
      driverDocuments: driverEntries.map((entry) => entry.driverDocument),
      structureDocuments: nativeEntries.map((entry) => entry.structureDocument),
      settingsDocuments: nativeEntries.map((entry) => entry.settingsDocument),
      manifestPath,
      readyPath,
      stopGuiLoopAfterPrepare,
      nextAction: submissionMode === "native_castep"
        ? "Open each listed structureDocument one at a time. In CASTEP Calculation select Geometry Optimization, verify its saved CASTEP settings, choose the buhan Gateway and 48 cores, then click Run. Submit every XSD separately. Do not submit a .pl driver."
        : submissionMode === "individual_script"
          ? "Open each listed driverDocument and submit it separately with Run on Server (Ctrl+F5). Select 48 cores for every submission."
          : "Submit the active combined driver with Run on Server (Ctrl+F5), using the existing Gateway and queue selection.",
    });
  },
);

server.tool(
  "ms_remote_castep_record_submission",
  "Record one Materials Studio Job Control receipt. For native_castep preparation, call this once per calculationName after submitting its XSD from the CASTEP Calculation dialog.",
  {
    batchName: z.string().regex(/^[A-Za-z0-9._-]+$/),
    calculationName: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
    submissionMode: z.enum(["native_castep", "individual_script", "combined_batch"]).default("native_castep"),
    jobId: z.string().min(1),
    gateway: z.string().min(1),
    serverType: z.string().optional(),
    status: z.enum(["queued", "running", "completed", "failed", "stopped", "unknown"]).default("unknown"),
    driverDocument: z.string().optional(),
    structureDocument: z.string().optional(),
    submittedAt: z.string().optional(),
  },
  async ({ batchName, calculationName, submissionMode, jobId, gateway, serverType, status, driverDocument, structureDocument, submittedAt }) => {
    refreshProjectSession(config);
    const batchDir = assertInside(config.workRoot, path.join(config.projectRoot, "remote-castep", batchName));
    fs.mkdirSync(batchDir, { recursive: true });
    const receiptDir = calculationName
      ? assertInside(config.workRoot, path.join(batchDir, "jobs", calculationName))
      : batchDir;
    fs.mkdirSync(receiptDir, { recursive: true });
    const receiptStem = calculationName || batchName;
    const receiptPath = assertInside(config.workRoot, path.join(receiptDir, `${receiptStem}_submission.json`));
    let priorReceipt = null;
    if (fs.existsSync(receiptPath)) {
      try { priorReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); } catch { priorReceipt = null; }
    }
    const receipt = {
      batchName,
      calculationName: calculationName || null,
      submissionMode,
      jobId,
      gateway,
      serverType: serverType || (submissionMode === "native_castep" ? "CASTEP" : "Scripting"),
      submittedAt: submittedAt || priorReceipt?.submittedAt || new Date().toISOString(),
      lastObservedAt: new Date().toISOString(),
      lastObservedStatus: status,
      submissionMethod: submissionMode === "native_castep"
        ? "Materials Studio CASTEP Calculation dialog / Run"
        : "Materials Studio Run on Server (Ctrl+F5)",
      structureDocument: structureDocument || priorReceipt?.structureDocument || (calculationName ? `/${batchName}/${calculationName}/${calculationName}.xsd` : null),
      driverDocument: driverDocument || priorReceipt?.driverDocument || (submissionMode === "native_castep" ? null : `/${batchName}/run_${batchName}.pl`),
    };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
    appendHistory(config, { type: "remote_castep_submission", ...receipt, receiptPath });
    return text({ ok: true, receiptPath, receipt });
  },
);

server.tool(
  "ms_remote_castep_batch_status",
  "Read the local preparation markers, submission receipt, and downloaded result summary available for a remote CASTEP batch.",
  {
    batchName: z.string().regex(/^[A-Za-z0-9._-]+$/),
  },
  async ({ batchName }) => {
    refreshProjectSession(config);
    const batchDir = assertInside(config.workRoot, path.join(config.projectRoot, "remote-castep", batchName));
    const paths = {
      manifest: path.join(batchDir, `${batchName}_manifest.json`),
      ready: path.join(batchDir, `${batchName}_ready.json`),
      receipt: path.join(batchDir, `${batchName}_submission.json`),
      results: path.join(batchDir, `${batchName}_results.csv`),
    };
    const readJsonIfPresent = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const manifest = readJsonIfPresent(paths.manifest);
    const jobReceipts = (manifest?.nativeJobs || manifest?.drivers || []).map((job) => {
      const calculationName = job.calculationName || job.jobName;
      const receiptPath = path.join(batchDir, "jobs", calculationName, `${calculationName}_submission.json`);
      return {
        calculationName,
        receiptPath: fs.existsSync(receiptPath) ? receiptPath : null,
        receipt: readJsonIfPresent(receiptPath),
      };
    });
    return text({
      ok: true,
      batchName,
      batchDir,
      prepared: fs.existsSync(paths.ready),
      submitted: fs.existsSync(paths.receipt),
      resultsDownloaded: fs.existsSync(paths.results),
      manifest,
      ready: readJsonIfPresent(paths.ready),
      receipt: readJsonIfPresent(paths.receipt),
      jobReceipts,
      resultsPath: fs.existsSync(paths.results) ? paths.results : null,
    });
  },
);

server.tool(
  "ms_gui_castep_current",
  "Queue a CASTEP calculation on the current GUI document. Supports Energy, GeometryOptimization, phonon/frequency, DOS, band structure, charge density, and density difference presets.",
  {
    documentName: z.string().optional(),
    calculationType: z
      .enum(castepCalculationTypes)
      .default("Energy")
      .describe("High-level CASTEP calculation preset."),
    calculationName: z.string().default("CASTEP_Calculation"),
    resultDocument: z.string().default("CASTEP.xsd"),
    exportFile: z.string().optional(),
    quality: z.enum(["Coarse", "Medium", "Fine"]).default("Medium"),
    kPointQuality: z.enum(["Coarse", "Medium", "Fine"]).default("Medium"),
    cores: z.number().int().positive().max(256).optional(),
    extraSettings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  },
  async ({ documentName, calculationType, calculationName, resultDocument, exportFile, quality, kPointQuality, cores, extraSettings }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for CASTEP calculation." });
    }
    const preset = castepPreset(calculationType);
    const calcName = compactCalculationName(calculationName, { moduleName: "CASTEP", taskName: String(calculationType).toLowerCase(), fallback: "calculation" });
    const calcDir = assertInside(config.workRoot, path.join(config.projectRoot, calcName));
    fs.mkdirSync(calcDir, { recursive: true });
    const workingDocument = calculationDocumentName(resultDocument, "CASTEP.xsd");
    const calculationSettingsDocument = "CASTEP - Calculation";
    const exportPath = exportFile ? projectOutputPath(exportFile) : assertInside(config.workRoot, path.join(calcDir, workingDocument));
    const settingsJsonPath = assertInside(config.workRoot, path.join(calcDir, "CASTEP_settings.json"));
    const settingsTextPath = assertInside(config.workRoot, path.join(calcDir, "CASTEP_settings.txt"));
    const summaryPath = assertInside(config.workRoot, path.join(calcDir, "CASTEP_summary.txt"));
    const reportPath = assertInside(config.workRoot, path.join(calcDir, "CASTEP.txt"));
    const settings = mergeSettings(
      {
        Quality: quality,
        PropertiesKPointQuality: kPointQuality,
      },
      preset.settings,
      extraSettings,
    );
    fs.writeFileSync(
      settingsJsonPath,
      JSON.stringify({ module: "CASTEP", task: preset.task, calculationType, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, cores: cores || null, settings }, null, 2),
      "utf8",
    );
    fs.writeFileSync(
      settingsTextPath,
      [
        "Module: CASTEP",
        `Task: ${preset.task}`,
        `CalculationType: ${calculationType}`,
        `CalculationName: ${calcName}`,
        `SourceDocument: ${targetDocument}`,
        `WorkingDocument: ${workingDocument}`,
        `CalculationSettingsDocument: ${calculationSettingsDocument}`,
        cores ? `RequestedCores: ${cores}` : "RequestedCores: default",
        "",
        ...Object.entries(settings).map(([key, value]) => `${key} = ${value}`),
        "",
      ].join("\n"),
      "utf8",
    );
    const settingsText = settingsToPerl(settings);
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${cores ? `$ENV{DSD_NumProc} = ${cores};` : ""}
${traceSnippet(config, `CASTEP ${calculationType} ${targetDocument} as ${calcName}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${guiCalculationCleanupSnippet({
  calcNameExpression: `"${calcName.replace(/"/g, '\\"')}"`,
  sourceNameExpression: `"${String(targetDocument).replace(/"/g, '\\"')}"`,
})}
ms_mcp_cleanup_root_calculation_artifacts($ms_mcp_calc_source_name);
my $settings = Settings(
        ${settingsText}
    );
my $calc_doc = $doc;
my $ms_mcp_error = "";
eval {
    my $copy = $doc->SaveAs("/${calcName}/${workingDocument}");
    $calc_doc = $copy if $copy;
    Modules->CASTEP->ChangeSettings($settings);
    eval { Modules->CASTEP->SaveSettings("/${calcName}/CASTEP"); };
    if ($@) {
        print "Warning: could not save CASTEP calculation settings document /${calcName}/${calculationSettingsDocument}. $@\\n";
    }
    my $results = Modules->CASTEP->${preset.task}->Run($calc_doc, $settings);
    eval {
        my $result_doc = $results->Structure;
        $doc = $result_doc if $result_doc;
    };
    $doc->Export(${perlPathLiteral(exportPath)});
    eval {
        my $report = $results->Report;
        $report->Export(${perlPathLiteral(reportPath)});
    };
    open(my $summary_fh, ">>", ${perlPathLiteral(summaryPath)}) or die "Cannot write CASTEP summary: $!";
    print $summary_fh "CASTEP ${calculationType} finished for ${targetDocument} as ${calcName} at " . scalar(localtime()) . "\\n";
    print $summary_fh "Task: ${preset.task}\\n";
    ${cores ? `print $summary_fh "RequestedCores: ${cores}\\n";` : ""}
    eval { print $summary_fh "TotalEnergy: " . $results->TotalEnergy . "\\n"; };
    close($summary_fh);
};
if ($@) {
    $ms_mcp_error = $@;
    ms_mcp_cleanup_failed_calculation_folder($ms_mcp_calc_folder_name);
    ms_mcp_cleanup_root_calculation_artifacts($ms_mcp_calc_source_name);
    die "CASTEP ${calculationType} failed and MS-MCP cleaned the failed calculation artifacts: $ms_mcp_error";
}
${stateWriteSnippet(config, {
  currentDocument: workingDocument,
  currentExport: exportPath,
  lastJob: { type: "castep_calculation", calculationType, task: preset.task, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, exportPath, calcDir, cores: cores || null, settings },
})}
print "Queued CASTEP ${calculationType} completed for ${targetDocument}\\n";
`;
    const queued = queueScript(config, "gui_castep_current", script);
    writeState(config, { lastJob: { type: "queued_castep", queued, calculationType, task: preset.task, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, calcDir, cores: cores || null } });
    appendHistory(config, { type: "queued_castep", queued, calculationType, task: preset.task, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, exportPath, calcDir, cores: cores || null, settings });
    return text({ ok: true, queued, calculationType, task: preset.task, calculationName: calcName, sourceDocument: targetDocument, workingDocument, calculationSettingsDocument, calcDir, exportPath, cores: cores || null, settings, settingsJsonPath, settingsTextPath });
  },
);

server.tool(
  "ms_gui_model_current",
  "Queue a basic Materials Studio modeling-toolbar operation on the current GUI document, such as Clean or AdjustHydrogen, without creating a new document.",
  {
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    operation: z.enum(["Clean", "AdjustHydrogen", "CleanAndAdjustHydrogen"]).default("Clean"),
    cleanIterations: z.number().int().positive().max(1000).default(1),
    ballAndStick: z.boolean().default(true),
  },
  async ({ documentName, exportFile, operation, cleanIterations, ballAndStick }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for GUI modeling operation." });
    }
    const nameGuard = inPlaceDocumentNameGuard({ state, documentName, exportFile, operation: "ms_gui_model_current" });
    if (nameGuard) return text(nameGuard);
    const exportPath = modelingExportPath({ exportFile, state, documentName: targetDocument });
    const action =
      operation === "AdjustHydrogen"
        ? "$doc->AdjustHydrogen;\n"
        : operation === "CleanAndAdjustHydrogen"
          ? `$doc->AdjustHydrogen;\nmy $converged = 0;\nfor (my $i = 0; $i < ${cleanIterations}; $i++) {\n    $converged = $doc->Clean;\n    last if $converged;\n}\n$doc->AdjustHydrogen;\n`
          : `my $converged = 0;\nfor (my $i = 0; $i < ${cleanIterations}; $i++) {\n    $converged = $doc->Clean;\n    last if $converged;\n}\n`;
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Model ${operation} on ${targetDocument}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${action}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save: true })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "model_current", operation, requestedDocumentName: targetDocument, exportPath, cleanIterations },
})}
print "Applied ${operation} to current document ${targetDocument}\\n";
`;
    const queued = queueScript(config, `gui_model_${operation.toLowerCase()}`, script);
    writeState(config, {
      currentDocument: targetDocument,
      currentExport: exportPath,
      lastJob: { type: "queued_model_current", queued, operation, documentName: targetDocument },
    });
    appendHistory(config, { type: "queued_model_current", queued, operation, documentName: targetDocument, exportPath, cleanIterations });
    return text({ ok: true, queued, currentDocument: targetDocument, exportPath, operation, cleanIterations });
  },
);

server.tool(
  "ms_gui_edit_current",
  "Queue a basic molecule-building edit on the current GUI document, such as adding/deleting bonds, changing an atom element, adding/deleting atoms, recalculating bonds, Clean, or AdjustHydrogen.",
  {
    documentName: z.string().optional(),
    exportFile: z.string().optional(),
    operation: z
      .enum([
        "AddAtom",
        "DeleteAtom",
        "ChangeElement",
        "RenameAtom",
        "AddBond",
        "DeleteBond",
        "SetBondType",
        "CalculateBonds",
        "Clean",
        "AdjustHydrogen",
        "CleanAndAdjustHydrogen",
      ])
      .default("Clean"),
    atom: z.string().optional().describe("Atom selector by atom Name or 1-based atom index."),
    atom1: z.string().optional().describe("First atom selector by atom Name or 1-based atom index."),
    atom2: z.string().optional().describe("Second atom selector by atom Name or 1-based atom index."),
    element: z.string().regex(/^[A-Z][a-z]?$/).optional(),
    bondType: z.enum(["Single", "Partial double", "Aromatic", "Double", "Triple"]).default("Single"),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_ -]*$/).optional(),
    cleanIterations: z.number().int().positive().max(1000).default(1),
    adjustHydrogenAfter: z.boolean().default(false),
    cleanAfter: z.boolean().default(false),
    allowPeriodicBondGuess: z.boolean().default(false).describe("Allow broad CalculateBonds on periodic documents. Keep false unless the user explicitly accepts periodic bond guessing."),
    ballAndStick: z.boolean().default(true),
  },
  async ({
    documentName,
    exportFile,
    operation,
    atom,
    atom1,
    atom2,
    element,
    bondType,
    x,
    y,
    z,
    name,
    cleanIterations,
    adjustHydrogenAfter,
    cleanAfter,
    allowPeriodicBondGuess,
    ballAndStick,
  }) => {
    ensureGuiQueueAllowed();
    const state = readState(config);
    const targetDocument = documentName || state.currentDocument;
    if (!targetDocument) {
      return text({ ok: false, error: "No currentDocument is set for GUI edit operation." });
    }
    const nameGuard = inPlaceDocumentNameGuard({ state, documentName, exportFile, operation: "ms_gui_edit_current" });
    if (nameGuard) return text(nameGuard);
    let action;
    try {
      action = guiEditActionSnippet({ operation, atom, atom1, atom2, element, bondType, x, y, z, name, cleanIterations, allowPeriodicBondGuess });
    } catch (error) {
      return text({ ok: false, error: error.message });
    }
    const exportPath = modelingExportPath({ exportFile, state, documentName: targetDocument });
    const followUp = `${adjustHydrogenAfter ? "$doc->AdjustHydrogen;\n" : ""}${cleanAfter ? "$doc->Clean;\n" : ""}`;
    const script = `use strict;
use warnings;
use MaterialsScript qw(:all);
${traceSnippet(config, `Edit ${operation} on ${targetDocument}`)}
${documentResolverSnippet({ documentName: targetDocument })}
${guiDocumentReuseSnippet(`"${String(targetDocument).replace(/"/g, '\\"')}"`)}
${atomLookupSnippet()}
${action}
${followUp}
${ballAndStick ? ballStickSnippet() : ""}
${saveExportSnippet({ exportPath, save: true })}
ms_mcp_delete_numbered_duplicates($doc, $ms_mcp_requested_doc_name);
${stateWriteRuntimeDocSnippet(config, {
  currentExport: exportPath,
  lastJob: { type: "edit_current", operation, requestedDocumentName: targetDocument, exportPath },
})}
print "Applied GUI edit ${operation} to current document ${targetDocument}\\n";
`;
    const queued = queueScript(config, `gui_edit_${operation.toLowerCase()}`, script);
    writeState(config, {
      currentDocument: targetDocument,
      currentExport: exportPath,
      lastJob: { type: "queued_edit_current", queued, operation, documentName: targetDocument },
    });
    appendHistory(config, {
      type: "queued_edit_current",
      queued,
      operation,
      documentName: targetDocument,
      exportPath,
      atom,
      atom1,
      atom2,
      element,
      bondType,
      name,
      allowPeriodicBondGuess,
    });
    return text({ ok: true, queued, currentDocument: targetDocument, exportPath, operation, allowPeriodicBondGuess });
  },
);

server.tool(
  "ms_create_molecule",
  "Create a standalone molecule/crystal document from explicit atoms and bonds using MaterialsScript. For the already-open GUI project, prefer ms_gui_create_current to avoid duplicate GUI documents.",
  {
    documentName: z.string().regex(/^[a-zA-Z0-9._ -]+\.xsd$/),
    atoms: z.array(
      z.object({
        label: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).optional(),
        element: z.string().min(1).max(3),
        x: z.number(),
        y: z.number(),
        z: z.number(),
      }),
    ),
    bonds: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          order: z.enum(["Single", "Double", "Triple", "Aromatic"]).default("Single"),
        }),
      )
      .default([]),
    project: z.boolean().default(false),
  },
  async ({ documentName, atoms, bonds, project }) => {
    const jobDir = newJobDir(config, "create_molecule");
    const source = buildMoleculeScript({ documentName, atoms, bonds });
    const scriptFile = writeScript(jobDir, "create_molecule", source);
    const result = await runMatScript(config, scriptFile, [], { project });
    return text({ ...result, jobDir, documentName });
  },
);

server.tool(
  "ms_forcite",
  "Run a Forcite task on an input document located under the MS-MCP work root.",
  {
    inputDocument: z.string(),
    task: z.enum(["Energy", "GeometryOptimization", "Dynamics"]).default("Energy"),
    settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    cores: z.number().int().positive().optional(),
    project: z.boolean().default(true),
  },
  async ({ inputDocument, task, settings, cores, project }) => {
    const inputPath = assertInside(config.workRoot, path.resolve(config.workRoot, inputDocument));
    const jobDir = newJobDir(config, `forcite_${task}`);
    const source = buildForciteEnergyScript({ inputDocument: inputPath.replace(/\\/g, "\\\\"), task, settings });
    const scriptFile = writeScript(jobDir, `forcite_${task}`, source);
    const result = await runMatScript(config, scriptFile, [], { cores, project });
    return text({ ...result, jobDir, inputDocument: inputPath });
  },
);

server.tool(
  "ms_castep",
  "Run a CASTEP task or preset calculation on an input document located under the MS-MCP work root. Presets include Energy, GeometryOptimization, Frequency/phonons, DOS, band structure, charge density, and density difference.",
  {
    inputDocument: z.string(),
    task: z
      .enum([...castepBaseTasks, ...castepCalculationTypes])
      .default("Energy")
      .describe("CASTEP task name or high-level preset. Presets are mapped to the correct CASTEP task and property settings."),
    settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    cores: z.number().int().positive().optional(),
    project: z.boolean().default(true),
  },
  async ({ inputDocument, task, settings, cores, project }) => {
    const inputPath = assertInside(config.workRoot, path.resolve(config.workRoot, inputDocument));
    const preset = castepPreset(task);
    const resolvedSettings = mergeSettings(preset.settings, settings);
    const jobDir = newJobDir(config, `castep_${task}`);
    const source = buildCastepScript({ inputDocument: inputPath.replace(/\\/g, "\\\\"), task: preset.task, settings: resolvedSettings });
    const scriptFile = writeScript(jobDir, `castep_${task}`, source);
    const result = await runMatScript(config, scriptFile, [], { cores, project });
    return text({ ...result, jobDir, inputDocument: inputPath, requestedTask: task, task: preset.task, settings: resolvedSettings });
  },
);

server.tool(
  "ms_list_workspace",
  "List files under the MS-MCP work root.",
  {
    subdir: z.string().default("."),
    maxFiles: z.number().int().positive().max(500).default(100),
  },
  async ({ subdir, maxFiles }) => {
    const root = assertInside(config.workRoot, path.resolve(config.workRoot, subdir));
    const rows = [];
    function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (rows.length >= maxFiles) return;
        const full = path.join(dir, item.name);
        const stat = fs.statSync(full);
        rows.push({
          path: path.relative(config.workRoot, full),
          type: item.isDirectory() ? "dir" : "file",
          bytes: stat.size,
          modified: stat.mtime.toISOString(),
        });
        if (item.isDirectory()) walk(full);
      }
    }
    if (fs.existsSync(root)) walk(root);
    return text(rows);
  },
);

server.tool(
  "ms_read_text",
  "Read a text output file under the MS-MCP work root.",
  {
    file: z.string(),
    maxBytes: z.number().int().positive().max(500000).default(100000),
  },
  async ({ file, maxBytes }) => {
    const full = assertInside(config.workRoot, path.resolve(config.workRoot, file));
    const data = fs.readFileSync(full);
    return text(data.subarray(0, maxBytes).toString("utf8"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
void ensureDashboardStarted();
