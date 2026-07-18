import fs from "node:fs";
import path from "node:path";
import { ensureProjectSession, refreshProjectSession } from "./config.js";

export function statePath(config) {
  return config.stateFile || path.join(config.workRoot, ".ms-mcp-state.json");
}

export function readState(config) {
  refreshProjectSession(config);
  const file = statePath(config);
  if (!fs.existsSync(file)) {
    return {
      currentDocument: null,
      currentExport: null,
      lastJob: null,
      history: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      currentDocument: null,
      currentExport: null,
      lastJob: null,
      history: [],
      warning: `Could not parse ${file}`,
    };
  }
}

export function writeState(config, nextState) {
  ensureProjectSession(config);
  const current = readState(config);
  const merged = {
    ...current,
    ...nextState,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath(config), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export function appendHistory(config, entry) {
  const state = readState(config);
  const history = Array.isArray(state.history) ? state.history : [];
  history.push({
    ...entry,
    at: new Date().toISOString(),
  });
  return writeState(config, { history: history.slice(-200) });
}
