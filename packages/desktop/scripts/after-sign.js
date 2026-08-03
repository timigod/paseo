const path = require("node:path");

const {
  assertPackagedMacRuntime,
  resolveElectronBuilderTargetArch,
  shouldRunPackagedRuntimeGate,
} = require("./packaged-runtime-gate.js");
const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");
const { assertPackagedArchiveExactSource } = require("./build-provenance-gate.js");

const EXECUTABLE_NAME = "Paseo";

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") {
    return;
  }

  const appPath = path.join(context.appOutDir, `${EXECUTABLE_NAME}.app`);
  if (!shouldRunPackagedRuntimeGate({ env: process.env, phase: "afterSign" })) {
    return;
  }

  const receipt = assertPackagedMacRuntime({
    appPath,
    targetArch: resolveElectronBuilderTargetArch(context.arch),
  });

  // Re-verify the receipts inside the sealed bundle so the app.asar the
  // signature covers is provably the clean HEAD build, not a substitute.
  assertPackagedArchiveExactSource({
    archivePath: path.join(appPath, "Contents", "Resources", "app.asar"),
    workspaceRoot: path.resolve(__dirname, "..", "..", ".."),
  });

  if (process.env.PASEO_DESKTOP_SMOKE !== "1" || receipt.helperExecution === "skipped") {
    return;
  }

  await smokePackagedDesktopApp({ appPath });
};
