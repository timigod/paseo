const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { assertWorkspaceExactSource } = require("./build-provenance-gate.js");

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
assertWorkspaceExactSource({ workspaceRoot });

const command = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
const result = spawnSync(command, ["--config", "electron-builder.yml", ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
