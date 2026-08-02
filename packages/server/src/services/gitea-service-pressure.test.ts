import { afterEach, describe, expect, it, vi } from "vitest";

describe("Gitea Git pressure propagation", () => {
  afterEach(() => {
    vi.doUnmock("../utils/run-git-command.js");
    vi.resetModules();
  });

  it("preserves typed backpressure while resolving the current branch", async () => {
    const actual = await vi.importActual<typeof import("../utils/run-git-command.js")>(
      "../utils/run-git-command.js",
    );
    const pressure = new actual.GitCommandBackpressureError(8, 64, 8, 64);
    vi.doMock("../utils/run-git-command.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../utils/run-git-command.js")>()),
      runGitCommand: vi.fn().mockRejectedValue(pressure),
    }));
    const { createGiteaService } = await import("./gitea-service.js");
    const service = createGiteaService({
      resolveTeaPath: async () => "/usr/bin/tea",
      runner: vi.fn(async () => {
        throw new Error("tea must not run when branch resolution is under pressure");
      }),
    });

    await expect(
      service.getCheckDetails({
        cwd: process.cwd(),
        repoOwner: "acme",
        repoName: "repo",
        checkRunId: 1,
      }),
    ).rejects.toBe(pressure);
  });
});
