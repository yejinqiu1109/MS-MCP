import fs from "node:fs";
import path from "node:path";

function numberToken(value) {
  return value ? value.replace(/[dD]/g, "E") : "";
}

export function parseCastepConvergence(text) {
  const scf = [];
  const geometryByIteration = new Map();
  let scfBlock = 0;
  let inScf = false;
  let geometryIteration = null;

  for (const line of String(text).split(/\r?\n/)) {
    if (/SCF loop\s+Energy.*<--\s*SCF/i.test(line)) {
      scfBlock += 1;
      inScf = true;
      continue;
    }

    let match = inScf
      ? line.match(/^\s*Initial\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)(?:\s+([+\-0-9.EeDd]+))?\s*<--\s*SCF/i)
      : null;
    if (match) {
      scf.push({
        scfBlock,
        scfCycle: 0,
        label: "Initial",
        energyEV: numberToken(match[1]),
        fermiEnergyEV: numberToken(match[2]),
        energyGainPerAtomEV: "",
        timerS: numberToken(match[3]),
      });
      continue;
    }

    match = inScf
      ? line.match(/^\s*(\d+)\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)\s+([+\-0-9.EeDd]+)\s*<--\s*SCF/i)
      : null;
    if (match) {
      scf.push({
        scfBlock,
        scfCycle: Number(match[1]),
        label: "Iteration",
        energyEV: numberToken(match[2]),
        fermiEnergyEV: numberToken(match[3]),
        energyGainPerAtomEV: numberToken(match[4]),
        timerS: numberToken(match[5]),
      });
      continue;
    }

    if (/^\s*Final energy,\s*E\s*=/i.test(line)) {
      inScf = false;
      continue;
    }

    match = line.match(/(?:LBFGS|BFGS):\s*finished iteration\s+(\d+)\s+with enthalpy=\s*([+\-0-9.EeDd]+)/i);
    if (match) {
      geometryIteration = Number(match[1]);
      geometryByIteration.set(geometryIteration, {
        geometryIteration,
        enthalpyEV: numberToken(match[2]),
        energyChangePerIonEV: "",
        maxForceEVPerA: "",
        maxDisplacementA: "",
        energyOK: "",
        forceOK: "",
        displacementOK: "",
      });
      continue;
    }

    if (geometryIteration === null) continue;
    const geometry = geometryByIteration.get(geometryIteration);
    match = line.match(/\|\s*dE\/ion\s*\|\s*([+\-0-9.EeDd]+)\s*\|[^|]*\|[^|]*\|\s*(Yes|No)\s*\|/i);
    if (match) {
      geometry.energyChangePerIonEV = numberToken(match[1]);
      geometry.energyOK = match[2];
      continue;
    }
    match = line.match(/\|\s*\|F\|max\s*\|\s*([+\-0-9.EeDd]+)\s*\|[^|]*\|[^|]*\|\s*(Yes|No)\s*\|/i);
    if (match) {
      geometry.maxForceEVPerA = numberToken(match[1]);
      geometry.forceOK = match[2];
      continue;
    }
    match = line.match(/\|\s*\|dR\|max\s*\|\s*([+\-0-9.EeDd]+)\s*\|[^|]*\|[^|]*\|\s*(Yes|No)\s*\|/i);
    if (match) {
      geometry.maxDisplacementA = numberToken(match[1]);
      geometry.displacementOK = match[2];
    }
  }

  return {
    scf,
    geometry: [...geometryByIteration.values()].sort((left, right) => left.geometryIteration - right.geometryIteration),
  };
}

function csvValue(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function csv(rows, columns) {
  return [
    columns.map(([header]) => csvValue(header)).join(","),
    ...rows.map((row) => columns.map(([, key]) => csvValue(row[key])).join(",")),
  ].join("\n") + "\n";
}

export function writeCastepConvergenceCsv(castepFile, outputDir = path.dirname(castepFile)) {
  const parsed = parseCastepConvergence(fs.readFileSync(castepFile, "utf8"));
  const stem = path.basename(castepFile, path.extname(castepFile));
  fs.mkdirSync(outputDir, { recursive: true });
  const scfFile = path.join(outputDir, `${stem}_scf_convergence.csv`);
  const geometryFile = path.join(outputDir, `${stem}_geometry_convergence.csv`);
  fs.writeFileSync(scfFile, csv(parsed.scf, [
    ["SCFBlock", "scfBlock"],
    ["SCFCycle", "scfCycle"],
    ["Label", "label"],
    ["Energy_eV", "energyEV"],
    ["FermiEnergy_eV", "fermiEnergyEV"],
    ["EnergyGainPerAtom_eV", "energyGainPerAtomEV"],
    ["Timer_s", "timerS"],
  ]));
  fs.writeFileSync(geometryFile, csv(parsed.geometry, [
    ["GeometryIteration", "geometryIteration"],
    ["Enthalpy_eV", "enthalpyEV"],
    ["EnergyChangePerIon_eV", "energyChangePerIonEV"],
    ["MaxForce_eV_per_A", "maxForceEVPerA"],
    ["MaxDisplacement_A", "maxDisplacementA"],
    ["EnergyOK", "energyOK"],
    ["ForceOK", "forceOK"],
    ["DisplacementOK", "displacementOK"],
  ]));
  return { castepFile, scfFile, geometryFile, scfRows: parsed.scf.length, geometryRows: parsed.geometry.length };
}
