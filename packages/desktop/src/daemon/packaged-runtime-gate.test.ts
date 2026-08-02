import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  assertPackagedMacRuntime,
  assertUnsignedMacSigningConfiguration,
  RUNTIME_MARKER,
  resolveElectronBuilderTargetArch,
  resolveValidatedMacBuildMode,
  shouldRunPackagedRuntimeGate,
} = require("../../scripts/packaged-runtime-gate.js");
const {
  INTERNAL_MAC_BUILD_MODE_ENV,
  MAC_BUILD_MODE,
  resolveBuilderPlan,
  resolveExtraBuilderArgs,
  SIGNED_MAC_BUILD_FAILURE_HINT,
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
  it("forces signing for default and x64 mac builds while preserving identity inputs", () => {
    for (const env of [
      {},
      { CSC_LINK: "identity.p12" },
      { CSC_IDENTITY_AUTO_DISCOVERY: "false", CSC_NAME: "Developer ID" },
      { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    ]) {
      const plan = resolveBuilderPlan(env, ["--mac", "--x64"], "linux");
      expect(plan.extraArgs).toEqual(["-c.mac.forceCodeSigning=true"]);
      expect(plan.macBuildMode).toBe(MAC_BUILD_MODE.SIGNED);
      expect(plan.childEnv[INTERNAL_MAC_BUILD_MODE_ENV]).toBe(MAC_BUILD_MODE.SIGNED);
    }
    expect(resolveExtraBuilderArgs({}, ["--linux"], "darwin")).toEqual([]);
    expect(resolveExtraBuilderArgs({}, ["-wl"], "darwin")).toEqual([]);
    expect(SIGNED_MAC_BUILD_FAILURE_HINT).toContain(`${UNSIGNED_MAC_BUILD_ENV}=1`);
  });

  it("creates a private validated hook mode for the explicit unsigned opt-in", () => {
    const plan = resolveBuilderPlan(
      { [UNSIGNED_MAC_BUILD_ENV]: "1" },
      ["--mac", "--arm64"],
      "linux",
    );
    expect(plan.extraArgs).toEqual([
      "-c.mac.forceCodeSigning=false",
      "-c.mac.hardenedRuntime=false",
      "-c.mac.notarize=false",
    ]);
    expect(plan.macBuildMode).toBe(MAC_BUILD_MODE.UNSIGNED);
    expect(plan.childEnv.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
    expect(plan.childEnv[UNSIGNED_MAC_BUILD_ENV]).toBeUndefined();
    expect(plan.childEnv[INTERNAL_MAC_BUILD_MODE_ENV]).toBe(MAC_BUILD_MODE.UNSIGNED);
  });

  it("fails closed when unsigned intent conflicts with any declared signing path", () => {
    expect(() =>
      resolveBuilderPlan(
        { [UNSIGNED_MAC_BUILD_ENV]: "1", CSC_LINK: "identity.p12" },
        ["--mac"],
        "linux",
      ),
    ).toThrow(/CSC_LINK/);
    expect(() =>
      resolveBuilderPlan(
        { [UNSIGNED_MAC_BUILD_ENV]: "1", CSC_NAME: "Developer ID" },
        ["--mac"],
        "linux",
      ),
    ).toThrow(/CSC_NAME/);
    expect(() =>
      resolveBuilderPlan(
        {
          [UNSIGNED_MAC_BUILD_ENV]: "1",
          CSC_IDENTITY_AUTO_DISCOVERY: "true",
        },
        ["--mac"],
        "linux",
      ),
    ).toThrow(/CSC_IDENTITY_AUTO_DISCOVERY/);
    for (const argument of [
      "--config.mac.identity=Developer ID Application",
      "-c.mac.sign=./custom-sign.js",
      "-c.mac.cscLink=identity.p12",
      "-c.forceCodeSigning=true",
    ]) {
      expect(() =>
        resolveBuilderPlan({ [UNSIGNED_MAC_BUILD_ENV]: "1" }, ["--mac", argument], "linux"),
      ).toThrow(/mac signing build argument/);
    }
    expect(() =>
      resolveBuilderPlan(
        { [UNSIGNED_MAC_BUILD_ENV]: "1" },
        ["--mac", "--config", "alternate.yml"],
        "linux",
      ),
    ).toThrow(/Alternate Electron Builder --config/);
    for (const arguments_ of [
      ["--mac=mas"],
      ["--macos=mas"],
      ["-m=mas"],
      ["-o=mas"],
      ["--mac", "zip", "mas"],
      ["--macos", "zip", "mas-dev"],
      ["-m", "zip", "mas:arm64"],
      ["-o", "mas-dev:arm64", "zip"],
      ["--mac=zip", "--mac=mas"],
      ["--macos=zip", "-o=mas-dev"],
    ]) {
      expect(() =>
        resolveBuilderPlan({ [UNSIGNED_MAC_BUILD_ENV]: "1" }, arguments_, "linux"),
      ).toThrow(/Mac App Store target/);
    }

    const unsignedZip = resolveBuilderPlan(
      { [UNSIGNED_MAC_BUILD_ENV]: "1" },
      ["--macos=zip"],
      "linux",
    );
    expect(unsignedZip.macBuildMode).toBe(MAC_BUILD_MODE.UNSIGNED);
  });

  it("rejects resolved custom signing configuration in validated unsigned mode", () => {
    expect(() =>
      assertUnsignedMacSigningConfiguration({ commonConfig: {}, macConfig: {} }),
    ).not.toThrow();
    expect(() =>
      assertUnsignedMacSigningConfiguration({ commonConfig: {}, macConfig: { identity: null } }),
    ).not.toThrow();
    expect(() =>
      assertUnsignedMacSigningConfiguration({
        commonConfig: { cscLink: "identity.p12" },
        macConfig: {},
      }),
    ).toThrow(/cscLink/);
    expect(() =>
      assertUnsignedMacSigningConfiguration({
        commonConfig: {},
        macConfig: { sign: "./custom-sign.js" },
      }),
    ).toThrow(/mac\.sign/);
    expect(() =>
      assertUnsignedMacSigningConfiguration({ commonConfig: {}, macConfig: { identity: "-" } }),
    ).toThrow(/mac\.identity/);
  });

  it("uses only the private wrapper marker to route signed and unsigned hooks", () => {
    const signedEnv = { [INTERNAL_MAC_BUILD_MODE_ENV]: MAC_BUILD_MODE.SIGNED };
    expect(shouldRunPackagedRuntimeGate({ env: signedEnv, phase: "afterPack" })).toBe(false);
    expect(shouldRunPackagedRuntimeGate({ env: signedEnv, phase: "afterSign" })).toBe(true);

    const unsignedEnv = { [INTERNAL_MAC_BUILD_MODE_ENV]: MAC_BUILD_MODE.UNSIGNED };
    expect(shouldRunPackagedRuntimeGate({ env: unsignedEnv, phase: "afterPack" })).toBe(true);
    expect(shouldRunPackagedRuntimeGate({ env: unsignedEnv, phase: "afterSign" })).toBe(false);
    expect(resolveValidatedMacBuildMode(unsignedEnv)).toBe(MAC_BUILD_MODE.UNSIGNED);
  });

  it("rejects direct Electron Builder hooks without wrapper validation", () => {
    expect(() => resolveValidatedMacBuildMode({})).toThrow(/must run through/);
    expect(() => resolveValidatedMacBuildMode({ [UNSIGNED_MAC_BUILD_ENV]: "1" })).toThrow(
      /without wrapper validation/,
    );
    expect(() =>
      resolveValidatedMacBuildMode({
        [INTERNAL_MAC_BUILD_MODE_ENV]: MAC_BUILD_MODE.UNSIGNED,
        [UNSIGNED_MAC_BUILD_ENV]: "1",
      }),
    ).toThrow(/must be consumed/);
  });
});
