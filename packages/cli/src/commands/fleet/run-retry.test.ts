import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collectFleetStatus: vi.fn(),
  getOrCreateCliClientId: vi.fn().mockResolvedValue("caller-1"),
  prepareAgentRunIntent: vi.fn(),
  runAgentRunIntent: vi.fn(),
  resolveFleetRunPrompt: vi.fn(),
  resolveFleetProviderModelOptions: vi.fn(),
  resolveFleetWorktreeBase: vi.fn(),
}));

vi.mock("../../utils/client-id.js", () => ({
  getOrCreateCliClientId: mocks.getOrCreateCliClientId,
}));
vi.mock("../agent/run.js", () => ({
  addRunOptions: (command: unknown) => command,
  prepareAgentRunIntent: mocks.prepareAgentRunIntent,
  runAgentRunIntent: mocks.runAgentRunIntent,
  runRunCommand: vi.fn(),
}));
vi.mock("./status.js", () => ({
  collectFleetStatus: mocks.collectFleetStatus,
  summarizeFleetHostStatus: vi.fn(),
  buildFleetDoctorResult: vi.fn(),
}));
vi.mock("./run.js", () => ({
  resolveFleetRunPrompt: mocks.resolveFleetRunPrompt,
  resolveFleetProviderModelOptions: mocks.resolveFleetProviderModelOptions,
  resolveFleetWorktreeBase: mocks.resolveFleetWorktreeBase,
}));

import { runFleetRunCommand } from "./index.js";

const directories: string[] = [];
const originalFleetConfig = process.env.PASEO_FLEET_CONFIG;

afterEach(async () => {
  vi.clearAllMocks();
  if (originalFleetConfig === undefined) {
    delete process.env.PASEO_FLEET_CONFIG;
  } else {
    process.env.PASEO_FLEET_CONFIG = originalFleetConfig;
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function writeFleetConfig(filePath: string, endpoint: string, model: string): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      hosts: [
        {
          id: "builder-a",
          name: "Builder A",
          endpoint,
          codeRoot: "/srv/code",
          hostnamePrefixes: ["builder-a"],
          capacity: 8,
        },
      ],
      defaults: { provider: "codex", model, thinking: "high" },
    }),
  );
}

function readyFleetStatuses(config: { hosts: unknown[] }) {
  return config.hosts.map((host) => ({
    host,
    reachable: true,
    providerReady: true,
    agentInventoryReady: true,
    workspaceInventoryReady: true,
    activeAgents: 0,
    workspaceIds: [],
  }));
}

describe("fleet run retry affinity", () => {
  it("accepts the original endpoint selector after drift and preserves the resolved intent", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-fleet-run-retry-"));
    directories.push(directory);
    const configPath = path.join(directory, "fleet.json");
    process.env.PASEO_FLEET_CONFIG = configPath;
    await writeFleetConfig(configPath, "builder-a.internal:6767", "gpt-original");
    mocks.collectFleetStatus.mockImplementation(readyFleetStatuses);
    mocks.resolveFleetRunPrompt.mockResolvedValue("original prompt");
    mocks.resolveFleetProviderModelOptions.mockReturnValue({
      provider: "codex",
      model: "gpt-original",
      effectiveProvider: "codex",
      effectiveModel: "gpt-original",
    });
    mocks.resolveFleetWorktreeBase.mockReturnValue("a".repeat(40));
    const intent = {
      create: {
        type: "create_agent_request" as const,
        config: {
          provider: "codex" as const,
          cwd: "/srv/code/project",
          model: "gpt-original",
          thinkingOptionId: "high",
        },
        initialPrompt: "original prompt",
        idempotencyKey: "create-1",
        workspaceSource: {
          kind: "worktree" as const,
          cwd: "/srv/code/project",
          baseBranch: "a".repeat(40),
        },
        labels: {},
      },
      prompt: "original prompt",
      waitTimeoutMs: 0,
      background: true,
    };
    mocks.prepareAgentRunIntent.mockResolvedValue({ intent, daemonId: "daemon-a" });
    mocks.runAgentRunIntent.mockResolvedValue({
      type: "single",
      data: {
        agentId: "agent-1",
        status: "running",
        provider: "codex",
        cwd: "/srv/code/project",
        title: null,
      },
      schema: { idField: "agentId", columns: [] },
    });
    const runOptions = {
      idempotencyKey: "create-1",
      background: true,
      cwd: "/srv/code/project",
      newWorkspace: "worktree" as const,
      host: "builder-a.internal:6767",
    };

    await runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]);
    await writeFleetConfig(configPath, "builder-a.internal:7777", "gpt-new-default");
    mocks.resolveFleetRunPrompt.mockResolvedValue("changed prompt");
    mocks.resolveFleetProviderModelOptions.mockReturnValue({
      provider: "codex",
      model: "gpt-new-default",
      effectiveProvider: "codex",
      effectiveModel: "gpt-new-default",
    });
    mocks.resolveFleetWorktreeBase.mockReturnValue("b".repeat(40));

    await runFleetRunCommand(undefined, runOptions, {} as Parameters<typeof runFleetRunCommand>[2]);

    expect(mocks.resolveFleetRunPrompt).toHaveBeenCalledOnce();
    expect(mocks.resolveFleetProviderModelOptions).toHaveBeenCalledOnce();
    expect(mocks.resolveFleetWorktreeBase).toHaveBeenCalledOnce();
    expect(mocks.prepareAgentRunIntent).toHaveBeenCalledOnce();
    const { idempotencyKey: _idempotencyKey, ...persistedCreate } = intent.create;
    expect(mocks.runAgentRunIntent).toHaveBeenLastCalledWith({
      intent: {
        ...intent,
        create: persistedCreate,
      },
      host: "builder-a.internal:7777",
      expectedDaemonId: "daemon-a",
      idempotencyKey: "create-1",
    });
  });
});
