const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_MARKER = "paseo-packaged-runtime-ok";

// `codesign --verify --deep --strict` validates signatures without ever mapping
// the binaries, so it accepts bundles dyld will refuse to start (for example a
// hardened-runtime ad-hoc build whose helper and Electron Framework share no
// Team ID). The only trustworthy check is executing the packaged helper the
// same way the LaunchAgent daemon launcher and the CLI shim do —
// ELECTRON_RUN_AS_NODE against Paseo Helper — without starting any daemon or
// opening a window.
function assertPackagedMacRuntime({ appPath }) {
  for (const name of ["paseo", "paseo-daemon-launcher"]) {
    const binPath = path.join(appPath, "Contents", "Resources", "bin", name);
    fs.accessSync(binPath, fs.constants.X_OK);
  }

  const helperPath = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Paseo Helper.app",
    "Contents",
    "MacOS",
    "Paseo Helper",
  );
  fs.accessSync(helperPath, fs.constants.X_OK);

  const result = spawnSync(helperPath, ["-e", `console.log("${RUNTIME_MARKER}")`], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || !result.stdout.includes(RUNTIME_MARKER)) {
    throw new Error(
      [
        `Packaged Paseo Helper failed to launch in ELECTRON_RUN_AS_NODE mode (status ${result.status}, signal ${result.signal}).`,
        "The bundle is signed but not runnable; launchd daemon startup would fail identically.",
        `stdout: ${result.stdout.trim()}`,
        `stderr: ${result.stderr.trim()}`,
      ].join("\n"),
    );
  }
}

module.exports = { RUNTIME_MARKER, assertPackagedMacRuntime };
