// POSIX-only: git worktree and teardown shell fixtures
/* eslint-disable max-nested-callbacks */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BranchAlreadyCheckedOutError,
  createWorktree as createWorktreePrimitive,
  deriveWorktreeProjectHash,
  deletePaseoWorktree,
  getPaseoWorktreeCleanupCompletedMarkerPath,
  getPaseoWorktreeCleanupMarkerPath,
  getPaseoWorktreeCleanupQuarantinePath,
  getPaseoWorktreeCleanupReceiptPath,
  getPaseoWorktreeCleanupRecoveryRootPath,
  InvalidGitBranchNameError,
  getScriptConfigs,
  getWorktreeSetupCommands,
  getWorktreeTerminalSpecs,
  getWorktreeTeardownCommands,
  isServiceScript,
  isPaseoOwnedWorktreeCwd,
  listPaseoWorktrees,
  readPaseoConfig,
  resolveWorktreeRuntimeEnv,
  type WorktreeSetupCommandProgressEvent,
  runWorktreeSetupCommands,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "./worktree";
import { MAX_WORKTREE_SETUP_TOTAL_OUTPUT_BYTES } from "./worktree-setup-output.js";
import type { PaseoConfig } from "@getpaseo/protocol/paseo-config-schema";
import {
  getPaseoWorktreeMetadataPath,
  readPaseoWorktreeIncarnationId,
} from "./worktree-metadata.js";
import { execFileSync } from "child_process";
import { isPlatform } from "../test-utils/platform.js";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  realpathSync,
  renameSync,
  symlinkSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
} from "fs";
import { basename, delimiter, dirname, join } from "path";
import { tmpdir } from "os";
import net from "node:net";

function loadConfigForTest(repoRoot: string): PaseoConfig | null {
  const result = readPaseoConfig(repoRoot);
  return result.ok ? result.config : null;
}

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  paseoHome?: string;
  worktreesRoot?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    paseoHome: options.paseoHome,
    worktreesRoot: options.worktreesRoot,
  });
}

describe.skipIf(isPlatform("win32"))("worktree POSIX-only", () => {
  describe("createWorktree", () => {
    let tempDir: string;
    let repoDir: string;
    let paseoHome: string;

    beforeEach(() => {
      // Use realpathSync to resolve symlinks (e.g., /var -> /private/var on macOS)
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
      repoDir = join(tempDir, "test-repo");
      paseoHome = join(tempDir, "paseo-home");

      // Create a git repo with an initial commit
      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("creates a worktree for the current branch (main)", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello-world",
        paseoHome,
      });

      expect(result.worktreePath).toBe(join(paseoHome, "worktrees", projectHash, "hello-world"));
      expect(existsSync(result.worktreePath)).toBe(true);
      expect(existsSync(join(result.worktreePath, "file.txt"))).toBe(true);
      const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
      expect(existsSync(metadataPath)).toBe(true);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
    });

    it("creates and owns worktrees under a configured root", async () => {
      const worktreesRoot = join(tempDir, "custom-worktrees");
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        branchName: "custom-root",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "custom-root",
        paseoHome,
        worktreesRoot,
      });

      expect(result.worktreePath).toBe(join(worktreesRoot, projectHash, "custom-root"));
      await expect(
        isPaseoOwnedWorktreeCwd(result.worktreePath, { paseoHome, worktreesRoot }),
      ).resolves.toMatchObject({ allowed: true, worktreeRoot: join(worktreesRoot, projectHash) });
      await expect(
        isPaseoOwnedWorktreeCwd(result.worktreePath, { paseoHome }),
      ).resolves.toMatchObject({ allowed: false });

      const worktrees = await listPaseoWorktrees({ cwd: repoDir, paseoHome, worktreesRoot });
      expect(worktrees.map((entry) => entry.path)).toContain(result.worktreePath);

      await deletePaseoWorktree({
        cwd: repoDir,
        worktreePath: result.worktreePath,
        paseoHome,
        worktreesBaseRoot: worktreesRoot,
      });
      expect(existsSync(result.worktreePath)).toBe(false);
    });

    it.skip("detects paseo-owned worktrees across realpath differences (macOS /var vs /private/var)", async () => {
      // Intentionally create repo using the non-realpath tmpdir() variant (often /var/... on macOS).
      const varTempDir = mkdtempSync(join(tmpdir(), "worktree-realpath-test-"));
      const privateTempDir = realpathSync(varTempDir);
      const varRepoDir = join(varTempDir, "test-repo");
      const varPaseoHome = join(varTempDir, "paseo-home");
      mkdirSync(varRepoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: varRepoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: varRepoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: varRepoDir });
      writeFileSync(join(varRepoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: varRepoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: varRepoDir,
      });

      await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: varRepoDir,
        baseBranch: "main",
        worktreeSlug: "realpath-test",
        paseoHome: varPaseoHome,
      });

      const projectHash = await deriveWorktreeProjectHash(varRepoDir);
      const privateWorktreePath = join(
        privateTempDir,
        "paseo-home",
        "worktrees",
        projectHash,
        "realpath-test",
      );
      expect(existsSync(privateWorktreePath)).toBe(true);

      const ownership = await isPaseoOwnedWorktreeCwd(privateWorktreePath, {
        paseoHome: varPaseoHome,
      });
      expect(ownership.allowed).toBe(true);

      rmSync(varTempDir, { recursive: true, force: true });
    });

    it("reports repoRoot as the repository root for paseo-owned worktrees", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "repo-root-check",
        paseoHome,
      });

      const ownership = await isPaseoOwnedWorktreeCwd(result.worktreePath, { paseoHome });
      expect(ownership.allowed).toBe(true);
      expect(ownership.repoRoot).toBe(repoDir);
    });

    it("treats non-git directories as non-worktrees without throwing", async () => {
      const nonGitDir = join(tempDir, "not-a-repo");
      mkdirSync(nonGitDir, { recursive: true });

      const ownership = await isPaseoOwnedWorktreeCwd(nonGitDir, { paseoHome });

      expect(ownership.allowed).toBe(false);
      expect(ownership.worktreePath).toBe(realpathSync(nonGitDir));
    });

    it("creates a worktree with a new branch", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "my-feature",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/x" },
        runSetup: true,
        paseoHome,
      });

      expect(result.worktreePath).toBe(join(paseoHome, "worktrees", projectHash, "my-feature"));
      expect(existsSync(result.worktreePath)).toBe(true);

      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("feature/x");
      execFileSync("git", ["merge-base", "--is-ancestor", "main", "HEAD"], {
        cwd: result.worktreePath,
      });

      const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
    });

    it("checks out an existing local branch that is not checked out elsewhere", async () => {
      execFileSync("git", ["branch", "dev"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "dev-worktree",
        source: { kind: "checkout-branch", branchName: "dev" },
        runSetup: true,
        paseoHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("dev");

      const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ version: 1, baseRefName: "dev" });
    });

    it("checks out an existing local branch whose name contains uppercase letters and dots", async () => {
      execFileSync("git", ["branch", "release/1.1.15"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "release-worktree",
        source: { kind: "checkout-branch", branchName: "release/1.1.15" },
        runSetup: true,
        paseoHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("release/1.1.15");
    });

    it("throws a typed error when checking out a branch already checked out in the main repo", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "dev-worktree",
          source: { kind: "checkout-branch", branchName: "main" },
          runSetup: true,
          paseoHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(BranchAlreadyCheckedOutError);
      expect((caughtError as BranchAlreadyCheckedOutError).branchName).toBe("main");
    });

    it("fetches a GitHub PR branch, checks it out, writes metadata, and runs setup", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-b", "contributor/feature"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-pr\n");
      writeFileSync(
        join(remoteCloneDir, "paseo.json"),
        JSON.stringify({ worktree: { setup: ['echo "setup ran" > setup.log'] } }),
      );
      execFileSync("git", ["add", "."], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "pr branch"], {
        cwd: remoteCloneDir,
      });
      const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remoteCloneDir })
        .toString()
        .trim();
      execFileSync("git", ["push", "origin", "contributor/feature"], { cwd: remoteCloneDir });
      execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/42/head", prHead]);

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "pr-42",
        source: {
          kind: "checkout-github-pr",
          githubPrNumber: 42,
          headRef: "user/feature",
          baseRefName: "main",
        },
        runSetup: true,
        paseoHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-pr\n");
      expect(readFileSync(join(result.worktreePath, "setup.log"), "utf8")).toBe("setup ran\n");
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("user/feature");

      const metadataPath = getPaseoWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ baseRefName: "main" });
    });

    it("fetches a GitHub PR branch when the head ref contains uppercase letters and dots", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-b", "Feature.X"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-uppercase-pr\n");
      execFileSync("git", ["add", "file.txt"], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "uppercase pr branch"], {
        cwd: remoteCloneDir,
      });
      const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remoteCloneDir })
        .toString()
        .trim();
      execFileSync("git", ["push", "origin", "Feature.X"], { cwd: remoteCloneDir });
      execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/43/head", prHead]);

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "pr-43",
        source: {
          kind: "checkout-github-pr",
          githubPrNumber: 43,
          headRef: "Feature.X",
          baseRefName: "main",
        },
        runSetup: true,
        paseoHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe(
        "from-uppercase-pr\n",
      );
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("Feature.X");
    });

    it("prefers origin/{branch} over local {branch} when both exist", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["init", "--bare", remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-B", "main", "origin/main"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-origin\n");
      execFileSync("git", ["add", "file.txt"], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance origin main"], {
        cwd: remoteCloneDir,
      });
      execFileSync("git", ["push", "origin", "main"], { cwd: remoteCloneDir });

      writeFileSync(join(repoDir, "file.txt"), "from-local\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance local main"], {
        cwd: repoDir,
      });

      execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "prefer-origin-feature",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "prefer-origin-feature",
        runSetup: false,
        paseoHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-origin\n");
    });

    it("falls back to local {branch} when origin/{branch} does not exist", async () => {
      writeFileSync(join(repoDir, "file.txt"), "from-local-only\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "advance local main only"],
        {
          cwd: repoDir,
        },
      );

      const result = await createLegacyWorktreeForTest({
        branchName: "prefer-local-fallback-feature",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "prefer-local-fallback-feature",
        runSetup: false,
        paseoHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-local-only\n");
    });

    it("throws when neither origin/{branch} nor local {branch} exists", async () => {
      await expect(
        createLegacyWorktreeForTest({
          branchName: "missing-base-feature",
          cwd: repoDir,
          baseBranch: "does-not-exist",
          worktreeSlug: "missing-base-feature",
          runSetup: false,
          paseoHome,
        }),
      ).rejects.toThrow("Base branch not found: does-not-exist");
    });

    it("fails with invalid branch name", async () => {
      await expect(
        createLegacyWorktreeForTest({
          branchName: "INVALID_UPPERCASE",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "test",
        }),
      ).rejects.toThrow("Invalid branch name");
    });

    it("throws a typed error when checking out an invalid existing branch name", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "invalid-existing-branch",
          source: { kind: "checkout-branch", branchName: "bad..name" },
          runSetup: true,
          paseoHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(InvalidGitBranchNameError);
      expect((caughtError as InvalidGitBranchNameError).branchName).toBe("bad..name");
    });

    it("throws a typed error when checking out a ref that is valid but not a branch name", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "invalid-option-like-branch",
          source: { kind: "checkout-branch", branchName: "-bad" },
          runSetup: true,
          paseoHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(InvalidGitBranchNameError);
      expect((caughtError as InvalidGitBranchNameError).branchName).toBe("-bad");
    });

    it("handles branch name collision by adding suffix", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      // Create a branch named "hello" first
      execFileSync("git", ["branch", "hello"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello",
        paseoHome,
      });

      // Should create branch "hello-1" since "hello" exists
      expect(result.worktreePath).toBe(join(paseoHome, "worktrees", projectHash, "hello"));
      expect(existsSync(result.worktreePath)).toBe(true);

      const branches = execFileSync("git", ["branch"], { cwd: repoDir }).toString();
      expect(branches).toContain("hello-1");
    });

    it("handles multiple collisions", async () => {
      // Create branches "hello" and "hello-1"
      execFileSync("git", ["branch", "hello"], { cwd: repoDir });
      execFileSync("git", ["branch", "hello-1"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello",
        paseoHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);

      const branches = execFileSync("git", ["branch"], { cwd: repoDir }).toString();
      expect(branches).toContain("hello-2");
    });

    it("runs setup commands from paseo.json", async () => {
      // Create paseo.json with setup commands
      const paseoConfig = {
        worktree: {
          setup: [
            'echo "source=$PASEO_SOURCE_CHECKOUT_PATH" > setup.log',
            'echo "root_alias=$PASEO_ROOT_PATH" >> setup.log',
            'echo "worktree=$PASEO_WORKTREE_PATH" >> setup.log',
            'echo "branch=$PASEO_BRANCH_NAME" >> setup.log',
            'echo "port=$PASEO_WORKTREE_PORT" >> setup.log',
          ],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add paseo.json"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "setup-test",
        paseoHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);

      // Verify setup ran and env vars were available
      const setupLog = readFileSync(join(result.worktreePath, "setup.log"), "utf8");
      expect(setupLog).toContain(`source=${repoDir}`);
      expect(setupLog).toContain(`root_alias=${repoDir}`);
      expect(setupLog).toContain(`worktree=${result.worktreePath}`);
      expect(setupLog).toContain("branch=setup-test");
      const portLine = setupLog.split("\n").find((line) => line.startsWith("port="));
      expect(portLine).toBeDefined();
      const portValue = Number(portLine?.slice("port=".length));
      expect(Number.isInteger(portValue)).toBe(true);
      expect(portValue).toBeGreaterThan(0);
    });

    it("runs string setup scripts from paseo.json as a single shell command", async () => {
      const paseoConfig = {
        worktree: {
          setup: 'greeting="hello from string setup"\necho "$greeting" > setup.log',
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add string setup"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "string-setup-test",
        paseoHome,
      });

      expect(getWorktreeSetupCommands(result.worktreePath)).toEqual([
        'greeting="hello from string setup"\necho "$greeting" > setup.log',
      ]);
      expect(readFileSync(join(result.worktreePath, "setup.log"), "utf8").trim()).toBe(
        "hello from string setup",
      );
    });

    it("runs setup commands with the daemon PATH instead of login profile PATH", async () => {
      const home = join(tempDir, "host-home");
      const binDir = join(tempDir, "daemon-bin");
      mkdirSync(home);
      mkdirSync(binDir);

      const shimPath = join(binDir, "paseo-shim");
      writeFileSync(shimPath, "#!/bin/sh\nprintf 'shim:%s\\n' \"$1\"\n");
      chmodSync(shimPath, 0o755);
      writeFileSync(join(home, ".bash_profile"), "export PATH=/usr/bin:/bin\n");
      const bashEnvPath = join(home, "bash-env");
      writeFileSync(bashEnvPath, "export PATH=/usr/bin:/bin\n");
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: "command -v paseo-shim >/dev/null && paseo-shim ok > setup-path.log",
          },
        }),
      );

      const originalHome = process.env.HOME;
      const originalPath = process.env.PATH;
      const originalBashEnv = process.env.BASH_ENV;
      process.env.HOME = home;
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? "/usr/bin:/bin"}`;
      process.env.BASH_ENV = bashEnvPath;

      try {
        await runWorktreeSetupCommands({
          worktreePath: repoDir,
          branchName: "main",
          cleanupOnFailure: false,
          runtimeEnv: {
            PASEO_SOURCE_CHECKOUT_PATH: repoDir,
            PASEO_ROOT_PATH: repoDir,
            PASEO_WORKTREE_PATH: repoDir,
            PASEO_BRANCH_NAME: "main",
            PASEO_WORKTREE_PORT: "12345",
          },
        });
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        if (originalBashEnv === undefined) {
          delete process.env.BASH_ENV;
        } else {
          process.env.BASH_ENV = originalBashEnv;
        }
      }

      expect(readFileSync(join(repoDir, "setup-path.log"), "utf8").trim()).toBe("shim:ok");
    });

    it("treats blank lifecycle strings as empty", () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: " \n\t ",
            teardown: " \n ",
          },
        }),
      );

      expect(getWorktreeSetupCommands(repoDir)).toEqual([]);
      expect(getWorktreeTeardownCommands(repoDir)).toEqual([]);
    });

    it("filters non-string and blank entries from lifecycle arrays", () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: [
              'echo "first" > setup-array.log',
              null,
              "   ",
              'echo "second" >> setup-array.log',
            ],
            teardown: [
              'echo "first" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown-array.log"',
              null,
              "",
              'echo "second" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown-array.log"',
            ],
          },
        }),
      );

      expect(getWorktreeSetupCommands(repoDir)).toEqual([
        'echo "first" > setup-array.log',
        'echo "second" >> setup-array.log',
      ]);
      expect(getWorktreeTeardownCommands(repoDir)).toEqual([
        'echo "first" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown-array.log"',
        'echo "second" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown-array.log"',
      ]);
    });

    it("does not run setup commands when runSetup=false", async () => {
      const paseoConfig = {
        worktree: {
          setup: ['echo "setup ran" > setup.log'],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add paseo.json"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "no-setup-test",
        runSetup: false,
        paseoHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      expect(existsSync(join(result.worktreePath, "setup.log"))).toBe(false);
    });

    it("streams setup command progress events while commands are executing", async () => {
      const paseoConfig = {
        worktree: {
          setup: ['echo "first line"; echo "second line" 1>&2'],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add streaming setup"], {
        cwd: repoDir,
      });

      const progressEvents: WorktreeSetupCommandProgressEvent[] = [];
      const results = await runWorktreeSetupCommands({
        worktreePath: repoDir,
        branchName: "main",
        cleanupOnFailure: false,
        onEvent: (event) => {
          progressEvents.push(event);
        },
      });

      expect(results).toHaveLength(1);
      expect(progressEvents.some((event) => event.type === "command_started")).toBe(true);
      expect(progressEvents.some((event) => event.type === "output")).toBe(true);
      expect(progressEvents.some((event) => event.type === "command_completed")).toBe(true);
    });

    it("bounds retained output across noisy setup commands and reports exact omitted bytes", async () => {
      const outputBytesPerStream = Buffer.byteLength("prefix--suffix") + 70_000;
      const noisyCommand =
        "node -e \"process.stdout.write('prefix-' + 'x'.repeat(70000) + '-suffix'); process.stderr.write('prefix-' + 'y'.repeat(70000) + '-suffix')\"";
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({ worktree: { setup: Array.from({ length: 5 }, () => noisyCommand) } }),
      );

      const results = await runWorktreeSetupCommands({
        worktreePath: repoDir,
        branchName: "main",
        cleanupOnFailure: false,
      });

      expect(results).toHaveLength(5);
      let retainedOutputBytes = 0;
      for (const result of results) {
        for (const output of [result.stdout, result.stderr]) {
          const marker = output.match(/\n\.\.\.<(\d+) bytes omitted>\.\.\.\n/);
          expect(marker).not.toBeNull();
          const retained = output.replace(marker?.[0] ?? "", "");
          expect(Number(marker?.[1])).toBe(outputBytesPerStream - Buffer.byteLength(retained));
          expect(retained).toContain("prefix-");
          expect(retained).toContain("-suffix");
          retainedOutputBytes += Buffer.byteLength(output);
        }
      }
      expect(retainedOutputBytes).toBeLessThanOrEqual(MAX_WORKTREE_SETUP_TOTAL_OUTPUT_BYTES);
    }, 15_000);

    it("reuses persisted worktree runtime port across resolutions", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "runtime-env-port-reuse",
        runSetup: false,
        paseoHome,
      });

      const first = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      const second = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });

      expect(second.PASEO_WORKTREE_PORT).toBe(first.PASEO_WORKTREE_PORT);
    });

    it("fails runtime env resolution when persisted port is in use", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "runtime-env-port-conflict",
        runSetup: false,
        paseoHome,
      });

      const env = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      const port = Number(env.PASEO_WORKTREE_PORT);

      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve());
      });

      await expect(
        resolveWorktreeRuntimeEnv({
          worktreePath: result.worktreePath,
          branchName: result.branchName,
        }),
      ).rejects.toThrow(`Persisted worktree port ${port} is already in use`);

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    it("cleans up worktree if setup command fails", async () => {
      // Create paseo.json with failing setup command
      const paseoConfig = {
        worktree: {
          setup: ["exit 1"],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add paseo.json"], {
        cwd: repoDir,
      });

      const expectedWorktreePath = join(paseoHome, "worktrees", "test-repo", "fail-test");

      await expect(
        createLegacyWorktreeForTest({
          branchName: "main",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "fail-test",
          paseoHome,
        }),
      ).rejects.toThrow("Worktree setup command failed");

      // Verify worktree was cleaned up
      expect(existsSync(expectedWorktreePath)).toBe(false);
    });

    it("reads worktree terminal specs from paseo.json with optional name", async () => {
      const paseoConfig = {
        worktree: {
          terminals: [
            { name: "Dev Server", command: "npm run dev" },
            { command: "cd packages/app && npm run dev" },
          ],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));

      expect(getWorktreeTerminalSpecs(repoDir)).toEqual([
        { name: "Dev Server", command: "npm run dev" },
        { command: "cd packages/app && npm run dev" },
      ]);
    });

    it("filters invalid worktree terminal specs", async () => {
      const paseoConfig = {
        worktree: {
          terminals: [
            null,
            {},
            { name: "   ", command: "   " },
            { name: " Watch ", command: "npm run watch", cwd: "packages/app" },
            { name: 123, command: "npm run test" },
          ],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));

      expect(getWorktreeTerminalSpecs(repoDir)).toEqual([
        { name: "Watch", command: "npm run watch" },
        { command: "npm run test" },
      ]);
    });

    it("parses omitted script type as a plain script", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          scripts: {
            typecheck: {
              command: " npm run typecheck ",
            },
          },
        }),
      );

      const scriptConfigs = getScriptConfigs(loadConfigForTest(repoDir));
      const typecheck = scriptConfigs.get("typecheck");

      expect(typecheck).toEqual({
        command: "npm run typecheck",
      });
      expect(typecheck).toBeDefined();
      expect(isServiceScript(typecheck!)).toBe(false);
    });

    it("parses service scripts and preserves optional port", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          scripts: {
            server: {
              type: "service",
              command: "npm run dev",
              port: 4321,
            },
          },
        }),
      );

      const scriptConfigs = getScriptConfigs(loadConfigForTest(repoDir));
      const server = scriptConfigs.get("server");

      expect(server).toEqual({
        type: "service",
        command: "npm run dev",
        port: 4321,
      });
      expect(server).toBeDefined();
      expect(isServiceScript(server!)).toBe(true);
    });

    it("ignores invalid script entries gracefully", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          scripts: {
            valid: {
              command: "npm run valid",
            },
            invalidType: {
              type: "worker",
              command: "npm run worker",
            },
            missingCommand: {
              type: "service",
            },
            blankCommand: {
              command: "   ",
            },
            nonObject: "npm run nope",
            invalidPort: {
              type: "service",
              command: "npm run dev",
              port: "3000",
            },
          },
        }),
      );

      expect(getScriptConfigs(loadConfigForTest(repoDir))).toEqual(
        new Map([
          ["valid", { command: "npm run valid" }],
          ["invalidType", { command: "npm run worker" }],
          ["invalidPort", { type: "service", command: "npm run dev" }],
        ]),
      );
    });

    it("seeds an uncommitted paseo.json from the main repo into a new worktree", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({ scripts: { dev: { command: "echo hi" } } }),
      );

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "seed-uncommitted",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/seed" },
        runSetup: false,
        paseoHome,
      });

      const worktreeConfigPath = join(result.worktreePath, "paseo.json");
      expect(existsSync(worktreeConfigPath)).toBe(true);
      expect(JSON.parse(readFileSync(worktreeConfigPath, "utf8"))).toEqual({
        scripts: { dev: { command: "echo hi" } },
      });
    });

    it("does not overwrite a committed paseo.json with uncommitted edits in the main repo", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({ scripts: { dev: { command: "committed" } } }),
      );
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add paseo.json"], {
        cwd: repoDir,
      });

      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({ scripts: { dev: { command: "uncommitted" } } }),
      );

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "preserve-committed",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/preserve" },
        runSetup: false,
        paseoHome,
      });

      const worktreeConfigPath = join(result.worktreePath, "paseo.json");
      expect(JSON.parse(readFileSync(worktreeConfigPath, "utf8"))).toEqual({
        scripts: { dev: { command: "committed" } },
      });
    });

    it("creates a worktree without error when no paseo.json exists in the main repo", async () => {
      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "no-config",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/no-config" },
        runSetup: false,
        paseoHome,
      });

      expect(existsSync(join(result.worktreePath, "paseo.json"))).toBe(false);
    });
  });

  describe("paseo worktree manager", () => {
    let tempDir: string;
    let repoDir: string;
    let paseoHome: string;

    beforeEach(() => {
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
      repoDir = join(tempDir, "test-repo");
      paseoHome = join(tempDir, "paseo-home");

      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("isolates worktree roots for repositories that share the same directory name", async () => {
      const repoA = join(tempDir, "team-a", "test-repo");
      const repoB = join(tempDir, "team-b", "test-repo");

      for (const repo of [repoA, repoB]) {
        mkdirSync(repo, { recursive: true });
        execFileSync("git", ["init", "-b", "main"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
        writeFileSync(join(repo, "file.txt"), "hello\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
          cwd: repo,
        });
      }

      const fromRepoA = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoA,
        baseBranch: "main",
        worktreeSlug: "alpha",
        paseoHome,
      });
      const fromRepoB = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoB,
        baseBranch: "main",
        worktreeSlug: "alpha",
        paseoHome,
      });

      expect(dirname(fromRepoA.worktreePath)).not.toBe(dirname(fromRepoB.worktreePath));
      expect(fromRepoA.worktreePath.endsWith("alpha-1")).toBe(false);
      expect(fromRepoB.worktreePath.endsWith("alpha-1")).toBe(false);

      const repoAWorktrees = await listPaseoWorktrees({ cwd: repoA, paseoHome });
      const repoBWorktrees = await listPaseoWorktrees({ cwd: repoB, paseoHome });

      expect(repoAWorktrees.map((entry) => entry.path)).toEqual([fromRepoA.worktreePath]);
      expect(repoBWorktrees.map((entry) => entry.path)).toEqual([fromRepoB.worktreePath]);
    });

    it("lists and deletes paseo worktrees under ~/.paseo/worktrees/{hash}", async () => {
      const first = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "alpha",
        paseoHome,
      });
      const second = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "beta",
        paseoHome,
      });

      const worktrees = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
      const paths = worktrees.map((worktree) => worktree.path).sort();
      expect(paths).toEqual([first.worktreePath, second.worktreePath].sort());

      await deletePaseoWorktree({ cwd: repoDir, worktreePath: first.worktreePath, paseoHome });
      expect(existsSync(first.worktreePath)).toBe(false);

      const remaining = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
      expect(remaining.map((worktree) => worktree.path)).toEqual([second.worktreePath]);
    });

    it("deletes a paseo worktree even when given a subdirectory path", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "alpha",
        paseoHome,
      });

      const nestedDir = join(created.worktreePath, "nested", "dir");
      mkdirSync(nestedDir, { recursive: true });

      await deletePaseoWorktree({ cwd: repoDir, worktreePath: nestedDir, paseoHome });
      expect(existsSync(created.worktreePath)).toBe(false);

      const remaining = await listPaseoWorktrees({ cwd: repoDir, paseoHome });
      expect(remaining.some((worktree) => worktree.path === created.worktreePath)).toBe(false);
    });

    it("runs teardown commands from paseo.json before deleting a worktree", async () => {
      const paseoConfig = {
        worktree: {
          teardown: [
            'echo "source=$PASEO_SOURCE_CHECKOUT_PATH" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "root_alias=$PASEO_ROOT_PATH" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "worktree=$PASEO_WORKTREE_PATH" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "branch=$PASEO_BRANCH_NAME" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "port=$PASEO_WORKTREE_PORT" >> "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
          ],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add teardown commands"], {
        cwd: repoDir,
      });

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-test",
        paseoHome,
      });
      const runtimeEnv = await resolveWorktreeRuntimeEnv({
        worktreePath: created.worktreePath,
        branchName: created.branchName,
      });

      await deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome });
      expect(existsSync(created.worktreePath)).toBe(false);

      const teardownLog = readFileSync(join(repoDir, "teardown.log"), "utf8");
      expect(teardownLog).toContain(`source=${repoDir}`);
      expect(teardownLog).toContain(`root_alias=${repoDir}`);
      expect(teardownLog).toContain(`worktree=${created.worktreePath}`);
      expect(teardownLog).toContain("branch=teardown-branch");
      expect(teardownLog).toContain(`port=${runtimeEnv.PASEO_WORKTREE_PORT}`);
    });

    it("rechecks after each awaited teardown command before continuing or deleting", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          worktree: {
            teardown: [
              'echo first > "$PASEO_SOURCE_CHECKOUT_PATH/first-teardown.log"',
              'echo second > "$PASEO_SOURCE_CHECKOUT_PATH/second-teardown.log"',
            ],
          },
        }),
      );
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "guard teardown"], {
        cwd: repoDir,
      });
      const created = await createLegacyWorktreeForTest({
        branchName: "guarded-teardown-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "guarded-teardown",
        paseoHome,
      });

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          paseoHome,
          recheck: () => {
            if (existsSync(join(repoDir, "first-teardown.log"))) {
              throw new Error("teardown authority revoked");
            }
          },
        }),
      ).rejects.toThrow("teardown authority revoked");

      expect(existsSync(join(repoDir, "first-teardown.log"))).toBe(true);
      expect(existsSync(join(repoDir, "second-teardown.log"))).toBe(false);
      expect(existsSync(created.worktreePath)).toBe(true);
    });

    it("rechecks after ownership resolution before removing a worktree", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "guarded-ownership-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "guarded-ownership",
        paseoHome,
      });
      let recheckCount = 0;

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          paseoHome,
          recheck: () => {
            recheckCount += 1;
            if (recheckCount === 2) {
              throw new Error("ownership authority revoked");
            }
          },
        }),
      ).rejects.toThrow("ownership authority revoked");

      expect(existsSync(created.worktreePath)).toBe(true);
    });

    it("runs string teardown scripts from paseo.json as a single shell command", async () => {
      const paseoConfig = {
        worktree: {
          teardown:
            'cleanup_message="teardown string"\necho "$cleanup_message" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add string teardown"], {
        cwd: repoDir,
      });

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-string-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-string-test",
        paseoHome,
      });

      await deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome });

      expect(getWorktreeTeardownCommands(repoDir)).toEqual([
        'cleanup_message="teardown string"\necho "$cleanup_message" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown.log"',
      ]);
      expect(readFileSync(join(repoDir, "teardown.log"), "utf8").trim()).toBe("teardown string");
    });

    it("omits PASEO_WORKTREE_PORT from teardown env when runtime metadata is missing", async () => {
      const paseoConfig = {
        worktree: {
          teardown: [
            'echo "port=${PASEO_WORKTREE_PORT-unset}" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown-port.log"',
          ],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add teardown port logging"],
        { cwd: repoDir },
      );

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-port-missing-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-port-missing-test",
        paseoHome,
      });

      await deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome });

      expect(readFileSync(join(repoDir, "teardown-port.log"), "utf8").trim()).toBe("port=unset");
      expect(existsSync(created.worktreePath)).toBe(false);
    });

    it("does not remove worktree when a teardown command fails", async () => {
      const paseoConfig = {
        worktree: {
          teardown: [
            'echo "started" > "$PASEO_SOURCE_CHECKOUT_PATH/teardown-start.log"',
            "echo boom 1>&2; exit 9",
          ],
        },
      };
      writeFileSync(join(repoDir, "paseo.json"), JSON.stringify(paseoConfig));
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add failing teardown commands"],
        { cwd: repoDir },
      );

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-failure-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-failure-test",
        paseoHome,
      });

      await expect(
        deletePaseoWorktree({ cwd: repoDir, worktreePath: created.worktreePath, paseoHome }),
      ).rejects.toThrow("Worktree teardown command failed");

      expect(existsSync(created.worktreePath)).toBe(true);
      expect(existsSync(join(repoDir, "teardown-start.log"))).toBe(true);
    });

    it("cancels a running teardown process tree before deleting the worktree", async () => {
      writeFileSync(
        join(repoDir, "paseo.json"),
        JSON.stringify({
          worktree: {
            teardown: ['node -e "setInterval(() => {}, 1000)"'],
          },
        }),
      );
      execFileSync("git", ["add", "paseo.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add cancellable teardown"],
        { cwd: repoDir },
      );
      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-cancel-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-cancel-test",
        paseoHome,
      });
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 100);

      try {
        await expect(
          deletePaseoWorktree({
            cwd: repoDir,
            worktreePath: created.worktreePath,
            paseoHome,
            signal: controller.signal,
          }),
        ).rejects.toThrow("Worktree teardown command failed");
      } finally {
        clearTimeout(abortTimer);
      }
      expect(existsSync(created.worktreePath)).toBe(true);
    });

    it("removes only an existing quarantine authenticated by incarnation and marker", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "authenticated-quarantine-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "authenticated-quarantine",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000043";
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        created.worktreePath,
        incarnationId,
      );
      writeFileSync(getPaseoWorktreeCleanupMarkerPath(created.worktreePath, quarantineMarker), "", {
        mode: 0o600,
      });
      expect(
        statSync(getPaseoWorktreeCleanupMarkerPath(created.worktreePath, quarantineMarker)).mode &
          0o777,
      ).toBe(0o600);
      renameSync(created.worktreePath, quarantinePath);

      await deletePaseoWorktree({
        cwd: repoDir,
        worktreePath: created.worktreePath,
        teardownCwds: [],
        paseoHome,
        expectedWorktreeIncarnationId: incarnationId,
        expectedQuarantineMarker: quarantineMarker,
      });

      const completedMarkerPath = getPaseoWorktreeCleanupCompletedMarkerPath(
        quarantinePath,
        quarantineMarker,
      );
      const receiptPath = getPaseoWorktreeCleanupReceiptPath(
        quarantinePath,
        incarnationId,
        quarantineMarker,
      );
      expect(existsSync(quarantinePath)).toBe(false);
      expect(existsSync(completedMarkerPath)).toBe(false);
      expect(existsSync(receiptPath)).toBe(false);
    });

    it.each([
      ["before-marker-removal", "active"],
      ["after-marker-removal", "completed"],
      ["before-completion-acknowledgement", "completed"],
    ] as const)(
      "recovers the authenticated tombstone after a %s crash",
      async (cleanupFaultPoint, expectedMarkerState) => {
        const created = await createLegacyWorktreeForTest({
          branchName: `cleanup-fault-${cleanupFaultPoint}`,
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: `cleanup-fault-${cleanupFaultPoint}`,
          paseoHome,
        });
        const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
        const quarantineMarker = {
          "before-marker-removal": "00000000-0000-4000-8000-000000000052",
          "after-marker-removal": "00000000-0000-4000-8000-000000000053",
          "before-completion-acknowledgement": "00000000-0000-4000-8000-000000000054",
        }[cleanupFaultPoint];
        const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
          created.worktreePath,
          incarnationId,
        );

        await expect(
          deletePaseoWorktree({
            cwd: repoDir,
            worktreePath: created.worktreePath,
            teardownCwds: [],
            paseoHome,
            expectedWorktreeIncarnationId: incarnationId,
            expectedQuarantineMarker: quarantineMarker,
            cleanupFaultPoint,
          }),
        ).rejects.toThrow("Worktree cleanup remains");

        const receiptPath = getPaseoWorktreeCleanupReceiptPath(
          quarantinePath,
          incarnationId,
          quarantineMarker,
        );
        const remainingPath =
          cleanupFaultPoint === "before-completion-acknowledgement" ? receiptPath : quarantinePath;
        const expectedMarkerPath =
          expectedMarkerState === "active"
            ? getPaseoWorktreeCleanupMarkerPath(remainingPath, quarantineMarker)
            : getPaseoWorktreeCleanupCompletedMarkerPath(remainingPath, quarantineMarker);
        expect(readdirSync(remainingPath)).toEqual([basename(expectedMarkerPath)]);
        expect(
          existsSync(
            cleanupFaultPoint === "before-completion-acknowledgement"
              ? quarantinePath
              : receiptPath,
          ),
        ).toBe(false);
        if (cleanupFaultPoint === "before-completion-acknowledgement") {
          const recoveryRoot = getPaseoWorktreeCleanupRecoveryRootPath(quarantinePath);
          expect(statSync(recoveryRoot).mode & 0o777).toBe(0o700);
          expect(statSync(recoveryRoot).uid).toBe(process.getuid?.());
        }

        await expect(
          deletePaseoWorktree({
            cwd: repoDir,
            worktreePath: created.worktreePath,
            teardownCwds: [],
            paseoHome,
            expectedWorktreeIncarnationId: incarnationId,
            expectedQuarantineMarker: quarantineMarker,
          }),
        ).resolves.toBeUndefined();
        expect(existsSync(quarantinePath)).toBe(false);
        expect(existsSync(receiptPath)).toBe(false);
      },
    );

    it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
      "does not cross a same-device Linux bind mount",
      async () => {
        const created = await createLegacyWorktreeForTest({
          branchName: "same-device-bind-boundary",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "same-device-bind-boundary",
          paseoHome,
        });
        const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
        const quarantineMarker = "00000000-0000-4000-8000-000000000058";
        const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
          created.worktreePath,
          incarnationId,
        );
        const mountPoint = join(quarantinePath, "same-device-bind");
        const protectedPath = join(tempDir, "same-device-protected");
        mkdirSync(join(created.worktreePath, "same-device-bind"));
        mkdirSync(protectedPath);
        writeFileSync(join(protectedPath, "protected.txt"), "protected");
        let mounted = false;

        try {
          await expect(
            deletePaseoWorktree({
              cwd: repoDir,
              worktreePath: created.worktreePath,
              teardownCwds: [],
              paseoHome,
              expectedWorktreeIncarnationId: incarnationId,
              expectedQuarantineMarker: quarantineMarker,
              onCleanupDirectoryPinned: () => {
                execFileSync("mount", ["--bind", protectedPath, mountPoint], { stdio: "pipe" });
                mounted = true;
              },
            }),
          ).rejects.toThrow("Worktree cleanup remains");
          expect(readFileSync(join(protectedPath, "protected.txt"), "utf8")).toBe("protected");
          expect(
            existsSync(getPaseoWorktreeCleanupMarkerPath(quarantinePath, quarantineMarker)),
          ).toBe(true);
        } finally {
          if (mounted) execFileSync("umount", [mountPoint], { stdio: "pipe" });
        }
      },
    );

    it.skipIf(process.platform !== "darwin")(
      "does not cross a mounted filesystem while deleting quarantine contents",
      async () => {
        const created = await createLegacyWorktreeForTest({
          branchName: "mounted-cleanup-boundary",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "mounted-cleanup-boundary",
          paseoHome,
        });
        const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
        const quarantineMarker = "00000000-0000-4000-8000-000000000055";
        const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
          created.worktreePath,
          incarnationId,
        );
        const mountPoint = join(quarantinePath, "mounted-device");
        const diskImagePath = join(tempDir, "cleanup-boundary.dmg");
        mkdirSync(join(created.worktreePath, "mounted-device"));
        execFileSync(
          "hdiutil",
          [
            "create",
            "-quiet",
            "-size",
            "8m",
            "-fs",
            "HFS+",
            "-volname",
            "PaseoCleanupBoundary",
            diskImagePath,
          ],
          { stdio: "pipe" },
        );
        let mounted = false;

        try {
          await expect(
            deletePaseoWorktree({
              cwd: repoDir,
              worktreePath: created.worktreePath,
              teardownCwds: [],
              paseoHome,
              expectedWorktreeIncarnationId: incarnationId,
              expectedQuarantineMarker: quarantineMarker,
              onCleanupDirectoryPinned: () => {
                if (mounted) return;
                execFileSync(
                  "hdiutil",
                  ["attach", "-quiet", "-nobrowse", "-mountpoint", mountPoint, diskImagePath],
                  { stdio: "pipe" },
                );
                mounted = true;
                writeFileSync(join(mountPoint, "protected.txt"), "protected");
              },
            }),
          ).rejects.toThrow("Worktree cleanup remains");

          expect(readFileSync(join(mountPoint, "protected.txt"), "utf8")).toBe("protected");
          expect(
            existsSync(getPaseoWorktreeCleanupMarkerPath(quarantinePath, quarantineMarker)),
          ).toBe(true);
        } finally {
          if (mounted) {
            execFileSync("hdiutil", ["detach", "-quiet", mountPoint], { stdio: "pipe" });
          }
        }
      },
      20_000,
    );

    it("refuses a same-name quarantine whose marker does not match", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "forged-quarantine-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "forged-quarantine",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        created.worktreePath,
        incarnationId,
      );
      renameSync(created.worktreePath, quarantinePath);
      writeFileSync(join(quarantinePath, "keep.txt"), "keep");

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: "00000000-0000-4000-8000-000000000044",
        }),
      ).rejects.toThrow("Cleanup quarantine marker changed");

      expect(readFileSync(join(quarantinePath, "keep.txt"), "utf8")).toBe("keep");
    });

    it("refuses a quarantine path swapped for a symlink at the removal boundary", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "swapped-quarantine-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "swapped-quarantine",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000048";
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        created.worktreePath,
        incarnationId,
      );
      const protectedPath = `${quarantinePath}-protected`;
      writeFileSync(getPaseoWorktreeCleanupMarkerPath(created.worktreePath, quarantineMarker), "", {
        mode: 0o600,
      });
      renameSync(created.worktreePath, quarantinePath);
      writeFileSync(join(quarantinePath, "keep.txt"), "keep");
      renameSync(quarantinePath, protectedPath);
      symlinkSync(protectedPath, quarantinePath, "dir");

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: quarantineMarker,
        }),
      ).rejects.toThrow("Cleanup path is not a directory");

      expect(readFileSync(join(protectedPath, "keep.txt"), "utf8")).toBe("keep");
      expect(existsSync(quarantinePath)).toBe(true);
    });

    it("does not recursively delete a replacement installed after cleanup is pinned", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "pinned-replacement-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "pinned-replacement",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000049";
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        created.worktreePath,
        incarnationId,
      );
      const displacedPath = `${quarantinePath}-displaced`;

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: quarantineMarker,
          onCleanupDirectoryPinned: (pinnedPath) => {
            renameSync(pinnedPath, displacedPath);
            mkdirSync(pinnedPath);
            writeFileSync(join(pinnedPath, "keep.txt"), "replacement");
          },
        }),
      ).rejects.toThrow("Cleanup path identity changed");

      expect(readFileSync(join(quarantinePath, "keep.txt"), "utf8")).toBe("replacement");
      expect(existsSync(displacedPath)).toBe(true);
    });

    it("does not remove an empty replacement installed after cleanup completes", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "completed-empty-replacement-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "completed-empty-replacement",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000056";
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        created.worktreePath,
        incarnationId,
      );
      const displacedPath = `${quarantinePath}-displaced`;

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: quarantineMarker,
          onCleanupDirectoryCompleted: (completedPath) => {
            renameSync(completedPath, displacedPath);
            mkdirSync(completedPath);
          },
        }),
      ).rejects.toThrow("Cleanup path identity changed");

      expect(readdirSync(quarantinePath)).toEqual([]);
      expect(
        existsSync(getPaseoWorktreeCleanupCompletedMarkerPath(displacedPath, quarantineMarker)),
      ).toBe(true);
    });

    it("does not relocate a completed quarantine when final content appears", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "completed-final-content-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "completed-final-content",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000059";
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        created.worktreePath,
        incarnationId,
      );
      const receiptPath = getPaseoWorktreeCleanupReceiptPath(
        quarantinePath,
        incarnationId,
        quarantineMarker,
      );

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: quarantineMarker,
          onCleanupDirectoryCompleted: (completedPath) => {
            writeFileSync(join(completedPath, "late.txt"), "late");
          },
        }),
      ).rejects.toThrow("Worktree cleanup remains");

      expect(readFileSync(join(quarantinePath, "late.txt"), "utf8")).toBe("late");
      expect(existsSync(receiptPath)).toBe(false);
    });

    it("terminates and joins a hung cleanup helper on timeout", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "cleanup-helper-timeout-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "cleanup-helper-timeout",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000060";
      const helperPidPath = join(tempDir, "hung-cleanup-helper.pid");
      const helperChildPidPath = join(tempDir, "hung-cleanup-helper-child.pid");
      const helperPath = join(tempDir, "hung-cleanup-helper.sh");
      writeFileSync(
        helperPath,
        `#!/bin/sh
printf '%s' "$$" > ${JSON.stringify(helperPidPath)}
trap '' TERM
sleep 30 &
child_pid=$!
printf '%s' "$child_pid" > ${JSON.stringify(helperChildPidPath)}
wait "$child_pid"
`,
      );
      chmodSync(helperPath, 0o755);

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: quarantineMarker,
          cleanupFindExecutable: helperPath,
          cleanupHelperTimeoutMs: 1_000,
        }),
      ).rejects.toThrow("Worktree cleanup remains");

      const helperPid = Number(readFileSync(helperPidPath, "utf8"));
      const helperChildPid = Number(readFileSync(helperChildPidPath, "utf8"));
      expect(() => process.kill(helperPid, 0)).toThrow();
      expect(() => process.kill(helperChildPid, 0)).toThrow();
    });

    it("does not follow a symlink installed after cleanup is pinned", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "pinned-symlink-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "pinned-symlink",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000050";
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        created.worktreePath,
        incarnationId,
      );
      const displacedPath = `${quarantinePath}-displaced`;
      const protectedPath = join(tempDir, "protected-symlink-target");
      mkdirSync(protectedPath);
      writeFileSync(join(protectedPath, "keep.txt"), "protected");

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: quarantineMarker,
          onCleanupDirectoryPinned: (pinnedPath) => {
            renameSync(pinnedPath, displacedPath);
            symlinkSync(protectedPath, pinnedPath, "dir");
          },
        }),
      ).rejects.toThrow("Cleanup path identity changed");

      expect(readFileSync(join(protectedPath, "keep.txt"), "utf8")).toBe("protected");
      expect(existsSync(displacedPath)).toBe(true);
      expect(existsSync(quarantinePath)).toBe(true);
    });

    it("refuses to clean a pinned quarantine renamed outside its trusted parent", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "pinned-rename-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "pinned-rename",
        paseoHome,
      });
      const incarnationId = readPaseoWorktreeIncarnationId(created.worktreePath)!;
      const quarantineMarker = "00000000-0000-4000-8000-000000000051";
      const escapedPath = join(tempDir, "escaped-quarantine");

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: created.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: incarnationId,
          expectedQuarantineMarker: quarantineMarker,
          onCleanupDirectoryPinned: (pinnedPath) => {
            writeFileSync(join(pinnedPath, "keep.txt"), "escaped");
            renameSync(pinnedPath, escapedPath);
          },
        }),
      ).rejects.toThrow("Pinned cleanup directory lost its trusted pathname");

      expect(readFileSync(join(escapedPath, "keep.txt"), "utf8")).toBe("escaped");
    });

    it("lets a legacy receipt quarantine its original path but not claim a quarantine", async () => {
      const original = await createLegacyWorktreeForTest({
        branchName: "legacy-original-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "legacy-original",
        paseoHome,
      });
      const originalIncarnation = readPaseoWorktreeIncarnationId(original.worktreePath)!;
      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: original.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: originalIncarnation,
          expectedQuarantineMarker: null,
        }),
      ).resolves.toBeUndefined();

      const quarantined = await createLegacyWorktreeForTest({
        branchName: "legacy-quarantine-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "legacy-quarantine",
        paseoHome,
      });
      const quarantinedIncarnation = readPaseoWorktreeIncarnationId(quarantined.worktreePath)!;
      const quarantinePath = getPaseoWorktreeCleanupQuarantinePath(
        quarantined.worktreePath,
        quarantinedIncarnation,
      );
      renameSync(quarantined.worktreePath, quarantinePath);

      await expect(
        deletePaseoWorktree({
          cwd: repoDir,
          worktreePath: quarantined.worktreePath,
          teardownCwds: [],
          paseoHome,
          expectedWorktreeIncarnationId: quarantinedIncarnation,
          expectedQuarantineMarker: null,
        }),
      ).rejects.toThrow("Cleanup quarantine marker changed");
      expect(existsSync(quarantinePath)).toBe(true);
    });
  });
});
