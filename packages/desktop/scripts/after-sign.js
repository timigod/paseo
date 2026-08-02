const path = require("node:path");

const {
  assertPackagedMacRuntime,
  resolveElectronBuilderTargetArch,
  shouldRunPackagedRuntimeGate,
} = require("./packaged-runtime-gate.js");
const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");

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

  if (process.env.PASEO_DESKTOP_SMOKE !== "1" || receipt.helperExecution === "skipped") {
    return;
  }

  await smokePackagedDesktopApp({ appPath });
};
