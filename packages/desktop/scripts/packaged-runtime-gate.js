const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { isUnsignedMacBuildRequested } = require("./run-electron-builder.js");

const RUNTIME_MARKER = "paseo-packaged-runtime-ok";
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function resolveElectronBuilderTargetArch(arch, hostArch = process.arch) {
  if (arch === undefined || arch === null) return hostArch;
  return ARCH_MAP[arch] || String(arch);
}

function shouldRunPackagedRuntimeGate({ env, phase }) {
  const unsigned = isUnsignedMacBuildRequested(env);
  return unsigned ? phase === "afterPack" : phase === "afterSign";
}

// `codesign --verify --deep --strict` validates signatures without ever mapping
// the binaries, so it accepts bundles dyld will refuse to start (for example a
// hardened-runtime ad-hoc build whose helper and Electron Framework share no
// Team ID). The only trustworthy check is executing the packaged helper the
// same way the LaunchAgent daemon launcher and the CLI shim do —
// ELECTRON_RUN_AS_NODE against Paseo Helper — without starting any daemon or
// opening a window. A cross-architecture build cannot safely execute the
// helper without a proven translation mechanism, but it must still validate
// every packaged executable and emit an explicit skip receipt.
function assertPackagedMacRuntime({
  appPath,
  targetArch = process.arch,
  hostArch = process.arch,
  log = console.log,
}) {
  const checkedPaths = [];
  for (const name of ["paseo", "paseo-daemon-launcher"]) {
    const binPath = path.join(appPath, "Contents", "Resources", "bin", name);
    fs.accessSync(binPath, fs.constants.X_OK);
    checkedPaths.push(binPath);
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
  checkedPaths.push(helperPath);

  if (targetArch !== hostArch && targetArch !== "universal") {
    const receipt = {
      checkedPaths,
      helperExecution: "skipped",
      hostArch,
      targetArch,
    };
    log(
      `[packaged-runtime-gate] files=ok helper=skipped target=${targetArch} host=${hostArch} reason=cross-architecture-build`,
    );
    return receipt;
  }

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
        "The bundle is not runnable; launchd daemon startup would fail identically.",
        `stdout: ${result.stdout.trim()}`,
        `stderr: ${result.stderr.trim()}`,
      ].join("\n"),
    );
  }

  const receipt = {
    checkedPaths,
    helperExecution: "executed",
    hostArch,
    targetArch,
  };
  log(`[packaged-runtime-gate] files=ok helper=executed target=${targetArch} host=${hostArch}`);
  return receipt;
}

module.exports = {
  RUNTIME_MARKER,
  assertPackagedMacRuntime,
  resolveElectronBuilderTargetArch,
  shouldRunPackagedRuntimeGate,
};
