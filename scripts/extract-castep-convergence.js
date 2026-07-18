import fs from "node:fs";
import path from "node:path";
import { writeCastepConvergenceCsv } from "../src/castepConvergence.js";

function collectCastepFiles(target, files = []) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (/\.castep$/i.test(target)) files.push(path.resolve(target));
    return files;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    collectCastepFiles(path.join(target, entry.name), files);
  }
  return files;
}

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/extract-castep-convergence.js <file.castep-or-results-directory>");
  process.exitCode = 2;
} else {
  const files = collectCastepFiles(path.resolve(target));
  if (!files.length) {
    console.error(`No .castep files found under ${path.resolve(target)}`);
    process.exitCode = 1;
  } else {
    const results = files.map((file) => writeCastepConvergenceCsv(file));
    console.log(JSON.stringify(results, null, 2));
  }
}

