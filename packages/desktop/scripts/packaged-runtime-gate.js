const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  INTERNAL_MAC_BUILD_MODE_ENV,
  MAC_BUILD_MODE,
  UNSIGNED_MAC_BUILD_ENV,
} = require("./run-electron-builder.js");

const RUNTIME_MARKER = "paseo-packaged-runtime-ok";
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function resolveElectronBuilderTargetArch(arch, hostArch = process.arch) {
  if (arch === undefined || arch === null) return hostArch;
  return ARCH_MAP[arch] || String(arch);
}

function resolveValidatedMacBuildMode(env) {
  const publicOptInPresent = env[UNSIGNED_MAC_BUILD_ENV] !== undefined;
  const mode = env[INTERNAL_MAC_BUILD_MODE_ENV];
  if (publicOptInPresent && mode === undefined) {
    throw new Error(
      `${UNSIGNED_MAC_BUILD_ENV} reached an Electron Builder hook without wrapper validation. Run the repository's desktop build command instead of electron-builder directly.`,
    );
  }
  if (mode !== MAC_BUILD_MODE.SIGNED && mode !== MAC_BUILD_MODE.UNSIGNED) {
    throw new Error(
      "macOS desktop builds must run through the Paseo desktop build wrapper so signing policy and runtime gates cannot be bypassed.",
    );
  }
  if (publicOptInPresent) {
    throw new Error(
      `${UNSIGNED_MAC_BUILD_ENV} must be consumed by the build wrapper before hooks run.`,
    );
  }
  return mode;
}

function shouldRunPackagedRuntimeGate({ env, phase }) {
  const mode = resolveValidatedMacBuildMode(env);
  return mode === MAC_BUILD_MODE.UNSIGNED ? phase === "afterPack" : phase === "afterSign";
}

function assertUnsignedMacSigningConfiguration({ commonConfig, macConfig }) {
  const conflicts = [];
  if (commonConfig?.cscLink) conflicts.push("cscLink");
  if (macConfig?.cscLink) conflicts.push("mac.cscLink");
  if (macConfig?.identity !== undefined && macConfig.identity !== null) {
    conflicts.push("mac.identity");
  }
  if (macConfig?.sign !== undefined && macConfig.sign !== null) conflicts.push("mac.sign");
  if (conflicts.length > 0) {
    throw new Error(
      `Validated unsigned mac build conflicts with resolved signing configuration: ${conflicts.join(
        ", ",
      )}. Remove the signing configuration or build in signed mode.`,
    );
  }
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
  assertUnsignedMacSigningConfiguration,
  resolveElectronBuilderTargetArch,
  resolveValidatedMacBuildMode,
  shouldRunPackagedRuntimeGate,
};
