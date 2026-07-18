import fs from "node:fs";
import { loadConfig, summarizeConfig } from "../src/config.js";

const config = loadConfig();
const summary = summarizeConfig(config);

console.log(JSON.stringify(summary, null, 2));

if (!summary.installRootExists) {
  throw new Error(`Materials Studio install root not found: ${config.installRoot}`);
}
if (!summary.runMatScriptExists) {
  throw new Error(`RunMatScript not found: ${config.runMatScript}`);
}

fs.mkdirSync(config.workRoot, { recursive: true });
console.log("Smoke check passed.");

