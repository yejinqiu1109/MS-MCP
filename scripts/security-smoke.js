import assert from "node:assert/strict";
import path from "node:path";
import { assertInside, loadConfig } from "../src/config.js";

const required = ["MS_INSTALL_ROOT", "MS_MCP_WORK_ROOT"];
for (const name of required) assert.ok(process.env[name], `${name} is required.`);

delete process.env.MS_MCP_ALLOW_ARBITRARY_SCRIPT;
delete process.env.MS_MCP_ALLOW_GUI_QUEUE;
delete process.env.MS_MCP_ALLOW_EXTERNAL_INPUTS;
delete process.env.MS_MCP_PROJECT_ROOT;
delete process.env.MS_MCP_PROJECT_FOLDER;

const config = loadConfig();
assert.equal(config.allowArbitraryScript, false, "Arbitrary scripting must fail closed.");
assert.equal(config.allowGuiQueue, false, "GUI queueing must require explicit enablement.");
assert.equal(config.allowExternalInputs, false, "External inputs must fail closed.");

const lexicalEscape = path.resolve(config.workRoot, "..", "outside-work-root");
assert.throws(() => assertInside(config.workRoot, lexicalEscape), /outside work root/i);

process.env.MS_MCP_PROJECT_ROOT = lexicalEscape;
assert.throws(() => loadConfig(), /outside work root/i);
delete process.env.MS_MCP_PROJECT_ROOT;

console.log("Security smoke passed: fail-closed flags and workspace boundary checks are active.");

