const path = require("node:path");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");
const { assertPackagedArchiveExactSource } = require("./build-provenance-gate.js");

const EXECUTABLE_NAME = "Paseo";

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(context.appOutDir, `${EXECUTABLE_NAME}.app`);
  assertPackagedArchiveExactSource({
    archivePath: path.join(appPath, "Contents", "Resources", "app.asar"),
    workspaceRoot: path.resolve(__dirname, "..", "..", ".."),
  });

  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  await smokePackagedDesktopApp({
    appPath,
  });
};
