const { spawnSync } = require("node:child_process");

// macOS hardened runtime enforces dyld library validation, which requires the
// helper process and every mapped non-platform framework to share a real Team
// ID. An explicitly unsigned build (CSC_IDENTITY_AUTO_DISCOVERY=false with no
// identity provided) falls back to ad-hoc signatures that carry no Team ID, so
// a hardened-runtime ad-hoc bundle passes `codesign --verify --deep --strict`
// yet aborts in dyld the moment launchd or the CLI shim executes Paseo Helper.
// Hardened runtime only means something alongside a real signing identity, so
// drop it for the unsigned mode and keep the signed path byte-identical.
function resolveExtraBuilderArgs(env) {
  const explicitlyUnsigned =
    env.CSC_IDENTITY_AUTO_DISCOVERY === "false" && !env.CSC_LINK && !env.CSC_NAME;
  if (!explicitlyUnsigned) {
    return [];
  }
  return ["-c.mac.hardenedRuntime=false", "-c.mac.notarize=false"];
}

function main() {
  const extraArgs = resolveExtraBuilderArgs(process.env);
  if (extraArgs.length > 0) {
    console.error(
      `[run-electron-builder] unsigned build: applying ${extraArgs.join(" ")} so the ad-hoc bundle stays launchable`,
    );
  }

  const result = spawnSync(
    "electron-builder",
    ["--config", "electron-builder.yml", ...process.argv.slice(2), ...extraArgs],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main();
}

module.exports = { resolveExtraBuilderArgs };
