import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  assertPackagedMacRuntime,
  RUNTIME_MARKER,
} = require("../../scripts/packaged-runtime-gate.js");
const { resolveExtraBuilderArgs } = require("../../scripts/run-electron-builder.js");

function writeExecutable(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeSignedBundle(options: { helperScript: string }): string {
  const root = mkdtempSync(join(tmpdir(), "paseo-runtime-gate-test-"));
  const appPath = join(root, "Paseo.app");

  writeExecutable(join(appPath, "Contents", "Resources", "bin", "paseo"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    join(appPath, "Contents", "Resources", "bin", "paseo-daemon-launcher"),
    "#!/bin/sh\nexit 0\n",
  );
  writeExecutable(
    join(
      appPath,
      "Contents",
      "Frameworks",
      "Paseo Helper.app",
      "Contents",
      "MacOS",
      "Paseo Helper",
    ),
    options.helperScript,
  );

  return appPath;
}

describe("packaged runtime gate", () => {
  it("passes when the packaged helper executes in ELECTRON_RUN_AS_NODE mode", () => {
    if (process.platform === "win32") return;

    const appPath = createFakeSignedBundle({
      // Emulate Electron honoring `-e <script>` under ELECTRON_RUN_AS_NODE.
      helperScript: `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] || exit 70\n[ "$1" = "-e" ] || exit 71\nprintf '%s\\n' "${RUNTIME_MARKER}"\n`,
    });
    try {
      expect(() => assertPackagedMacRuntime({ appPath })).not.toThrow();
    } finally {
      rmSync(dirname(appPath), { recursive: true, force: true });
    }
  });

  // A hardened-runtime ad-hoc bundle passes codesign verification but aborts in
  // dyld with "mapping process and mapped file (non-platform) have different
  // Team IDs" as soon as the helper starts. The gate must surface exactly that
  // launch failure instead of trusting signature checks.
  it("fails when the packaged helper aborts the way dyld library validation does", () => {
    if (process.platform === "win32") return;

    const appPath = createFakeSignedBundle({
      helperScript:
        "#!/bin/sh\necho 'dyld: mapping process and mapped file (non-platform) have different Team IDs' >&2\nexit 134\n",
    });
    try {
      expect(() => assertPackagedMacRuntime({ appPath })).toThrow(/ELECTRON_RUN_AS_NODE/);
    } finally {
      rmSync(dirname(appPath), { recursive: true, force: true });
    }
  });

  it("fails when the daemon launcher is missing from the bundle", () => {
    if (process.platform === "win32") return;

    const appPath = createFakeSignedBundle({
      helperScript: `#!/bin/sh\nprintf '%s\\n' "${RUNTIME_MARKER}"\n`,
    });
    rmSync(join(appPath, "Contents", "Resources", "bin", "paseo-daemon-launcher"));
    try {
      expect(() => assertPackagedMacRuntime({ appPath })).toThrow();
    } finally {
      rmSync(dirname(appPath), { recursive: true, force: true });
    }
  });
});

describe("unsigned build hardened-runtime override", () => {
  it("keeps signed builds byte-identical", () => {
    expect(resolveExtraBuilderArgs({})).toEqual([]);
    expect(resolveExtraBuilderArgs({ CSC_LINK: "identity.p12" })).toEqual([]);
    expect(
      resolveExtraBuilderArgs({ CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_NAME: "Developer ID" }),
    ).toEqual([]);
  });

  it("drops hardened runtime only for explicitly unsigned builds", () => {
    expect(resolveExtraBuilderArgs({ CSC_IDENTITY_AUTO_DISCOVERY: "false" })).toEqual([
      "-c.mac.hardenedRuntime=false",
      "-c.mac.notarize=false",
    ]);
  });
});
