import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = process.env.MS_MCP_WORK_ROOT;
const installRoot = process.env.MS_INSTALL_ROOT;

assert.ok(workRoot, "MS_MCP_WORK_ROOT is required for this smoke test.");
assert.ok(installRoot, "MS_INSTALL_ROOT is required for this smoke test.");

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

const client = new Client({ name: "ms-mcp-local-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "ms_status"));
  assert.ok(listed.tools.some((tool) => tool.name === "ms_run_materialscript"));
  assert.ok(listed.tools.some((tool) => tool.name === "ms_gui_prepare_remote_castep_batch"));
  assert.ok(listed.tools.some((tool) => tool.name === "ms_remote_castep_record_submission"));
  assert.ok(listed.tools.some((tool) => tool.name === "ms_remote_castep_batch_status"));

  const statusResult = await client.callTool({ name: "ms_status", arguments: {} });
  const status = JSON.parse(statusResult.content[0].text);
  assert.equal(status.installRootExists, true);
  assert.equal(status.runMatScriptExists, true);
  assert.equal(status.allowArbitraryScript, false);
  assert.equal(status.allowGuiQueue, true);
  assert.equal(status.allowExternalInputs, false);

  const blocked = await client.callTool({
    name: "ms_run_materialscript",
    arguments: { name: "must_not_run", script: "die 'this must never execute';" },
  });
  const blockedPayload = JSON.parse(blocked.content[0].text);
  assert.equal(blockedPayload.ok, false);
  assert.match(blockedPayload.error, /disabled/i);

  const rawGuiBlocked = await client.callTool({
    name: "ms_gui_create_current",
    arguments: { documentName: "must_not_exist.xsd", body: "$doc->Save;" },
  });
  assert.equal(rawGuiBlocked.isError, true);
  assert.match(rawGuiBlocked.content[0].text, /Raw MaterialsScript bodies are disabled/i);

  console.log(`MCP smoke passed: ${listed.tools.length} tools; structured GUI queueing is enabled while raw scripting and external inputs are disabled.`);
} finally {
  await client.close();
}
