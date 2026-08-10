import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(packageRoot, "..", "..");
const require = createRequire(import.meta.url);
const { createPackage } = require("@electron/asar");
const {
  assertExactSourceReceipts,
  formatBuildReceipt,
  invalidateBuildReceipts,
  receiptPath,
  writeBuildReceipts,
} = require("../../../../scripts/build-receipt.cjs");
const {
  ASAR_RECEIPT_ENTRIES,
  assertPackagedArchiveExactSource,
  readInstalledBuildProvenance,
} = require("../../scripts/build-provenance-gate.js");

const suiteRoot = mkdtempSync(join(tmpdir(), "paseo-build-provenance-test-"));
const emptyGitConfig = join(suiteRoot, "empty-gitconfig");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_SYSTEM = emptyGitConfig;

afterAll(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Paseo Test",
      "-c",
      "user.email=test@paseo.sh",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function createWorkspaceRepo(): string {
  const root = mkdtempSync(join(suiteRoot, "workspace-"));
  mkdirSync(join(root, "packages", "desktop"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n");
  writeFileSync(
    join(root, "packages", "desktop", "package.json"),
    `${JSON.stringify({ name: "@getpaseo/desktop", version: "0.3.1", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(root, "source.txt"), "generation 1\n");
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  mkdirSync(join(root, "packages", "server", "dist"), { recursive: true });
  mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
  return root;
}

async function packWorkspaceArchive(
  root: string,
  options: { omit?: string; tamper?: boolean } = {},
): Promise<string> {
  const appDir = mkdtempSync(join(suiteRoot, "app-"));
  for (const packageName of ["server", "cli"]) {
    if (packageName === options.omit) continue;
    const packagedDist = join(appDir, "node_modules", "@getpaseo", packageName, "dist");
    mkdirSync(packagedDist, { recursive: true });
    cpSync(receiptPath(root, packageName), join(packagedDist, "build-receipt.json"));
  }
  if (options.tamper) {
    writeFileSync(
      join(appDir, ASAR_RECEIPT_ENTRIES.server),
      formatBuildReceipt({ commit: "0".repeat(40), dirtyPaths: [] }),
    );
  }
  const archivePath = join(mkdtempSync(join(suiteRoot, "asar-")), "app.asar");
  await createPackage(appDir, archivePath);
  return archivePath;
}

describe("exact-source build receipts", () => {
  it("rejects stale dist built from a superseded commit", () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    writeFileSync(join(root, "source.txt"), "generation 2\n");
    git(root, "commit", "-q", "-am", "supersede");

    expect(() => assertExactSourceReceipts(root)).toThrow(/stale dist/);
  });

  it("rejects dirty trees and missing receipts", () => {
    const root = createWorkspaceRepo();
    expect(() => assertExactSourceReceipts(root)).toThrow(/no build-receipt\.json/);

    writeBuildReceipts(root, () => {});
    writeFileSync(join(root, "source.txt"), "uncommitted\n");
    expect(() => assertExactSourceReceipts(root)).toThrow(/uncommitted changes.*source\.txt/);

    git(root, "checkout", "-q", "--", "source.txt");
    invalidateBuildReceipts(root);
    expect(() => assertExactSourceReceipts(root)).toThrow(/no build-receipt\.json/);
  });

  it("accepts only the release workflow version stamp as a dirty path", () => {
    const root = createWorkspaceRepo();
    const packageJsonPath = join(root, "packages", "desktop", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageJson.version = "0.3.1-runtime.1";
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

    const state = writeBuildReceipts(root, () => {});
    expect(state.dirtyPaths).toEqual([]);
    expect(assertExactSourceReceipts(root).commit).toBe(state.commit);

    packageJson.name = "@getpaseo/not-desktop";
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    expect(() => assertExactSourceReceipts(root)).toThrow(/packages\/desktop\/package\.json/);
  });
});

describe("packaged archive provenance", () => {
  it("accepts the current server and CLI paths in a correct archive", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    const archivePath = await packWorkspaceArchive(root);

    expect(ASAR_RECEIPT_ENTRIES).toEqual({
      server: "node_modules/@getpaseo/server/dist/build-receipt.json",
      cli: "node_modules/@getpaseo/cli/dist/build-receipt.json",
    });
    expect(
      assertPackagedArchiveExactSource({ archivePath, workspaceRoot: root, log: () => {} }).commit,
    ).toBe(git(root, "rev-parse", "HEAD").trim());
  });

  it("rejects mismatched and missing archive receipts", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    const mismatched = await packWorkspaceArchive(root, { tamper: true });
    const missing = await packWorkspaceArchive(root, { omit: "cli" });

    expect(() =>
      assertPackagedArchiveExactSource({
        archivePath: mismatched,
        workspaceRoot: root,
        log: () => {},
      }),
    ).toThrow(/stale @getpaseo\/server bytes/);
    expect(() =>
      assertPackagedArchiveExactSource({
        archivePath: missing,
        workspaceRoot: root,
        log: () => {},
      }),
    ).toThrow(/lacks the exact-source build receipt/);
  });
});

describe("installed readback", () => {
  it("proves the same exact commit from app bundles and install directories", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    const head = git(root, "rev-parse", "HEAD").trim();
    const archivePath = await packWorkspaceArchive(root);
    const macBundle = join(mkdtempSync(join(suiteRoot, "installed-mac-")), "Paseo.app");
    const linuxInstall = mkdtempSync(join(suiteRoot, "installed-linux-"));
    mkdirSync(join(macBundle, "Contents", "Resources"), { recursive: true });
    mkdirSync(join(linuxInstall, "resources"), { recursive: true });
    cpSync(archivePath, join(macBundle, "Contents", "Resources", "app.asar"));
    cpSync(archivePath, join(linuxInstall, "resources", "app.asar"));

    for (const installedPath of [macBundle, linuxInstall, archivePath]) {
      expect(readInstalledBuildProvenance({ installedPath, expectCommit: head }).commit).toBe(head);
    }
    expect(() =>
      readInstalledBuildProvenance({ installedPath: macBundle, expectCommit: "0".repeat(40) }),
    ).toThrow(/Do not activate/);

    const command = spawnSync(
      "node",
      [
        join(packageRoot, "scripts", "build-provenance-gate.js"),
        "read",
        macBundle,
        "--expect-commit",
        head,
      ],
      { encoding: "utf8" },
    );
    expect(command.status).toBe(0);
    expect(JSON.parse(command.stdout).commit).toBe(head);
  });
});

describe("canonical path wiring", () => {
  it("clean-builds server and CLI before the wrapper checks the archive", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const desktopPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(rootPackage.scripts["build:server:clean"]).toContain(
      "node scripts/build-receipt.cjs write",
    );
    expect(rootPackage.scripts["build:server"]).toContain(
      "node scripts/build-receipt.cjs invalidate",
    );
    expect(desktopPackage.scripts.build).toContain("build:server:clean");
    expect(desktopPackage.scripts.build).toContain("run-electron-builder.js");
    expect(desktopPackage.dependencies).toMatchObject({
      "@getpaseo/server": "*",
      "@getpaseo/cli": "*",
    });

    const builderConfig = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
    expect(builderConfig).toContain("afterPack: ./scripts/after-pack.js");
    expect(builderConfig).toContain("afterSign: ./scripts/after-sign.js");
    expect(readFileSync(join(packageRoot, "scripts", "after-pack.js"), "utf8")).toContain(
      "assertPackagedArchiveExactSource",
    );
    expect(readFileSync(join(packageRoot, "scripts", "after-sign.js"), "utf8")).toContain(
      "assertPackagedArchiveExactSource",
    );
  });
});
