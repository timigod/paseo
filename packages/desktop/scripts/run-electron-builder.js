const { spawnSync } = require("node:child_process");

const UNSIGNED_MAC_BUILD_ENV = "PASEO_DESKTOP_UNSIGNED_MAC";

// macOS hardened runtime enforces dyld library validation, which requires the
// helper process and every mapped non-platform framework to share a real Team
// ID. A truly unsigned build falls back to ad-hoc signatures that carry no Team
// ID, so hardened-runtime ad-hoc bundles can pass static codesign verification
// and still abort in dyld. Do not infer unsigned intent from an incomplete CSC
// environment: it must be an explicit Paseo build mode.
function isUnsignedMacBuildRequested(env) {
  return env[UNSIGNED_MAC_BUILD_ENV] === "1";
}

function isMacIdentityArgument(argument) {
  return /^(?:-c|--config)\.mac\.identity(?:=|$)/.test(argument);
}

function resolveBuilderPlan(env, builderArgs = []) {
  if (!isUnsignedMacBuildRequested(env)) {
    return { childEnv: env, extraArgs: [] };
  }

  const conflicts = [];
  if (env.CSC_LINK) conflicts.push("CSC_LINK");
  if (env.CSC_NAME) conflicts.push("CSC_NAME");
  if (env.CSC_IDENTITY_AUTO_DISCOVERY && env.CSC_IDENTITY_AUTO_DISCOVERY !== "false") {
    conflicts.push("CSC_IDENTITY_AUTO_DISCOVERY");
  }
  if (builderArgs.some(isMacIdentityArgument)) {
    conflicts.push("mac.identity build argument");
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${UNSIGNED_MAC_BUILD_ENV}=1 conflicts with signed macOS configuration: ${conflicts.join(
        ", ",
      )}. Remove the unsigned opt-in or the signing configuration.`,
    );
  }

  return {
    childEnv: { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    extraArgs: ["-c.mac.hardenedRuntime=false", "-c.mac.notarize=false"],
  };
}

function resolveExtraBuilderArgs(env, builderArgs = []) {
  return resolveBuilderPlan(env, builderArgs).extraArgs;
}

function main() {
  const builderArgs = process.argv.slice(2);
  const { childEnv, extraArgs } = resolveBuilderPlan(process.env, builderArgs);
  if (extraArgs.length > 0) {
    console.error(
      `[run-electron-builder] explicit unsigned mac build: applying ${extraArgs.join(" ")} and disabling signing identity auto-discovery`,
    );
  }

  const result = spawnSync(
    "electron-builder",
    ["--config", "electron-builder.yml", ...builderArgs, ...extraArgs],
    { env: childEnv, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  isUnsignedMacBuildRequested,
  resolveBuilderPlan,
  resolveExtraBuilderArgs,
  UNSIGNED_MAC_BUILD_ENV,
};
