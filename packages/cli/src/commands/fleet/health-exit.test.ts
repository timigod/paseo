import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
vi.mock("../agent/run.js", () => ({
  addRunOptions: (command: unknown) => command,
  prepareAgentRunIntent: vi.fn(),
  runAgentRunIntent: vi.fn(),
  runRunCommand: vi.fn(),
}));
vi.mock("./topology.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topology.js")>()),
  findFleetHost: vi.fn(),
  findFleetHostForCwd: vi.fn(),
  findFleetHostForHostname: vi.fn(),
  loadFleetConfig: mocks.loadFleetConfig,
}));

import { runCli } from "../../run.js";

const originalExitCode = process.exitCode;
const tempDirs: string[] = [];

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function runFleetHealthProcess(args: string[]) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paseo-fleet-health-"));
  tempDirs.push(tempDir);
  const fleetConfigPath = path.join(tempDir, "fleet.json");
  writeFileSync(
    fleetConfigPath,
    `${JSON.stringify({
      version: 1,
      hosts: [
        {
          id: "unreachable",
          name: "Unreachable test host",
          endpoint: "127.0.0.1:1",
          codeRoot: tempDir,
          hostnamePrefixes: ["never-matches"],
          capacity: 1,
        },
      ],
      defaults: { provider: "codex" },
    })}\n`,
  );

  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: { ...process.env, PASEO_FLEET_CONFIG: fleetConfigPath },
    encoding: "utf8",
    timeout: 10_000,
  });
}

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

  it("exits nonzero from the executable human status command", () => {
    const result = runFleetHealthProcess(["fleet", "status"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("degraded");
    expect(result.stdout).toContain("connection failed");
  }, 15_000);

  it("exits nonzero from the executable JSON doctor command", () => {
    const result = runFleetHealthProcess(["fleet", "doctor", "--json"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        state: "degraded",
      }),
    );
  }, 15_000);
});
