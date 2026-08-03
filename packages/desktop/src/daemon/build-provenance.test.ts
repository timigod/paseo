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
  assertPackagedArchiveExactSource,
  readInstalledBuildProvenance,
} = require("../../scripts/build-provenance-gate.js");

const suiteRoot = mkdtempSync(join(tmpdir(), "paseo-build-provenance-test-"));
// The receipt module spawns git itself, so isolation from user/system git
// config has to come through the environment, not per-call flags.
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
    `${JSON.stringify({ name: "@getpaseo/desktop", version: "0.1.0", private: true }, null, 2)}\n`,
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
    writeFileSync(join(packagedDist, "index.js"), "module.exports = {};\n");
  }
  if (options.tamper) {
    const target = join(
      appDir,
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "build-receipt.json",
    );
    writeFileSync(target, formatBuildReceipt({ commit: "0".repeat(40), dirtyPaths: [] }));
  }
  const archivePath = join(mkdtempSync(join(suiteRoot, "asar-")), "app.asar");
  await createPackage(appDir, archivePath);
  return archivePath;
}

describe("exact-source build receipts", () => {
  it("stamps clean builds with the HEAD commit and passes the packaging gate", () => {
    const root = createWorkspaceRepo();
    const state = writeBuildReceipts(root, () => {});
    const head = git(root, "rev-parse", "HEAD").trim();

    expect(state.commit).toBe(head);
    expect(state.dirtyPaths).toEqual([]);
    for (const packageName of ["server", "cli"]) {
      expect(readFileSync(receiptPath(root, packageName), "utf8")).toBe(formatBuildReceipt(state));
    }

    const verified = assertExactSourceReceipts(root);
    expect(verified.commit).toBe(head);
  });

  it("rejects stale dist built from a superseded commit", () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    writeFileSync(join(root, "source.txt"), "generation 2\n");
    git(root, "commit", "-q", "-am", "supersede");

    expect(() => assertExactSourceReceipts(root)).toThrow(/stale dist/);
  });

  it("rejects packaging from a dirty tree even when receipts match HEAD", () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});

    writeFileSync(join(root, "source.txt"), "generation 2 uncommitted\n");
    expect(() => assertExactSourceReceipts(root)).toThrow(/uncommitted changes.*source\.txt/);

    git(root, "checkout", "-q", "--", "source.txt");
    writeFileSync(join(root, "untracked.txt"), "untracked\n");
    expect(() => assertExactSourceReceipts(root)).toThrow(/uncommitted changes.*untracked\.txt/);
  });

  // The desktop release workflow stamps the tag version into
  // packages/desktop/package.json before building; that must remain the only
  // tracked divergence an exact-source packaging run tolerates.
  it("accepts the release version stamp and nothing else in desktop package.json", () => {
    const root = createWorkspaceRepo();
    const desktopPackageJson = join(root, "packages", "desktop", "package.json");
    const stamped = JSON.parse(readFileSync(desktopPackageJson, "utf8"));
    stamped.version = "9.9.9";
    writeFileSync(desktopPackageJson, `${JSON.stringify(stamped, null, 2)}\n`);

    const state = writeBuildReceipts(root, () => {});
    expect(state.dirtyPaths).toEqual([]);
    expect(assertExactSourceReceipts(root).commit).toBe(state.commit);

    stamped.name = "@getpaseo/not-desktop";
    writeFileSync(desktopPackageJson, `${JSON.stringify(stamped, null, 2)}\n`);
    expect(() => assertExactSourceReceipts(root)).toThrow(/packages\/desktop\/package\.json/);
  });

  it("refuses dist that predates the receipt contract or lost its receipt", () => {
    const root = createWorkspaceRepo();
    expect(() => assertExactSourceReceipts(root)).toThrow(/no build-receipt\.json/);

    writeBuildReceipts(root, () => {});
    invalidateBuildReceipts(root);
    expect(() => assertExactSourceReceipts(root)).toThrow(/no build-receipt\.json/);
  });

  it("writes and asserts receipts through the command line used by npm scripts", () => {
    const root = createWorkspaceRepo();
    const cli = join(repoRoot, "scripts", "build-receipt.cjs");

    const write = spawnSync("node", [cli, "write", root], { encoding: "utf8" });
    expect(write.status).toBe(0);

    const ok = spawnSync("node", [cli, "assert", root], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("exact-source=ok");

    writeFileSync(join(root, "source.txt"), "generation 2\n");
    git(root, "commit", "-q", "-am", "supersede");
    const stale = spawnSync("node", [cli, "assert", root], { encoding: "utf8" });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("stale dist");
  });
});

describe("packaged archive provenance", () => {
  it("accepts an archive embedding the exact clean-build receipts", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    const archivePath = await packWorkspaceArchive(root);

    const result = assertPackagedArchiveExactSource({
      archivePath,
      workspaceRoot: root,
      log: () => {},
    });
    expect(result.commit).toBe(git(root, "rev-parse", "HEAD").trim());
  });

  it("rejects an archive whose receipt bytes disagree with the clean build", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    const archivePath = await packWorkspaceArchive(root, { tamper: true });

    expect(() =>
      assertPackagedArchiveExactSource({ archivePath, workspaceRoot: root, log: () => {} }),
    ).toThrow(/stale @getpaseo\/server bytes/);
  });

  it("rejects an archive that lacks a build receipt", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    const archivePath = await packWorkspaceArchive(root, { omit: "cli" });

    expect(() =>
      assertPackagedArchiveExactSource({ archivePath, workspaceRoot: root, log: () => {} }),
    ).toThrow(/lacks the exact-source build receipt/);
  });
});

describe("installed readback", () => {
  it("proves the installed bundle commit before activation", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});
    const head = git(root, "rev-parse", "HEAD").trim();
    const archivePath = await packWorkspaceArchive(root);

    const macBundle = join(mkdtempSync(join(suiteRoot, "installed-mac-")), "Paseo.app");
    mkdirSync(join(macBundle, "Contents", "Resources"), { recursive: true });
    cpSync(archivePath, join(macBundle, "Contents", "Resources", "app.asar"));

    const linuxInstall = mkdtempSync(join(suiteRoot, "installed-linux-"));
    mkdirSync(join(linuxInstall, "resources"), { recursive: true });
    cpSync(archivePath, join(linuxInstall, "resources", "app.asar"));

    for (const installedPath of [macBundle, linuxInstall, archivePath]) {
      const provenance = readInstalledBuildProvenance({ installedPath });
      expect(provenance.commit).toBe(head);
    }

    expect(
      readInstalledBuildProvenance({ installedPath: macBundle, expectCommit: head }).commit,
    ).toBe(head);
    expect(() =>
      readInstalledBuildProvenance({ installedPath: macBundle, expectCommit: "0".repeat(40) }),
    ).toThrow(/Do not activate/);

    const cliRead = spawnSync(
      "node",
      [join(packageRoot, "scripts", "build-provenance-gate.js"), "read", macBundle],
      { encoding: "utf8" },
    );
    expect(cliRead.status).toBe(0);
    expect(JSON.parse(cliRead.stdout).commit).toBe(head);

    const cliMismatch = spawnSync(
      "node",
      [
        join(packageRoot, "scripts", "build-provenance-gate.js"),
        "read",
        macBundle,
        "--expect-commit",
        "0".repeat(40),
      ],
      { encoding: "utf8" },
    );
    expect(cliMismatch.status).toBe(1);
    expect(cliMismatch.stderr).toContain("Do not activate");
  });

  it("rejects readback of bundles without provable clean receipts", async () => {
    const root = createWorkspaceRepo();
    writeBuildReceipts(root, () => {});

    const bare = await packWorkspaceArchive(root, { omit: "server" });
    expect(() => readInstalledBuildProvenance({ installedPath: bare })).toThrow(
      /carries no build receipt/,
    );

    for (const packageName of ["server", "cli"]) {
      writeFileSync(
        receiptPath(root, packageName),
        formatBuildReceipt({
          commit: git(root, "rev-parse", "HEAD").trim(),
          dirtyPaths: ["source.txt"],
        }),
      );
    }
    const dirty = await packWorkspaceArchive(root);
    expect(() => readInstalledBuildProvenance({ installedPath: dirty })).toThrow(/dirty tree/);
  });
});

// The provenance contract only holds if the canonical build path cannot skip
// it silently: the clean full build must write receipts, the incremental build
// must drop them, and every packaging entry point must verify them.
describe("canonical path wiring", () => {
  it("keeps receipt writing on the clean build and invalidation on incremental builds", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(rootPackage.scripts["build:server:clean"]).toContain(
      "node scripts/build-receipt.cjs write",
    );
    expect(rootPackage.scripts["build:server"]).toContain(
      "node scripts/build-receipt.cjs invalidate",
    );
  });

  it("routes desktop packaging through the clean build and the provenance gates", () => {
    const desktopPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(desktopPackage.scripts.build).toContain("build:server:clean");
    expect(desktopPackage.scripts.build).toContain("run-electron-builder.js");

    const builderConfig = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
    expect(builderConfig).toContain("afterPack: ./scripts/after-pack.js");
    expect(builderConfig).toContain("afterSign: ./scripts/after-sign.js");

    const wrapper = readFileSync(join(packageRoot, "scripts", "run-electron-builder.js"), "utf8");
    expect(wrapper).toContain("assertWorkspaceExactSource");
    const afterPack = readFileSync(join(packageRoot, "scripts", "after-pack.js"), "utf8");
    expect(afterPack).toContain("assertPackagedArchiveExactSource");
    const afterSign = readFileSync(join(packageRoot, "scripts", "after-sign.js"), "utf8");
    expect(afterSign).toContain("assertPackagedArchiveExactSource");
  });
});
