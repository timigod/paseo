import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectFleetStatus: vi.fn(),
  loadFleetConfig: vi.fn(() => ({ hosts: [], defaults: { provider: "codex" } })),
}));

vi.mock("./status.js", () => ({
  collectFleetStatus: mocks.collectFleetStatus,
  summarizeFleetHostStatus: (status: unknown) => status,
  buildFleetDoctorResult: (hosts: Array<{ state: string }>) => {
    let state = "ready";
    if (hosts.some((host) => host.state === "needs_permission")) {
      state = "needs_permission";
    } else if (hosts.some((host) => host.state === "degraded")) {
      state = "degraded";
    }
    return { state, hosts, recommendation: "Diagnostic result" };
  },
}));
vi.mock("./topology.js", () => ({
  findFleetHost: vi.fn(),
  findFleetHostForCwd: vi.fn(),
  findFleetHostForHostname: vi.fn(),
  loadFleetConfig: mocks.loadFleetConfig,
}));

import { runCli } from "../../run.js";

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("fleet health exit status", () => {
  it("renders degraded status diagnostics and returns a failing exit code", async () => {
    mocks.collectFleetStatus.mockResolvedValue([
      {
        host: "builder-a",
        state: "degraded",
        reachable: false,
        providerReady: false,
        agentInventoryReady: false,
        workspaceInventoryReady: false,
        activeAgents: 0,
        pendingPermissions: 0,
        issue: "connection failed",
      },
    ]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.exitCode = undefined;

    await expect(runCli(["fleet", "status", "--json"])).resolves.toBe(1);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"state": "degraded"'));
  });

  it("renders permission diagnostics and returns a failing doctor exit code", async () => {
    mocks.collectFleetStatus.mockResolvedValue([{ state: "needs_permission" }]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.exitCode = undefined;

    await expect(runCli(["fleet", "doctor", "--json"])).resolves.toBe(1);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"state": "needs_permission"'));
  });
});
