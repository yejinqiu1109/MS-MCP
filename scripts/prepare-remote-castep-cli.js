import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const manifestFile = process.argv[2];
if (!manifestFile) throw new Error("Usage: node scripts/prepare-remote-castep-cli.js <batch.json>");
const payload = JSON.parse(fs.readFileSync(path.resolve(manifestFile), "utf8"));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repoRoot, "src", "index.js")],
  env: {
    ...process.env,
    MS_MCP_ALLOW_ARBITRARY_SCRIPT: "0",
    MS_MCP_ALLOW_GUI_QUEUE: "1",
    MS_MCP_ALLOW_EXTERNAL_INPUTS: "0",
  },
});
const client = new Client({ name: "ms-mcp-remote-castep-cli", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "ms_gui_prepare_remote_castep_batch",
    arguments: payload,
  });
  process.stdout.write(`${result.content?.[0]?.text || JSON.stringify(result)}\n`);
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}

