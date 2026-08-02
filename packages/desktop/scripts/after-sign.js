const path = require("node:path");

const { assertPackagedMacRuntime } = require("./packaged-runtime-gate.js");
const { smokePackagedDesktopApp } = require("./smoke-packaged-desktop-app.js");

const EXECUTABLE_NAME = "Paseo";

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(context.appOutDir, `${EXECUTABLE_NAME}.app`);

  assertPackagedMacRuntime({ appPath });

  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  await smokePackagedDesktopApp({ appPath });
};
