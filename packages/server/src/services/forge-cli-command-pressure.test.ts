import { afterEach, describe, expect, it, vi } from "vitest";

describe("defaultResolveRemoteUrl pressure propagation", () => {
  afterEach(() => {
    vi.doUnmock("../utils/run-git-command.js");
    vi.resetModules();
  });

  it("preserves typed backpressure instead of reporting a missing remote", async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("../utils/run-git-command.js")>(
      "../utils/run-git-command.js",
    );
    const pressure = new actual.GitCommandBackpressureError(8, 64, 8, 64);
    const runGitCommand = vi.fn().mockRejectedValue(pressure);
    vi.doMock("../utils/run-git-command.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../utils/run-git-command.js")>()),
      runGitCommand,
    }));
    const { defaultResolveRemoteUrl } = await import("./forge-cli-command.js");

    await expect(defaultResolveRemoteUrl(process.cwd())).rejects.toBe(pressure);
  });
});
