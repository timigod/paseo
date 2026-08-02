import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type GitFailureMode = "none" | "diagnostic" | "abort" | "abort-noop" | "restore" | "restore-noop";

function resolveRealGitPath(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "git");
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for an executable Git binary.
    }
  }
  throw new Error("Unable to find Git for checkout pressure tests");
}

const realGitPath = resolveRealGitPath();

function createMergeRepository(conflicting: boolean): string {
  const repoDir = mkdtempSync(join(tmpdir(), "checkout-merge-pressure-"));
  execFileSync(realGitPath, ["init", "-b", "main"], { cwd: repoDir });
  execFileSync(realGitPath, ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync(realGitPath, ["config", "user.name", "Test"], { cwd: repoDir });
  writeFileSync(join(repoDir, "base.txt"), "base\n");
  if (conflicting) {
    writeFileSync(join(repoDir, "conflict.txt"), "base\n");
  }
  execFileSync(realGitPath, ["add", "."], { cwd: repoDir });
  execFileSync(realGitPath, ["commit", "-m", "base"], { cwd: repoDir });
  execFileSync(realGitPath, ["checkout", "-b", "feature"], { cwd: repoDir });
  if (conflicting) {
    writeFileSync(join(repoDir, "conflict.txt"), "feature\n");
    execFileSync(realGitPath, ["commit", "-am", "feature"], { cwd: repoDir });
    execFileSync(realGitPath, ["checkout", "main"], { cwd: repoDir });
    writeFileSync(join(repoDir, "conflict.txt"), "main\n");
    execFileSync(realGitPath, ["commit", "-am", "main"], { cwd: repoDir });
  } else {
    writeFileSync(join(repoDir, "feature.txt"), "feature\n");
    execFileSync(realGitPath, ["add", "feature.txt"], { cwd: repoDir });
    execFileSync(realGitPath, ["commit", "-m", "feature"], { cwd: repoDir });
  }
  execFileSync(realGitPath, ["checkout", "feature"], { cwd: repoDir });
  return repoDir;
}

function installGitFailureWrapper(mode: GitFailureMode): string {
  const binDir = mkdtempSync(join(tmpdir(), "checkout-git-wrapper-"));
  const wrapperPath = join(binDir, "git");
  const quotedGitPath = realGitPath.replaceAll("'", "'\\''");
  writeFileSync(
    wrapperPath,
    `#!/bin/sh
if [ "$PASEO_TEST_GIT_FAILURE" = "diagnostic" ] && [ "$3" = "diff" ] && [ "$4" = "--name-only" ]; then
  echo "diagnostic blocked" >&2
  exit 73
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "abort" ] && [ "$3" = "merge" ] && [ "$4" = "--abort" ]; then
  echo "abort blocked" >&2
  exit 74
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "abort-noop" ] && [ "$3" = "merge" ] && [ "$4" = "--abort" ]; then
  exit 0
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "restore" ] && [ "$3" = "checkout" ] && [ "$4" = "feature" ]; then
  echo "restore blocked" >&2
  exit 75
fi
if [ "$PASEO_TEST_GIT_FAILURE" = "restore-noop" ] && [ "$3" = "checkout" ] && [ "$4" = "feature" ]; then
  exit 0
fi
exec '${quotedGitPath}' "$@"
`,
  );
  chmodSync(wrapperPath, 0o755);
  process.env.PASEO_TEST_GIT_FAILURE = mode;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
  return binDir;
}

function readBranch(repoDir: string): string {
  return execFileSync(realGitPath, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir })
    .toString()
    .trim();
}

function readStatus(repoDir: string): string {
  return execFileSync(realGitPath, ["status", "--porcelain"], { cwd: repoDir }).toString().trim();
}

function hasMergeHead(repoDir: string): boolean {
  try {
    execFileSync(realGitPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}

async function withBoundedMergeRepository(
  options: { conflicting: boolean; failureMode: GitFailureMode },
  run: (repoDir: string) => Promise<void>,
): Promise<void> {
  const previousConcurrency = process.env.PASEO_GIT_CONCURRENCY;
  const previousMaxPending = process.env.PASEO_GIT_MAX_PENDING;
  const previousFailureMode = process.env.PASEO_TEST_GIT_FAILURE;
  const previousPath = process.env.PATH;
  const repoDir = createMergeRepository(options.conflicting);
  let wrapperDir: string | null = null;
  try {
    process.env.PASEO_GIT_CONCURRENCY = "1";
    process.env.PASEO_GIT_MAX_PENDING = "1";
    wrapperDir = installGitFailureWrapper(options.failureMode);
    vi.resetModules();
    await run(repoDir);
  } finally {
    if (previousConcurrency === undefined) delete process.env.PASEO_GIT_CONCURRENCY;
    else process.env.PASEO_GIT_CONCURRENCY = previousConcurrency;
    if (previousMaxPending === undefined) delete process.env.PASEO_GIT_MAX_PENDING;
    else process.env.PASEO_GIT_MAX_PENDING = previousMaxPending;
    if (previousFailureMode === undefined) delete process.env.PASEO_TEST_GIT_FAILURE;
    else process.env.PASEO_TEST_GIT_FAILURE = previousFailureMode;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (wrapperDir) rmSync(wrapperDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    vi.resetModules();
  }
}

describe("checkout Git pressure propagation", () => {
  afterEach(() => {
    vi.doUnmock("./run-git-command.js");
    vi.resetModules();
  });

  it.each([
    ["checkout snapshot", "getCheckoutSnapshotFacts"],
    ["checkout status", "getCheckoutStatus"],
    ["checkout shortstat", "getCheckoutShortstat"],
    ["repository requirement", "getCheckoutDiff"],
    ["current branch", "getCurrentBranch"],
    ["origin remote", "getOriginRemoteUrl"],
  ])("preserves typed backpressure from %s", async (_label, exportName) => {
    vi.resetModules();
    const actual =
      await vi.importActual<typeof import("./run-git-command.js")>("./run-git-command.js");
    const pressure = new actual.GitCommandBackpressureError(8, 64, 8, 64);
    const runGitCommand = vi.fn().mockRejectedValue(pressure);
    vi.doMock("./run-git-command.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./run-git-command.js")>()),
      runGitCommand,
    }));
    const checkoutGit = await import("./checkout-git.js");
    const operation = checkoutGit[exportName as keyof typeof checkoutGit] as (
      cwd: string,
      ...args: unknown[]
    ) => Promise<unknown>;

    await expect(operation(process.cwd(), {})).rejects.toBe(pressure);
  });

  it.each([
    ["comparison ref", "comparison-ref"],
    ["merge base", "merge-base"],
    ["untracked additions", "ls-files"],
  ])("preserves typed backpressure from nested shortstat %s", async (_label, target) => {
    vi.resetModules();
    const actual =
      await vi.importActual<typeof import("./run-git-command.js")>("./run-git-command.js");
    const pressure = new actual.GitCommandBackpressureError(8, 64, 8, 64);
    const runGitCommand = vi.fn(async (args: string[]) => {
      if (target === "comparison-ref" || args[0] === target) {
        throw pressure;
      }
      if (args[0] === "merge-base") {
        return { stdout: "base\n" };
      }
      if (args[0] === "diff") {
        return { stdout: "1 file changed, 1 insertion(+), 1 deletion(-)\n" };
      }
      return { stdout: "" };
    });
    vi.doMock("./run-git-command.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./run-git-command.js")>()),
      runGitCommand,
    }));
    const { getCheckoutShortstat } = await import("./checkout-git.js");
    const cwd = process.cwd();
    const facts = {
      isGit: true as const,
      worktreeRoot: cwd,
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      absoluteGitDir: `${cwd}/.git`,
      gitCommonDir: `${cwd}/.git`,
      paseoWorktree: { isPaseoOwnedWorktree: false as const },
      storedBaseRef: null,
      resolvedBaseRef: "main",
      mainRepoRoot: cwd,
      comparisonBaseRef: target === "comparison-ref" ? null : "main",
      branchRemoteName: "origin",
      branchMergeRef: "refs/heads/feature",
      pullRequestLookupTarget: { headRef: "feature" },
    };

    await expect(getCheckoutShortstat(cwd, { facts }, { force: true })).rejects.toBe(pressure);
  });

  it("rejects when mergeToBase cannot restore the original branch under pressure", async () => {
    vi.resetModules();
    const actual =
      await vi.importActual<typeof import("./run-git-command.js")>("./run-git-command.js");
    const pressure = new actual.GitCommandBackpressureError(8, 64, 8, 64);
    const cwd = process.cwd();
    const runGitCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "checkout" && args[1] === "feature") {
        throw pressure;
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "feature\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: `${cwd}\n` };
      }
      if (args[0] === "worktree") {
        return { stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/feature\n` };
      }
      return { stdout: "" };
    });
    vi.doMock("./run-git-command.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./run-git-command.js")>()),
      runGitCommand,
    }));
    const { mergeToBase } = await import("./checkout-git.js");
    const facts = {
      isGit: true as const,
      worktreeRoot: cwd,
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      absoluteGitDir: `${cwd}/.git`,
      gitCommonDir: `${cwd}/.git`,
      paseoWorktree: { isPaseoOwnedWorktree: false as const },
      storedBaseRef: null,
      resolvedBaseRef: "main",
      mainRepoRoot: cwd,
      comparisonBaseRef: "main",
      branchRemoteName: "origin",
      branchMergeRef: "refs/heads/feature",
      pullRequestLookupTarget: { headRef: "feature" },
    };

    await expect(mergeToBase(cwd, {}, { facts })).rejects.toBe(pressure);
    expect(runGitCommand).toHaveBeenCalledWith(
      ["checkout", "feature"],
      expect.objectContaining({ cwd }),
    );
  });

  it("attempts abort and restoration when conflict diagnostics receive backpressure", async () => {
    vi.resetModules();
    const actual =
      await vi.importActual<typeof import("./run-git-command.js")>("./run-git-command.js");
    const pressure = new actual.GitCommandBackpressureError(1, 1, 1, 1);
    const cwd = process.cwd();
    const runGitCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "merge" && args[1] === "feature") {
        throw new Error("CONFLICT: Automatic merge failed");
      }
      if (args[0] === "diff") {
        throw pressure;
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { stdout: "feature\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: `${cwd}\n` };
      }
      if (args[0] === "worktree") {
        return { stdout: `worktree ${cwd}\nHEAD abc\nbranch refs/heads/feature\n` };
      }
      if (args[0] === "status") {
        return { stdout: "UU conflict.txt\n" };
      }
      return { stdout: "" };
    });
    vi.doMock("./run-git-command.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./run-git-command.js")>()),
      runGitCommand,
    }));
    const { mergeToBase, MergeConflictError } = await import("./checkout-git.js");
    const facts = {
      isGit: true as const,
      worktreeRoot: cwd,
      currentBranch: "feature",
      remoteUrl: "https://github.com/acme/repo.git",
      absoluteGitDir: `${cwd}/.git`,
      gitCommonDir: `${cwd}/.git`,
      paseoWorktree: { isPaseoOwnedWorktree: false as const },
      storedBaseRef: null,
      resolvedBaseRef: "main",
      mainRepoRoot: cwd,
      comparisonBaseRef: "main",
      branchRemoteName: "origin",
      branchMergeRef: "refs/heads/feature",
      pullRequestLookupTarget: { headRef: "feature" },
    };

    const failure = await mergeToBase(cwd, {}, { facts }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MergeConflictError);
    if (!(failure instanceof MergeConflictError)) throw failure;
    expect(failure.relatedErrors).toContain(pressure);
    expect(runGitCommand).toHaveBeenCalledWith(
      ["merge", "--abort"],
      expect.objectContaining({ cwd }),
    );
    expect(runGitCommand).toHaveBeenCalledWith(
      ["checkout", "feature"],
      expect.objectContaining({ cwd }),
    );
    const commands = runGitCommand.mock.calls.map(([args]) => args.join(" "));
    expect(commands.slice(commands.indexOf("merge feature"))).toEqual([
      "merge feature",
      "diff --name-only --diff-filter=U",
      "ls-files -u",
      "status --porcelain",
      "merge --abort",
      "rev-parse -q --verify MERGE_HEAD",
      "ls-files -u",
      "checkout feature",
      "rev-parse --abbrev-ref HEAD",
    ]);
  });

  it.each(["symbolic-ref", "show-ref"])(
    "preserves typed backpressure from default branch %s fallback",
    async (target) => {
      vi.resetModules();
      const actual =
        await vi.importActual<typeof import("./run-git-command.js")>("./run-git-command.js");
      const pressure = new actual.GitCommandBackpressureError(8, 64, 8, 64);
      const runGitCommand = vi.fn(async (args: string[]) => {
        if (args[0] === target) {
          throw pressure;
        }
        if (args[0] === "symbolic-ref") {
          return { stdout: "refs/remotes/origin/main\n" };
        }
        return { stdout: "main\n" };
      });
      vi.doMock("./run-git-command.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("./run-git-command.js")>()),
        runGitCommand,
      }));
      const { resolveRepositoryDefaultBranch } = await import("./checkout-git.js");

      await expect(resolveRepositoryDefaultBranch(process.cwd())).rejects.toBe(pressure);
    },
  );

  it("aborts and restores the branch after conflict diagnostics use a tightly bounded executor", async () => {
    const previousConcurrency = process.env.PASEO_GIT_CONCURRENCY;
    const previousMaxPending = process.env.PASEO_GIT_MAX_PENDING;
    const repoDir = mkdtempSync(join(tmpdir(), "checkout-merge-pressure-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "conflict.txt"), "base\n");
      execFileSync("git", ["add", "conflict.txt"], { cwd: repoDir });
      execFileSync("git", ["commit", "-m", "base"], { cwd: repoDir });
      execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoDir });
      writeFileSync(join(repoDir, "conflict.txt"), "feature\n");
      execFileSync("git", ["commit", "-am", "feature"], { cwd: repoDir });
      execFileSync("git", ["checkout", "main"], { cwd: repoDir });
      writeFileSync(join(repoDir, "conflict.txt"), "main\n");
      execFileSync("git", ["commit", "-am", "main"], { cwd: repoDir });
      execFileSync("git", ["checkout", "feature"], { cwd: repoDir });

      process.env.PASEO_GIT_CONCURRENCY = "1";
      process.env.PASEO_GIT_MAX_PENDING = "1";
      vi.resetModules();
      const { mergeToBase, MergeConflictError } = await import("./checkout-git.js");

      await expect(mergeToBase(repoDir, { baseRef: "main" })).rejects.toBeInstanceOf(
        MergeConflictError,
      );
      expect(
        execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir })
          .toString()
          .trim(),
      ).toBe("feature");
      expect(
        execFileSync("git", ["status", "--porcelain"], { cwd: repoDir }).toString().trim(),
      ).toBe("");
      expect(() =>
        execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: repoDir }),
      ).toThrow();
    } finally {
      if (previousConcurrency === undefined) {
        delete process.env.PASEO_GIT_CONCURRENCY;
      } else {
        process.env.PASEO_GIT_CONCURRENCY = previousConcurrency;
      }
      if (previousMaxPending === undefined) {
        delete process.env.PASEO_GIT_MAX_PENDING;
      } else {
        process.env.PASEO_GIT_MAX_PENDING = previousMaxPending;
      }
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("aborts and restores after a bounded conflict diagnostic fails", async () => {
    await withBoundedMergeRepository(
      { conflicting: true, failureMode: "diagnostic" },
      async (repoDir) => {
        const { mergeToBase, MergeConflictError } = await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeConflictError);
        if (!(failure instanceof MergeConflictError)) throw failure;
        expect(failure.relatedErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("diagnostic blocked") }),
        ]);
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toBe("");
      },
    );
  });

  it("surfaces an aggregated cleanup failure when abort fails", async () => {
    await withBoundedMergeRepository(
      { conflicting: true, failureMode: "abort" },
      async (repoDir) => {
        const { mergeToBase, MergeCleanupError, MergeConflictError } =
          await import("./checkout-git.js");
        const { toCheckoutError } = await import("../server/checkout-git-utils.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        expect(failure).not.toBeInstanceOf(MergeConflictError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("abort blocked") }),
          expect.objectContaining({ message: expect.stringContaining("MERGE_HEAD still exists") }),
          expect.objectContaining({ message: expect.stringContaining("unmerged index entries") }),
          expect.objectContaining({ message: expect.stringContaining("checkout feature") }),
        ]);
        expect(toCheckoutError(failure)).toEqual({
          code: "UNKNOWN",
          message: expect.stringContaining("checkout may require manual recovery"),
        });
        expect(readBranch(repoDir)).toBe("main");
        expect(readStatus(repoDir)).toContain("UU conflict.txt");
      },
    );
  });

  it("surfaces merge-from-base abort failure instead of a recoverable conflict", async () => {
    await withBoundedMergeRepository(
      { conflicting: true, failureMode: "abort" },
      async (repoDir) => {
        const { mergeFromBase, MergeCleanupError, MergeFromBaseConflictError } =
          await import("./checkout-git.js");

        const failure = await captureFailure(mergeFromBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        expect(failure).not.toBeInstanceOf(MergeFromBaseConflictError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("abort blocked") }),
          expect.objectContaining({ message: expect.stringContaining("MERGE_HEAD still exists") }),
          expect.objectContaining({ message: expect.stringContaining("unmerged index entries") }),
        ]);
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toContain("UU conflict.txt");
      },
    );
  });

  it("cleans a squash conflict without relying on MERGE_HEAD", async () => {
    await withBoundedMergeRepository(
      { conflicting: true, failureMode: "none" },
      async (repoDir) => {
        const { mergeToBase, MergeConflictError } = await import("./checkout-git.js");

        const failure = await captureFailure(
          mergeToBase(repoDir, { baseRef: "main", mode: "squash" }),
        );

        expect(failure).toBeInstanceOf(MergeConflictError);
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toBe("");
        expect(hasMergeHead(repoDir)).toBe(false);
      },
    );
  });

  it("does not discard staged work when squash cleanup would require a reset", async () => {
    await withBoundedMergeRepository(
      { conflicting: true, failureMode: "none" },
      async (repoDir) => {
        writeFileSync(join(repoDir, "staged.txt"), "staged\n");
        execFileSync(realGitPath, ["add", "staged.txt"], { cwd: repoDir });
        const { mergeToBase } = await import("./checkout-git.js");

        await expect(mergeToBase(repoDir, { baseRef: "main", mode: "squash" })).rejects.toThrow(
          "Working directory has uncommitted changes.",
        );
        expect(readBranch(repoDir)).toBe("feature");
        expect(readStatus(repoDir)).toBe("A  staged.txt");
      },
    );
  });

  it("rejects a successful abort that leaves merge state behind", async () => {
    await withBoundedMergeRepository(
      { conflicting: true, failureMode: "abort-noop" },
      async (repoDir) => {
        const { mergeToBase, MergeCleanupError, MergeConflictError } =
          await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        expect(failure).not.toBeInstanceOf(MergeConflictError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("MERGE_HEAD still exists") }),
          expect.objectContaining({ message: expect.stringContaining("unmerged index entries") }),
          expect.objectContaining({ message: expect.stringContaining("checkout feature") }),
        ]);
        expect(readBranch(repoDir)).toBe("main");
        expect(readStatus(repoDir)).toContain("UU conflict.txt");
      },
    );
  });

  it("rejects a bounded successful merge when branch restoration fails", async () => {
    await withBoundedMergeRepository(
      { conflicting: false, failureMode: "restore" },
      async (repoDir) => {
        const { mergeToBase, MergeCleanupError } = await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("restore blocked") }),
        ]);
        expect(readBranch(repoDir)).toBe("main");
      },
    );
  });

  it("surfaces branch restoration failure instead of a recoverable conflict", async () => {
    await withBoundedMergeRepository(
      { conflicting: true, failureMode: "restore" },
      async (repoDir) => {
        const { mergeToBase, MergeCleanupError, MergeConflictError } =
          await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        expect(failure).not.toBeInstanceOf(MergeConflictError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({ message: expect.stringContaining("restore blocked") }),
        ]);
        expect(readBranch(repoDir)).toBe("main");
        expect(readStatus(repoDir)).toBe("");
      },
    );
  });

  it("rejects a bounded merge when restoration leaves the checkout on the base branch", async () => {
    await withBoundedMergeRepository(
      { conflicting: false, failureMode: "restore-noop" },
      async (repoDir) => {
        const { mergeToBase, MergeCleanupError } = await import("./checkout-git.js");

        const failure = await captureFailure(mergeToBase(repoDir, { baseRef: "main" }));

        expect(failure).toBeInstanceOf(MergeCleanupError);
        if (!(failure instanceof MergeCleanupError)) throw failure;
        expect(failure.cleanupErrors).toEqual([
          expect.objectContaining({
            message: expect.stringContaining("expected feature, found main"),
          }),
        ]);
        expect(readBranch(repoDir)).toBe("main");
      },
    );
  });
});
