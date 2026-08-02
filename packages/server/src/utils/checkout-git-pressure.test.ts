import { afterEach, describe, expect, it, vi } from "vitest";

describe("checkout Git pressure propagation", () => {
  afterEach(() => {
    vi.doUnmock("./run-git-command.js");
    vi.resetModules();
  });

  it.each([
    ["checkout snapshot", "getCheckoutSnapshotFacts"],
    ["checkout status", "getCheckoutStatus"],
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
});
