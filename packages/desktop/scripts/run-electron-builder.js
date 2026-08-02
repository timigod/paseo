const { spawnSync } = require("node:child_process");

const UNSIGNED_MAC_BUILD_ENV = "PASEO_DESKTOP_UNSIGNED_MAC";
const INTERNAL_MAC_BUILD_MODE_ENV = "PASEO_INTERNAL_MAC_BUILD_MODE";
const MAC_BUILD_MODE = { SIGNED: "signed", UNSIGNED: "unsigned" };
const SIGNED_MAC_BUILD_FAILURE_HINT = `[run-electron-builder] signed mac builds require a valid signing identity. If this artifact is intentionally unsigned, rerun with ${UNSIGNED_MAC_BUILD_ENV}=1.`;

// macOS hardened runtime enforces dyld library validation, which requires the
// helper process and every mapped non-platform framework to share a real Team
// ID. A truly unsigned build falls back to ad-hoc signatures that carry no Team
// ID, so hardened-runtime ad-hoc bundles can pass static codesign verification
// and still abort in dyld. Do not infer unsigned intent from an incomplete CSC
// environment: it must be an explicit Paseo build mode.
function isUnsignedMacBuildRequested(env) {
  return env[UNSIGNED_MAC_BUILD_ENV] === "1";
}

function isMacSigningArgument(argument) {
  return /^(?:-c|--config)\.(?:forceCodeSigning|mac\.(?:cscLink|forceCodeSigning|identity|sign))(?:=|$)/.test(
    argument,
  );
}

const MAC_TARGET_ALIASES = ["--mac", "--macos", "-m", "-o"];

function parseMacTargetSelection(builderArgs) {
  const targets = [];
  let selected = false;

  for (let index = 0; index < builderArgs.length; index += 1) {
    const argument = builderArgs[index];
    const inlineAlias = MAC_TARGET_ALIASES.find((alias) => argument.startsWith(`${alias}=`));
    if (inlineAlias) {
      selected = true;
      const target = argument.slice(inlineAlias.length + 1);
      if (target) targets.push(target);
      continue;
    }

    if (MAC_TARGET_ALIASES.includes(argument)) {
      selected = true;
      while (index + 1 < builderArgs.length && !builderArgs[index + 1].startsWith("-")) {
        targets.push(builderArgs[index + 1]);
        index += 1;
      }
      continue;
    }

    if (/^-[mowl]{2,}$/.test(argument) && (argument.includes("m") || argument.includes("o"))) {
      selected = true;
    }
  }

  return { selected, targets };
}

function targetsMac(builderArgs, hostPlatform) {
  if (parseMacTargetSelection(builderArgs).selected) return true;
  if (
    builderArgs.some(
      (argument) =>
        /^(?:--linux|-l|--win|--windows|-w)(?:=|$)/.test(argument) ||
        (/^-[mowl]{2,}$/.test(argument) && (argument.includes("w") || argument.includes("l"))),
    )
  ) {
    return false;
  }
  return hostPlatform === "darwin";
}

function hasAlternateConfigArgument(builderArgs) {
  return builderArgs.some(
    (argument) =>
      argument === "--config" ||
      argument === "-c" ||
      argument.startsWith("--config=") ||
      argument.startsWith("-c="),
  );
}

function targetsMacAppStore(builderArgs) {
  const targetIsMas = (target) =>
    ["mas", "mas-dev"].includes(target.split(":", 1)[0].toLowerCase());
  return (
    parseMacTargetSelection(builderArgs).targets.some(targetIsMas) ||
    builderArgs.some((argument) =>
      /^(?:-c|--config)\.mac\.target=.*\bmas(?:-dev)?\b/.test(argument),
    )
  );
}

function resolveBuilderPlan(env, builderArgs = [], hostPlatform = process.platform) {
  if (env[INTERNAL_MAC_BUILD_MODE_ENV]) {
    throw new Error(`${INTERNAL_MAC_BUILD_MODE_ENV} is reserved for the Paseo build wrapper.`);
  }
  if (env[UNSIGNED_MAC_BUILD_ENV] !== undefined && env[UNSIGNED_MAC_BUILD_ENV] !== "1") {
    throw new Error(`${UNSIGNED_MAC_BUILD_ENV} must be exactly 1 when unsigned mode is intended.`);
  }

  const macBuild = targetsMac(builderArgs, hostPlatform);
  const unsigned = isUnsignedMacBuildRequested(env);
  if (unsigned && !macBuild) {
    throw new Error(`${UNSIGNED_MAC_BUILD_ENV}=1 is valid only for a macOS build target.`);
  }
  if (!macBuild) {
    return { childEnv: env, extraArgs: [], macBuildMode: null };
  }
  if (hasAlternateConfigArgument(builderArgs)) {
    throw new Error(
      "Alternate Electron Builder --config files are not supported by the Paseo macOS build wrapper because they can replace the mandatory signing and runtime hooks. Use the canonical config with property overrides instead.",
    );
  }
  if (!unsigned) {
    return {
      childEnv: { ...env, [INTERNAL_MAC_BUILD_MODE_ENV]: MAC_BUILD_MODE.SIGNED },
      extraArgs: ["-c.mac.forceCodeSigning=true"],
      macBuildMode: MAC_BUILD_MODE.SIGNED,
    };
  }

  const conflicts = [];
  if (targetsMacAppStore(builderArgs)) conflicts.push("Mac App Store target");
  if (env.CSC_LINK) conflicts.push("CSC_LINK");
  if (env.CSC_NAME) conflicts.push("CSC_NAME");
  if (env.CSC_IDENTITY_AUTO_DISCOVERY && env.CSC_IDENTITY_AUTO_DISCOVERY !== "false") {
    conflicts.push("CSC_IDENTITY_AUTO_DISCOVERY");
  }
  if (builderArgs.some(isMacSigningArgument)) {
    conflicts.push("mac signing build argument");
  }
  if (conflicts.length > 0) {
    throw new Error(
      `${UNSIGNED_MAC_BUILD_ENV}=1 conflicts with signed macOS configuration: ${conflicts.join(
        ", ",
      )}. Remove the unsigned opt-in or the signing configuration.`,
    );
  }

  const childEnv = {
    ...env,
    [INTERNAL_MAC_BUILD_MODE_ENV]: MAC_BUILD_MODE.UNSIGNED,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  };
  delete childEnv[UNSIGNED_MAC_BUILD_ENV];

  return {
    childEnv,
    extraArgs: [
      "-c.mac.forceCodeSigning=false",
      "-c.mac.hardenedRuntime=false",
      "-c.mac.notarize=false",
    ],
    macBuildMode: MAC_BUILD_MODE.UNSIGNED,
  };
}

function resolveExtraBuilderArgs(env, builderArgs = [], hostPlatform = process.platform) {
  return resolveBuilderPlan(env, builderArgs, hostPlatform).extraArgs;
}

function main() {
  const builderArgs = process.argv.slice(2);
  const { childEnv, extraArgs, macBuildMode } = resolveBuilderPlan(process.env, builderArgs);
  if (macBuildMode === MAC_BUILD_MODE.UNSIGNED) {
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
  if (result.status !== 0 && macBuildMode === MAC_BUILD_MODE.SIGNED) {
    console.error(SIGNED_MAC_BUILD_FAILURE_HINT);
  }
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  INTERNAL_MAC_BUILD_MODE_ENV,
  isUnsignedMacBuildRequested,
  MAC_BUILD_MODE,
  resolveBuilderPlan,
  resolveExtraBuilderArgs,
  SIGNED_MAC_BUILD_FAILURE_HINT,
  targetsMac,
  UNSIGNED_MAC_BUILD_ENV,
};
