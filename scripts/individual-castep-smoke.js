import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = path.join(repoRoot, "_individual_castep_smoke_workspace");
const installRoot = process.env.MS_INSTALL_ROOT;
assert.ok(installRoot, "MS_INSTALL_ROOT is required.");

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "src", "index.js")],
  env: {
    ...process.env,
    MS_INSTALL_ROOT: installRoot,
    MS_MCP_WORK_ROOT: workRoot,
    MS_MCP_ALLOW_ARBITRARY_SCRIPT: "0",
    MS_MCP_ALLOW_GUI_QUEUE: "1",
    MS_MCP_ALLOW_EXTERNAL_INPUTS: "0",
  },
});
const client = new Client({ name: "individual-castep-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const nativeResult = await client.callTool({
    name: "ms_gui_prepare_remote_castep_batch",
    arguments: {
      batchName: "native_smoke",
      stopGuiLoopAfterPrepare: false,
      tasks: [
        { documentName: "BLG_Cr_C3.xsd", calculationName: "BLG_Cr_C3_spin2", metal: "Cr", initialSpin: 2 },
        { documentName: "BLG_Cr_C3.xsd", calculationName: "BLG_Cr_C3_spin4", metal: "Cr", initialSpin: 4 },
      ],
    },
  });
  const nativePayload = JSON.parse(nativeResult.content[0].text);
  assert.equal(nativePayload.ok, true);
  assert.equal(nativePayload.submissionMode, "native_castep");
  assert.equal(nativePayload.taskCount, 2);
  assert.equal(nativePayload.jobCount, 2);
  assert.equal(nativePayload.driverPaths.length, 0);
  assert.equal(nativePayload.structureDocuments.length, 2);
  assert.equal(nativePayload.settingsDocuments.length, 2);
  assert.notEqual(nativePayload.structureDocuments[0], nativePayload.structureDocuments[1]);
  const nativeManifest = JSON.parse(fs.readFileSync(nativePayload.manifestPath, "utf8"));
  assert.equal(nativeManifest.submissionMode, "native_castep");
  assert.equal(nativeManifest.nativeJobs.length, 2);
  assert.equal(nativeManifest.drivers.length, 0);
  const preparationScript = fs.readFileSync(nativePayload.queued, "utf8");
  assert.match(preparationScript, /Modules->CASTEP->SaveSettings/);
  assert.doesNotMatch(preparationScript, /GeometryOptimization->Run/);

  const scriptResult = await client.callTool({
    name: "ms_gui_prepare_remote_castep_batch",
    arguments: {
      batchName: "individual_script_smoke",
      submissionMode: "individual_script",
      stopGuiLoopAfterPrepare: false,
      tasks: [
        { documentName: "BLG_Cr_C3.xsd", calculationName: "BLG_Cr_C3_spin2", metal: "Cr", initialSpin: 2 },
        { documentName: "BLG_Cr_C3.xsd", calculationName: "BLG_Cr_C3_spin4", metal: "Cr", initialSpin: 4 },
      ],
    },
  });
  const payload = JSON.parse(scriptResult.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.submissionMode, "individual_script");
  assert.equal(payload.taskCount, 2);
  assert.equal(payload.jobCount, 2);
  assert.equal(payload.driverPaths.length, 2);
  assert.equal(payload.driverDocuments.length, 2);
  assert.notEqual(payload.driverDocuments[0], payload.driverDocuments[1]);

  for (const driverPath of payload.driverPaths) {
    assert.equal(fs.existsSync(driverPath), true);
    const driver = fs.readFileSync(driverPath, "utf8");
    assert.equal((driver.match(/GeometryOptimization->Run/g) || []).length, 1);
    assert.match(driver, /DSD_NumProc\} = 48/);
    assert.match(driver, /_scf_convergence\.csv/);
    assert.match(driver, /_geometry_convergence\.csv/);
  }

  const manifest = JSON.parse(fs.readFileSync(payload.manifestPath, "utf8"));
  assert.equal(manifest.submissionMode, "individual_script");
  assert.equal(manifest.drivers.length, 2);
  assert.ok(manifest.drivers.every((driver) => driver.driverDocument.includes("/individual_script_smoke/")));
  console.log("Native and independent-script CASTEP preparation smoke passed.");
} finally {
  await client.close();
  fs.rmSync(workRoot, { recursive: true, force: true });
}

