import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertInside, ensureProjectSession } from "./config.js";

function safeName(name) {
  return String(name || "ms_job")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
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

function safeCmdArgument(value) {
  const text = String(value);
  if (/[&|<>^%!\r\n]/.test(text)) {
    throw new Error("MaterialsScript arguments cannot contain Windows command metacharacters.");
  }
  return text;
}

export function newJobDir(config, prefix) {
  ensureProjectSession(config);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `${stamp}_${safeName(prefix)}_${crypto.randomBytes(3).toString("hex")}`;
  const dir = assertInside(config.workRoot, path.join(config.projectRoot, id));
  fs.mkdirSync(dir, { recursive: false });
  return dir;
}

export function writeScript(jobDir, scriptName, source) {
  const file = assertInside(jobDir, path.join(jobDir, `${safeName(scriptName)}.pl`));
  fs.writeFileSync(file, source, "utf8");
  return file;
}

export async function runMatScript(config, scriptFile, args = [], options = {}) {
  const cwd = options.cwd ? assertInside(config.workRoot, options.cwd) : path.dirname(scriptFile);
  const scriptBase = path.basename(scriptFile, ".pl");
  const runArgs = [];
  if (options.project) runArgs.push("-project");
  if (options.cores) runArgs.push("-np", String(options.cores));
  runArgs.push(scriptBase);
  if (args.length > 0) runArgs.push("--", ...args.map(safeCmdArgument));

  const env = {
    ...process.env,
    PATH: `${config.binDir};${process.env.PATH || ""}`,
    MS_INSTALL_ROOT: config.installRoot,
  };

  return await new Promise((resolve) => {
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "call", config.runMatScript, ...runArgs], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs || config.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > config.maxOutputBytes) stdout = stdout.slice(-config.maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > config.maxOutputBytes) stderr = stderr.slice(-config.maxOutputBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut, stdout, stderr, error: error.message, cwd, args: runArgs });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, stdout, stderr, cwd, args: runArgs });
    });
  });
}

export function buildMoleculeScript({ documentName, atoms = [], bonds = [] }) {
  const atomLines = atoms
    .map((atom, index) => {
      const label = atom.label || `a${index + 1}`;
      return `my $${label} = $doc->CreateAtom(${perlLiteral(atom.element)}, Point(X => ${Number(atom.x)}, Y => ${Number(atom.y)}, Z => ${Number(atom.z)}));`;
    })
    .join("\n");
  const bondLines = bonds
    .map((bond) => {
      const order = bond.order || "Single";
      return `$doc->CreateBond($${bond.from}, $${bond.to}, ${perlLiteral(order)});`;
    })
    .join("\n");

  return `#!perl
use strict;
use warnings;
use MaterialsScript qw(:all);

my $doc = Documents->New(${perlLiteral(documentName)});
${atomLines}
${bondLines}
$doc->CalculateBonds;
$doc->Save;
print "Created ${documentName}\\n";
`;
}

export function buildForciteEnergyScript({ inputDocument, task = "Energy", settings = {} }) {
  const settingsPairs = Object.entries(settings)
    .map(([key, value]) => `${perlLiteral(key)} => ${typeof value === "number" ? value : typeof value === "boolean" ? (value ? '"Yes"' : '"No"') : perlLiteral(value)}`)
    .join(", ");
  return `#!perl
use strict;
use warnings;
use MaterialsScript qw(:all);

my $doc = Documents->Import(${perlLiteral(inputDocument)});
my $results = Modules->Forcite->${task}->Run($doc, Settings(${settingsPairs}));
print ${perlLiteral(`Forcite ${task} completed for ${inputDocument}\\n`)};
`;
}

export function buildCastepScript({ inputDocument, task = "Energy", settings = {} }) {
  const settingsPairs = Object.entries(settings)
    .map(([key, value]) => `${perlLiteral(key)} => ${typeof value === "number" ? value : typeof value === "boolean" ? (value ? '"Yes"' : '"No"') : perlLiteral(value)}`)
    .join(", ");
  return `#!perl
use strict;
use warnings;
use MaterialsScript qw(:all);

my $doc = Documents->Import(${perlLiteral(inputDocument)});
my $results = Modules->CASTEP->${task}->Run($doc, Settings(${settingsPairs}));
print ${perlLiteral(`CASTEP ${task} completed for ${inputDocument}\\n`)};
`;
}
