import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  assertPackagedMacRuntime,
  RUNTIME_MARKER,
  resolveElectronBuilderTargetArch,
  shouldRunPackagedRuntimeGate,
} = require("../../scripts/packaged-runtime-gate.js");
const {
  resolveBuilderPlan,
  resolveExtraBuilderArgs,
  UNSIGNED_MAC_BUILD_ENV,
} = require("../../scripts/run-electron-builder.js");

function writeExecutable(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeMacBundle(options: { helperScript: string }): string {
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

    const appPath = createFakeMacBundle({
      // Emulate Electron honoring `-e <script>` under ELECTRON_RUN_AS_NODE.
      helperScript: `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = "1" ] || exit 70\n[ "$1" = "-e" ] || exit 71\nprintf '%s\\n' "${RUNTIME_MARKER}"\n`,
    });
    try {
      const receipts: string[] = [];
      const receipt = assertPackagedMacRuntime({
        appPath,
        hostArch: "arm64",
        log: (message: string) => receipts.push(message),
        targetArch: "arm64",
      });
      expect(receipt.helperExecution).toBe("executed");
      expect(receipts).toEqual([
        "[packaged-runtime-gate] files=ok helper=executed target=arm64 host=arm64",
      ]);
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

    const appPath = createFakeMacBundle({
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

    const appPath = createFakeMacBundle({
      helperScript: `#!/bin/sh\nprintf '%s\\n' "${RUNTIME_MARKER}"\n`,
    });
    rmSync(join(appPath, "Contents", "Resources", "bin", "paseo-daemon-launcher"));
    try {
      expect(() => assertPackagedMacRuntime({ appPath })).toThrow();
    } finally {
      rmSync(dirname(appPath), { recursive: true, force: true });
    }
  });

  it("checks packaged files but skips helper execution for a cross-architecture build", () => {
    if (process.platform === "win32") return;

    const appPath = createFakeMacBundle({ helperScript: "#!/bin/sh\nexit 99\n" });
    const receipts: string[] = [];
    try {
      const receipt = assertPackagedMacRuntime({
        appPath,
        hostArch: "arm64",
        log: (message: string) => receipts.push(message),
        targetArch: "x64",
      });
      expect(receipt.helperExecution).toBe("skipped");
      expect(receipt.checkedPaths).toHaveLength(3);
      expect(receipts).toEqual([
        "[packaged-runtime-gate] files=ok helper=skipped target=x64 host=arm64 reason=cross-architecture-build",
      ]);
    } finally {
      rmSync(dirname(appPath), { recursive: true, force: true });
    }
  });

  it("still fails a cross-architecture build when a packaged executable is missing", () => {
    if (process.platform === "win32") return;

    const appPath = createFakeMacBundle({ helperScript: "#!/bin/sh\nexit 99\n" });
    rmSync(join(appPath, "Contents", "Resources", "bin", "paseo"));
    try {
      expect(() =>
        assertPackagedMacRuntime({ appPath, hostArch: "arm64", targetArch: "x64" }),
      ).toThrow();
    } finally {
      rmSync(dirname(appPath), { recursive: true, force: true });
    }
  });

  it("resolves Electron Builder target architecture without assuming the host", () => {
    expect(resolveElectronBuilderTargetArch(1, "arm64")).toBe("x64");
    expect(resolveElectronBuilderTargetArch(3, "x64")).toBe("arm64");
    expect(resolveElectronBuilderTargetArch(4, "arm64")).toBe("universal");
    expect(resolveElectronBuilderTargetArch(undefined, "arm64")).toBe("arm64");
  });
});

describe("explicit unsigned mac build contract", () => {
  it("never weakens signed or partially configured CSC builds without the opt-in", () => {
    expect(resolveExtraBuilderArgs({})).toEqual([]);
    expect(resolveExtraBuilderArgs({ CSC_LINK: "identity.p12" })).toEqual([]);
    expect(
      resolveExtraBuilderArgs({ CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_NAME: "Developer ID" }),
    ).toEqual([]);
    expect(resolveExtraBuilderArgs({ CSC_IDENTITY_AUTO_DISCOVERY: "false" })).toEqual([]);
    expect(resolveExtraBuilderArgs({}, ["-c.mac.identity=Developer ID Application"])).toEqual([]);
  });

  it("drops hardened runtime and disables discovery only for the explicit opt-in", () => {
    const plan = resolveBuilderPlan({ [UNSIGNED_MAC_BUILD_ENV]: "1" });
    expect(plan.extraArgs).toEqual(["-c.mac.hardenedRuntime=false", "-c.mac.notarize=false"]);
    expect(plan.childEnv.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
  });

  it("fails closed when unsigned intent conflicts with a signing path", () => {
    expect(() =>
      resolveBuilderPlan({ [UNSIGNED_MAC_BUILD_ENV]: "1", CSC_LINK: "identity.p12" }),
    ).toThrow(/CSC_LINK/);
    expect(() =>
      resolveBuilderPlan({ [UNSIGNED_MAC_BUILD_ENV]: "1", CSC_NAME: "Developer ID" }),
    ).toThrow(/CSC_NAME/);
    expect(() =>
      resolveBuilderPlan({
        [UNSIGNED_MAC_BUILD_ENV]: "1",
        CSC_IDENTITY_AUTO_DISCOVERY: "true",
      }),
    ).toThrow(/CSC_IDENTITY_AUTO_DISCOVERY/);
    expect(() =>
      resolveBuilderPlan({ [UNSIGNED_MAC_BUILD_ENV]: "1" }, [
        "--config.mac.identity=Developer ID Application",
      ]),
    ).toThrow(/mac\.identity/);
  });

  it("runs the gate once after signing normally and once after packing when unsigned", () => {
    expect(shouldRunPackagedRuntimeGate({ env: {}, phase: "afterPack" })).toBe(false);
    expect(shouldRunPackagedRuntimeGate({ env: {}, phase: "afterSign" })).toBe(true);
    expect(
      shouldRunPackagedRuntimeGate({ env: { CSC_LINK: "identity.p12" }, phase: "afterSign" }),
    ).toBe(true);

    const unsignedEnv = { [UNSIGNED_MAC_BUILD_ENV]: "1" };
    expect(shouldRunPackagedRuntimeGate({ env: unsignedEnv, phase: "afterPack" })).toBe(true);
    expect(shouldRunPackagedRuntimeGate({ env: unsignedEnv, phase: "afterSign" })).toBe(false);
  });
});
