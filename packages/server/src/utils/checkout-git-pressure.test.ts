import { afterEach, describe, expect, it, vi } from "vitest";

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
});
