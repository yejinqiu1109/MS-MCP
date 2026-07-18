import assert from "node:assert/strict";
import { buildRemoteCastepBatchScript, normalizeRemoteCastepTasks } from "../src/remoteCastep.js";
import { parseCastepConvergence } from "../src/castepConvergence.js";

const tasks = normalizeRemoteCastepTasks([{
  documentName: "BLG_Cr_C3.xsd",
  calculationName: "BLG_Cr_C3_spin4",
  metal: "Cr",
  initialSpin: 4,
}]);
const script = buildRemoteCastepBatchScript({ batchName: "chapter3_stage1", tasks });

assert.match(script, /Modules->CASTEP->GeometryOptimization->Run/);
assert.match(script, /"XCFunctional" => "PBE"/);
assert.match(script, /"DFTDMethod" => "TS"/);
assert.match(script, /"EnergyCutoff" => 326\.5/);
assert.match(script, /"KPointDerivation" => "Gamma"/);
assert.match(script, /"InitialSpin" => 4/);
assert.match(script, /"CellOptimization" => "None"/);
assert.match(script, /chapter3_stage1_results\.csv/);
assert.match(script, /write_castep_convergence_csvs/);
assert.match(script, /_scf_convergence\.csv/);
assert.match(script, /_geometry_convergence\.csv/);
assert.match(script, /ConvergenceDataStatus/);
assert.match(script, /SCFBlock SCFCycle Label Energy_eV/);
assert.match(script, /GeometryIteration Enthalpy_eV EnergyChangePerIon_eV/);
assert.doesNotMatch(script, /Gateway|202\.4\.137\.60/);

const parsed = parseCastepConvergence(`
SCF loop      Energy           Fermi           Energy gain       Timer   <-- SCF
Initial  -9.96613299E+003  0.00000000E+000                         6.62  <-- SCF
      1  -3.64435437E+004  9.93228279E-001   1.03832983E+002      64.09  <-- SCF
Final energy, E             =  -40154.50384863     eV
LBFGS: finished iteration     1 with enthalpy= -4.01783434E+004 eV
|  dE/ion   |   5.365326E-003 |   1.000000E-005 |         eV | No  | <-- LBFGS
|  |F|max   |   7.544046E-001 |   3.000000E-002 |       eV/A | No  | <-- LBFGS
|  |dR|max  |   7.349362E-002 |   1.000000E-003 |          A | No  | <-- LBFGS
`);
assert.equal(parsed.scf.length, 2);
assert.equal(parsed.scf[1].energyEV, "-3.64435437E+004");
assert.equal(parsed.geometry.length, 1);
assert.equal(parsed.geometry[0].maxForceEVPerA, "7.544046E-001");
assert.equal(parsed.geometry[0].displacementOK, "No");

console.log("Remote CASTEP generator smoke passed.");

